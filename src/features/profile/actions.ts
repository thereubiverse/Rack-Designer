"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { createSessionClient } from "@/lib/supabase/auth";
import { withMember } from "@/features/auth/withMember";
import { cleanProfileFields, checkAvatar, checkNewPassword } from "./profileRules";
import { readProfile, writeProfile, writeAvatarPath } from "./repository";
import { avatarPathFor, uploadAvatarObject, removeAvatarObject } from "./avatarStorage";

/** Every action here writes to `member.id`, which withMember resolved from the session cookie.
 *  NOTHING reads an id from the form. An action that trusted a form-supplied id would let anyone
 *  overwrite anyone else's profile — including their name and picture — from a crafted request. */

export const updateProfileAction = withMember(async (member, formData: FormData) => {
  const fields = cleanProfileFields({
    name: formData.get("name"),
    phone: formData.get("phone"),
    position: formData.get("position"),
    address: formData.get("address"),
  });
  const db = createServiceClient();
  await writeProfile(db, member.id, fields);
  revalidatePath("/profile");
  // The sidebar shows the name on every page, so it is stale everywhere until the layout re-renders.
  revalidatePath("/", "layout");
  return { ok: true as const };
});

export const uploadAvatarAction = withMember(async (member, formData: FormData) => {
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose an image file." };

  const problem = checkAvatar({ size: file.size, type: file.type });
  if (problem) return { ok: false, error: problem };

  const db = createServiceClient();
  const path = avatarPathFor(member.id);
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Object first, then the row. The reverse order can leave a row pointing at a file that was
  // never written, which renders as a broken picture with no way to retry except re-uploading.
  await uploadAvatarObject(db, path, bytes, file.type);
  await writeAvatarPath(db, member.id, path);
  revalidatePath("/profile");
  revalidatePath("/", "layout");
  return { ok: true as const };
});

export const removeAvatarAction = withMember(async (member, _formData: FormData) => {
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

export const changePasswordAction = withMember(async (member, formData: FormData) => {
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
