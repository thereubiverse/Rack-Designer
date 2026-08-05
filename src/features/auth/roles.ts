/** Roles, kept PURE — no database, no session. The ordering and the last-admin invariant are the
 *  only real logic in this slice, and they are the two things that must not be wrong. */

export type Role = "admin" | "editor" | "viewer";

/** Most-privileged first. The index IS the rank. */
export const ROLES = ["admin", "editor", "viewer"] as const satisfies readonly Role[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** A requirement is a MINIMUM: an admin satisfies an editor check. Lower index = more power. */
export function satisfies(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) <= ROLES.indexOf(required);
}

export function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export interface AdminCount {
  role: Role;
  disabledAt: string | null;
}

/** Would this change leave the company with nobody who can administer it?
 *
 *  Only ACTIVE admins count. A revoked admin cannot sign in, so they cannot restore anyone — leaving
 *  one of those as the sole "admin" is the same as leaving none, and the only way out would be psql.
 *
 *  `members` must be the full current list read at write time, not what a screen was showing: two
 *  admins demoting each other from two browsers both believe there are two. */
export function wouldLeaveNoAdmin(
  members: AdminCount[],
  change: { from: Role; to: Role | "revoked"; fromDisabled?: boolean }
): boolean {
  // Changing a non-admin cannot reduce the admin count, and neither can promoting someone to admin.
  if (change.from !== "admin") return false;
  if (change.to === "admin") return false;
  // Nor can changing an admin who is ALREADY revoked — they are not in the active count to begin
  // with. Without this, the sole active admin tidying up a revoked ex-admin's row is told there has
  // to be at least one active admin, which is both wrong and baffling.
  if (change.fromDisabled) return false;
  const activeAdmins = members.filter((m) => m.role === "admin" && m.disabledAt === null).length;
  return activeAdmins <= 1;
}

/** Specific on purpose. The generic NOT_A_MEMBER copy exists so an outsider cannot learn which
 *  addresses are real; someone already signed in and looking at their own team's app learns nothing
 *  from being told why they were refused, and a vaguer message just generates a support ticket. */
export const NEEDS_EDITOR = "You need editor access to change this.";
export const NEEDS_ADMIN = "You need admin access to do that.";
export const LAST_ADMIN = "There has to be at least one active admin.";
export const CANNOT_CHANGE_OWN_ROLE = "You can't change your own role.";
export const CANNOT_REVOKE_SELF = "You can't revoke your own access.";

/** Every message that means "a rule said no", as opposed to a genuine failure (a thrown error, a
 *  validation message like "Enter an email address.", or "Couldn't save your details"). The ONE
 *  source of truth for that distinction — see isRefusal, and withMember which uses it to decide
 *  between the `refused` and `failed` outcomes on the activity log. */
export const REFUSAL_MESSAGES: readonly string[] = [
  NEEDS_EDITOR,
  NEEDS_ADMIN,
  LAST_ADMIN,
  CANNOT_CHANGE_OWN_ROLE,
  CANNOT_REVOKE_SELF,
];

/** Is this error message a rule correctly saying no, rather than something actually going wrong?
 *  Used to classify an activity log entry as `refused` (present for the record, muted) instead of
 *  `failed` (a real system fault, shown as an alarming red badge). */
export function isRefusal(error: string | undefined): boolean {
  return error !== undefined && REFUSAL_MESSAGES.includes(error);
}
