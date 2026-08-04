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
  change: { from: Role; to: Role | "revoked" }
): boolean {
  // Changing a non-admin cannot reduce the admin count, and neither can promoting someone to admin.
  if (change.from !== "admin") return false;
  if (change.to === "admin") return false;
  const activeAdmins = members.filter((m) => m.role === "admin" && m.disabledAt === null).length;
  return activeAdmins <= 1;
}

/** Specific on purpose. The generic NOT_A_MEMBER copy exists so an outsider cannot learn which
 *  addresses are real; someone already signed in and looking at their own team's app learns nothing
 *  from being told why they were refused, and a vaguer message just generates a support ticket. */
export const NEEDS_EDITOR = "You need editor access to change this.";
export const NEEDS_ADMIN = "You need admin access to do that.";
export const LAST_ADMIN = "There has to be at least one active admin.";
