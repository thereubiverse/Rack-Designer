"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { createSessionClient } from "@/lib/supabase/auth";
import { withMember } from "@/features/auth/withMember";
import { cleanProfileFields, checkAvatar, checkNewPassword } from "./profileRules";
import { readProfile, writeProfile, writeAvatarPath } from "./repository";
import { avatarPathFor, uploadAvatarObject, removeAvatarObject } from "./avatarStorage";
import {
  readPendingVerification, bumpVerificationAttempts,
  clearPendingVerification, markPhoneVerified, clearPhoneVerified, claimPhoneVerification,
} from "./repository";
import { smsConfigured, sendSms, SmsError } from "./sms";
import {
  toE164, sameNumber, generateCode, cooldownRemainingMs, pendingState,
  CODE_TTL_MS, RESEND_COOLDOWN_MS,
} from "./phoneRules";

/** Every action here writes to `member.id`, which withMember resolved from the session cookie.
 *  NOTHING reads an id from the form. An action that trusted a form-supplied id would let anyone
 *  overwrite anyone else's profile — including their name and picture — from a crafted request. */

export const updateProfileAction = withMember("profile.update", async (member, formData: FormData) => {
  const fields = cleanProfileFields({
    name: formData.get("name"),
    phone: formData.get("phone"),
    position: formData.get("position"),
    address: formData.get("address"),
  });
  const db = createServiceClient();

  // Read BEFORE writing: this is the only chance to see whether the number is actually changing.
  // Reading after writeProfile would already show the new value, and the comparison below would
  // always conclude nothing changed — leaving a verified badge on a number nobody proved.
  const before = await readProfile(db, member.id);
  await writeProfile(db, member.id, fields);

  // A number that changed has not been confirmed. Compared on the normalised form, so merely
  // reformatting the same number does not cost the member their verification.
  if (before && !sameNumber(before.phone, fields.phone)) {
    await clearPhoneVerified(db, member.id);
    await clearPendingVerification(db, member.id);
  }

  revalidatePath("/profile");
  // The sidebar shows the name on every page, so it is stale everywhere until the layout re-renders.
  revalidatePath("/", "layout");
  return { ok: true as const };
});

export const uploadAvatarAction = withMember("profile.avatar.upload", async (member, formData: FormData) => {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose an image file." };

  const problem = checkAvatar({ size: file.size, type: file.type });
  if (problem) return { ok: false, error: problem };

  const db = createServiceClient();
  const path = avatarPathFor(member.orgId, member.id);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Object first, then the row. The reverse order can leave a row pointing at a file that was
  // never written, which renders as a broken picture with no way to retry except re-uploading.
  await uploadAvatarObject(db, path, bytes, file.type);
  await writeAvatarPath(db, member.id, path);
  revalidatePath("/profile");
  revalidatePath("/", "layout");
  return { ok: true as const };
});

export const removeAvatarAction = withMember("profile.avatar.remove", async (member, _formData: FormData) => {
  const db = createServiceClient();
  const profile = await readProfile(db, member.id);
  // No picture is not an error — the button simply had nothing to do.
  if (profile?.avatarPath) {
    // Object first again: if removal fails, the row still names the file and the action can be
    // retried. Clearing the column first would strand the object with nothing naming it.
    await removeAvatarObject(db, profile.avatarPath);
    await writeAvatarPath(db, member.id, null);
  }
  revalidatePath("/profile");
  revalidatePath("/", "layout");
  return { ok: true as const };
});

export const changePasswordAction = withMember("password.change", async (member, formData: FormData) => {
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  const problem = checkNewPassword(current, next, confirm);
  if (problem) return { ok: false, error: problem };

  // Supabase's updateUser does not ask for the existing password. Prove it here first, or an
  // unlocked laptop is enough to lock the real owner out of their own account.
  const auth = await createSessionClient();
  const { error: reauth } = await auth.auth.signInWithPassword({
    email: member.email,
    password: current,
  });
  // Specific on purpose. The generic NOT_A_MEMBER copy exists so an outsider cannot learn which
  // addresses are real; this person is already signed in and looking at their own settings, so a
  // vaguer message would only be unhelpful.
  if (reauth) return { ok: false, error: "That current password isn't right." };

  const { error } = await auth.auth.updateUser({ password: next });
  if (error) return { ok: false, error: "Couldn't change your password. Try again." };
  return { ok: true as const };
});

export const sendPhoneCodeAction = withMember("phone.sendCode", async (member) => {
  if (!smsConfigured()) {
    return { ok: false, error: "Text confirmation isn't set up yet. Ask an administrator." };
  }
  const db = createServiceClient();
  const profile = await readProfile(db, member.id);
  if (!profile?.phone) return { ok: false, error: "Add a phone number first." };

  // Nothing to prove on a number that's already verified, and every send costs money. The UI
  // hides the Verify button once verified, but this is a plain POST action — the check has to live
  // here too, not just in what the button shows.
  if (profile.phoneVerifiedAt) {
    return { ok: false, error: "This number is already verified." };
  }

  const e164 = toE164(profile.phone);
  // Never guess a country code: texting a stranger is the failure this feature exists to prevent.
  if (!e164) return { ok: false, error: "Include the area code so we can text this number." };

  const code = generateCode();
  // claim_phone_verification is the atomic version of "read pending, check cooldown, write pending".
  // The old read-then-write let concurrent requests all see no pending row and all send a text;
  // the claim serialises on the primary key so exactly one caller wins and sends. Losing the claim
  // IS the cooldown refusal — there is nothing more to check afterward.
  const claimed = await claimPhoneVerification(
    db, member.id, e164, code,
    Math.floor(CODE_TTL_MS / 1000), Math.floor(RESEND_COOLDOWN_MS / 1000)
  );
  if (!claimed) {
    // Read only to word the wait message — the claim already made the decision.
    const pending = await readPendingVerification(db, member.id);
    const waitMs = pending
      ? cooldownRemainingMs(Date.parse(pending.createdAt), Date.now())
      : RESEND_COOLDOWN_MS;
    const secs = Math.max(1, Math.ceil(waitMs / 1000));
    return { ok: false, error: `Wait ${secs} more second${secs === 1 ? "" : "s"} before asking for another code.` };
  }

  try {
    await sendSms(e164, `Your confirmation code is ${code}`);
  } catch (e) {
    console.error("sendPhoneCodeAction: could not send", e);
    // Only remove the pending row when Twilio definitively rejected the message before sending it
    // (a 4xx — never sent, never billed). On an ambiguous failure — a 5xx, a network error, a
    // timeout — Twilio may well have accepted and billed it anyway, so the row (and the cooldown
    // it drives) must survive: deleting it here would let every retry re-bill exactly when the
    // guard matters most.
    const definitelyNotSent = e instanceof SmsError && e.definitelyNotSent;
    if (definitelyNotSent) {
      await clearPendingVerification(db, member.id);
      return { ok: false, error: "Couldn't send that text. Try again." };
    }
    return {
      ok: false,
      error: "We couldn't confirm that text was sent. Wait before trying again.",
    };
  }
  return { ok: true as const };
});

export const confirmPhoneCodeAction = withMember("phone.confirm", async (member, formData: FormData) => {
  const entered = String(formData.get("code") ?? "").trim();
  const db = createServiceClient();

  const pending = await readPendingVerification(db, member.id);
  if (!pending) return { ok: false, error: "Ask for a code first." };

  const state = pendingState(
    { expiresAtMs: Date.parse(pending.expiresAt), attempts: pending.attempts },
    Date.now()
  );
  if (state === "expired") {
    await clearPendingVerification(db, member.id);
    return { ok: false, error: "That code has expired. Ask for a new one." };
  }
  if (state === "spent") {
    return { ok: false, error: "Too many attempts. Ask for a new code." };
  }

  // The code proves control of the number it was SENT to. If the profile now holds a different
  // number, confirming would mark an unrelated number verified.
  const profile = await readProfile(db, member.id);
  if (!profile || !sameNumber(profile.phone, pending.phone)) {
    await clearPendingVerification(db, member.id);
    return { ok: false, error: "That number changed since the code was sent. Ask for a new one." };
  }

  if (entered !== pending.code) {
    await bumpVerificationAttempts(db, member.id, pending.attempts + 1);
    return { ok: false, error: "That code isn't right." };
  }

  // The read-check above and this write are not atomic: a save can land in between, changing the
  // number after the check passed. Making the WRITE conditional on the phone still matching closes
  // that race — if it returns false, some other write beat us here and nothing was marked verified.
  //
  // `profile.phone` (not `pending.phone`) is the expected value: `members.phone` holds what the
  // member TYPED ("(718) 555-0142"), while `pending.phone` holds the E.164 form the code was sent
  // to ("+17185550142") — comparing against pending.phone would never match the column and this
  // update would always report false.
  const verified = await markPhoneVerified(db, member.id, new Date().toISOString(), profile.phone);
  await clearPendingVerification(db, member.id);
  if (!verified) {
    return { ok: false, error: "That number changed while the code was being confirmed. Ask for a new one." };
  }
  revalidatePath("/profile");
  return { ok: true as const };
});
