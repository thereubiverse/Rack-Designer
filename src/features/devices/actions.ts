"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { withMember, withAdmin } from "@/features/auth/withMember";
import type { Member } from "@/features/auth/members";
import { emailConfigured, sendEmail } from "@/lib/email";
import {
  DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE_S, CODE_TTL_MS, MAX_PENDING_DEVICES,
  generateDeviceToken, hashDeviceToken, generateCode, deviceLabel,
  cooldownRemainingMs,
} from "./deviceRules";
import {
  findDeviceByHash, findDeviceInOrg, insertPendingDevice, approveDevice, listDevicesForMember,
  deleteDevice, writeChallenge, clearChallenge, consumeDeviceAttempt,
  countPendingDevicesForMember, mostRecentChallengeForMember,
  type TrustedDevice,
} from "./repository";

/** ONE refusal message everywhere a device cannot be resolved from the caller's own cookie — no
 *  detail about WHY (no cookie vs. unknown hash vs. somebody else's device), for the same reason
 *  NOT_A_MEMBER is uniform: distinguishing the cases would tell a prober which devices/ids exist. */
const NO_DEVICE = "No device to approve. Ask for a new code.";

const COOKIE_OPTS = {
  httpOnly: true as const,
  secure: true as const,
  sameSite: "lax" as const,
  maxAge: DEVICE_COOKIE_MAX_AGE_S,
  path: "/" as const,
};

/** Resolves a device the caller actually holds: from the SESSION COOKIE, never from an id read out
 *  of a form. This is the load-bearing check for the whole feature — a device id typed or guessed
 *  by an attacker resolves to nothing here, because nothing here ever looks at one. Also refuses a
 *  cookie that happens to hash to another member's device (a stale cookie, a shared machine) rather
 *  than silently acting on it. */
async function deviceFromCookie(db: SupabaseClient, memberId: string): Promise<TrustedDevice | null> {
  const jar = await cookies();
  const token = jar.get(DEVICE_COOKIE)?.value;
  if (!token) return null;
  const device = await findDeviceByHash(db, hashDeviceToken(token));
  if (!device || device.memberId !== memberId) return null;
  return device;
}

/** Sends (or resends) a challenge code for a device already confirmed to belong to `member`.
 *  Refuses inside the resend cooldown; otherwise overwrites any code in flight (writeChallenge is an
 *  upsert on the device's primary key, so this also resets attempts to 0). Shared by
 *  `startDeviceApprovalAction`, which may have just created the device, and `resendDeviceCodeAction`,
 *  which never does. */
async function issueChallenge(db: SupabaseClient, member: Member, device: TrustedDevice) {
  if (!emailConfigured()) {
    return { ok: false, error: "Email confirmation isn't set up yet. Ask an administrator." };
  }

  // Rate-limited per MEMBER, not per device. Keying this on device.id (the old shape) meant a
  // brand-new device — which by definition has no challenge of its own yet — sailed through the
  // cooldown for free: a script that never returns the Set-Cookie could mint one fresh device per
  // request and get an immediate email for every single one. Looking at the member's most recent
  // challenge across ALL their devices closes that regardless of which device asks.
  const mostRecent = await mostRecentChallengeForMember(db, member.id);
  if (mostRecent) {
    const remaining = cooldownRemainingMs(Date.parse(mostRecent.createdAt), Date.now());
    if (remaining > 0) {
      const secs = Math.max(1, Math.ceil(remaining / 1000));
      return { ok: false, error: `Wait ${secs} more second${secs === 1 ? "" : "s"} before asking for another code.` };
    }
  }

  const code = generateCode();
  const expiresAtIso = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await writeChallenge(db, device.id, code, expiresAtIso);
  await sendEmail(member.email, "Approve this device", `Your device approval code is ${code}.`);
  return { ok: true };
}

export const startDeviceApprovalAction = withMember("device.challenge", async (member) => {
  const db = createServiceClient();
  const jar = await cookies();
  const existingToken = jar.get(DEVICE_COOKIE)?.value;

  let device: TrustedDevice | null = null;
  if (existingToken) {
    const found = await findDeviceByHash(db, hashDeviceToken(existingToken));
    // A cookie resolving to somebody ELSE's device must not silently attach a fresh challenge to
    // that other member's row — fall through and issue this member their own, new device instead.
    if (found && found.memberId === member.id) device = found;
  }

  if (!device) {
    // Cap pending devices per member BEFORE creating one. A caller that never returns the
    // Set-Cookie (a script, not a browser) otherwise looks like a brand-new device on every
    // request: unlimited rows, unlimited emails to the member, and each row an independent
    // five-guess budget. Refuse plainly once MAX_PENDING_DEVICES is reached, and do so before
    // either the insert or the email below — neither must happen once this refuses.
    const pending = await countPendingDevicesForMember(db, member.id);
    if (pending >= MAX_PENDING_DEVICES) {
      return { ok: false, error: "Too many devices are waiting for approval. Approve or remove one first, or ask an administrator." };
    }

    const token = generateDeviceToken();
    const hdrs = await headers();
    const label = deviceLabel(hdrs.get("user-agent"));
    device = await insertPendingDevice(db, member.id, hashDeviceToken(token), label);
    // Set the cookie ONLY when a device was actually created here. Reusing an existing, still-valid
    // cookie must not reset its year-long expiry or rewrite an unrelated Set-Cookie header on every
    // retry — that would make "ask again" a way to keep a device alive forever by accident.
    jar.set(DEVICE_COOKIE, token, COOKIE_OPTS);
  }

  return issueChallenge(db, member, device);
});

export const resendDeviceCodeAction = withMember("device.challenge", async (member) => {
  const db = createServiceClient();
  const device = await deviceFromCookie(db, member.id);
  if (!device) return { ok: false, error: NO_DEVICE };
  return issueChallenge(db, member, device);
});

export const confirmDeviceAction = withMember("device.approve", async (member, formData: FormData) => {
  const entered = String(formData.get("code") ?? "").trim();
  const db = createServiceClient();

  // Rule 1: the device comes from the cookie, and only from the cookie. deviceFromCookie already
  // refuses a device that does not belong to `member` — nothing below ever sees one that isn't
  // both the caller's cookie AND the caller's own row.
  const device = await deviceFromCookie(db, member.id);
  if (!device) return { ok: false, error: NO_DEVICE };

  // Rule 6 (Critical fix, migration 0031): check-and-increment is ONE atomic statement in Postgres,
  // and the decision is made from what THAT statement returns — never from a prior read. The old
  // shape read the challenge, decided "spent or not" in JavaScript, and then wrote an absolute
  // attempts value computed from that read; a thousand concurrent callers all read attempts = 0 and
  // all collapsed into a single write of attempts = 1, so a thousand guesses cost one attempt. There
  // is no separate read here for the same reason: adding one back would recreate the exact race this
  // closes, even if nothing else about this function looked different.
  const consumed = await consumeDeviceAttempt(db, device.id);
  if (!consumed) {
    // No row means the WHERE clause in consume_device_attempt did not match: attempts already at
    // MAX_ATTEMPTS, the challenge expired, or none exists for this device. All three land the caller
    // in the same place (ask for a fresh code), so refuse uniformly — a second read to tell them
    // apart would itself be the race being closed here.
    return { ok: false, error: "That code has expired or too many attempts have been made. Ask for a new one." };
  }

  if (entered !== consumed.code) {
    // This attempt was ALREADY counted by consume_device_attempt above — a wrong code here still
    // spends one of the five, exactly as it must.
    return { ok: false, error: "That code isn't right." };
  }

  await approveDevice(db, device.id);
  // Deleted AFTER approving, not before: if approveDevice were to throw, the challenge (and its
  // attempt count) survives for a retry instead of vanishing while nothing was actually approved.
  // On the success path this also closes the replay: the code that just worked no longer exists.
  await clearChallenge(db, device.id);
  revalidatePath("/devices");
  return { ok: true as const };
});

export const revokeMyDeviceAction = withMember("device.revoke", async (member, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  const db = createServiceClient();

  // Ownership check against the DATABASE, not against an id trusted at face value — the same
  // reasoning as setMemberRoleAction reading the target member fresh rather than trusting the form.
  const mine = await listDevicesForMember(db, member.id);
  const target = mine.find((d) => d.id === id);
  if (!target) return { ok: false, error: "That device is no longer listed." };

  await deleteDevice(db, target.id);

  // If the browser's OWN cookie names the device just revoked, drop it too. Otherwise the browser
  // keeps presenting a token for a device that no longer exists — harmless (is_device_trusted finds
  // no row and refuses), but there is no reason to leave a dead cookie lying around.
  const jar = await cookies();
  const token = jar.get(DEVICE_COOKIE)?.value;
  if (token && hashDeviceToken(token) === target.tokenHash) {
    jar.delete(DEVICE_COOKIE);
  }

  revalidatePath("/devices");
  return { ok: true as const };
});

/** ONE refusal for both admin actions, covering "no such device" AND "a device belonging to another
 *  organisation" — same reasoning as NO_DEVICE and NOT_A_MEMBER. Telling those apart would confirm
 *  to an admin probing ids which ones are real somewhere else on the system. */
const NOT_IN_YOUR_ORG = "That device is no longer listed.";

/** THE ORGANISATION CHECK BELOW IS NOT REDUNDANT WITH ROW-LEVEL SECURITY, AND CANNOT BE.
 *
 *  `trusted_devices` is deliberately NOT granted to `app_tenant` (migrations 0042/0043) — it holds
 *  device token hashes, and the decision was that reaching it from a tenant token should fail loudly
 *  rather than quietly work. So these two actions run on `createServiceClient()`, which carries
 *  `bypassrls`: no policy is evaluated on this table for this path, and nothing under the
 *  application will catch a missing filter. `findDeviceInOrg` IS the wall here.
 *
 *  Without it, `id` is taken at face value from a submitted form: an admin of organisation A could
 *  read a pending device id belonging to organisation B and approve it — making B's untrusted
 *  browser trusted — or revoke B's devices and lock B's staff out. Same reasoning as
 *  `revokeMyDeviceAction` reading the caller's own devices from the database rather than trusting
 *  the posted id, and as `setMemberRoleAction` re-reading the target member. */
export const adminApproveDeviceAction = withAdmin("device.adminApprove", async (admin, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "No device specified." };
  const db = createServiceClient();
  const device = await findDeviceInOrg(db, id, admin.orgId);
  if (!device) return { ok: false, error: NOT_IN_YOUR_ORG };
  await approveDevice(db, device.id);
  revalidatePath("/devices");
  return { ok: true as const };
});

/** Scoped for the same reason, and by the same call, as adminApproveDeviceAction above — see the
 *  comment there. Row-level security is not underneath this either. */
export const adminRevokeDeviceAction = withAdmin("device.adminRevoke", async (admin, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "No device specified." };
  const db = createServiceClient();
  const device = await findDeviceInOrg(db, id, admin.orgId);
  if (!device) return { ok: false, error: NOT_IN_YOUR_ORG };
  await deleteDevice(db, device.id);
  revalidatePath("/devices");
  return { ok: true as const };
});
