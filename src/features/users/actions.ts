"use server";

import { revalidatePath } from "next/cache";
import { createTenantClient } from "@/lib/supabase/tenant";
import { withAdmin } from "@/features/auth/withMember";
import { normaliseEmail } from "@/features/auth/members";
import {
  isRole, wouldLeaveNoAdmin, LAST_ADMIN, CANNOT_CHANGE_OWN_ROLE, CANNOT_REVOKE_SELF, type Role,
} from "@/features/auth/roles";
import {
  listRolesForInvariant, insertMember, updateMemberRole, setMemberDisabled, findMemberById,
} from "./repository";
import { inviteUserByEmail } from "./invite";

export const inviteMemberAction: (
  formData: FormData
) => Promise<{ ok: boolean; error?: string; warning?: string }> = withAdmin("member.invite", async (admin, formData: FormData) => {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  if (!email) return { ok: false, error: "Enter an email address." };
  if (!isRole(role)) return { ok: false, error: "Choose a role." };

  const db = createTenantClient(admin);
  try {
    await insertMember(db, email, name, role, admin.orgId);
  } catch {
    // The unique constraint on email is the real check; racing two invites for the same address
    // lands here rather than creating a duplicate.
    return { ok: false, error: "Someone with that email has already been invited." };
  }

  const sent = await inviteUserByEmail(email);
  revalidatePath("/users");
  // Invited either way: the row grants access, the email only helps them set a password.
  return sent.sent
    ? { ok: true as const }
    : { ok: true as const, warning: "Invited, but the email could not be sent. They can still sign in with Google or Microsoft." };
});

export const setMemberRoleAction: (
  formData: FormData
) => Promise<{ ok: boolean; error?: string }> = withAdmin("member.setRole", async (admin, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!isRole(role)) return { ok: false, error: "Choose a role." };
  // Not because self-demotion is always unsafe, but because the safe cases are rare and the unsafe
  // one — the last admin demoting themselves — is unrecoverable without psql.
  if (id === admin.id) return { ok: false, error: CANNOT_CHANGE_OWN_ROLE };

  const db = createTenantClient(admin);
  const target = await findMemberById(db, id);
  if (!target) return { ok: false, error: "That person is no longer in the list." };

  // Read at write time. Two admins demoting each other from two browsers both saw "2 admins".
  const all = await listRolesForInvariant(db);
  if (wouldLeaveNoAdmin(all, { from: target.role, to: role, fromDisabled: target.disabledAt !== null })) {
    return { ok: false, error: LAST_ADMIN };
  }

  await updateMemberRole(db, id, role);
  revalidatePath("/users");
  return { ok: true as const };
});

export const setMemberActiveAction: (
  formData: FormData
) => Promise<{ ok: boolean; error?: string }> = withAdmin("member.setActive", async (admin, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  // Explicit "false" revokes; anything else — missing field, typo, malformed request — leaves
  // access alone. The destructive branch must never be what a missing value falls into.
  const active = String(formData.get("active") ?? "") !== "false";
  if (id === admin.id) return { ok: false, error: CANNOT_REVOKE_SELF };

  const db = createTenantClient(admin);
  const target = await findMemberById(db, id);
  if (!target) return { ok: false, error: "That person is no longer in the list." };

  // Restoring can only ADD an active admin, so it can never trip the invariant.
  if (!active) {
    const all = await listRolesForInvariant(db);
    if (wouldLeaveNoAdmin(all, { from: target.role, to: "revoked", fromDisabled: target.disabledAt !== null })) {
      return { ok: false, error: LAST_ADMIN };
    }
  }

  await setMemberDisabled(db, id, !active);
  revalidatePath("/users");
  return { ok: true as const };
});
