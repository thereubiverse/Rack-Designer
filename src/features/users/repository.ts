import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isRole, type Role } from "@/features/auth/roles";

export interface MemberRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  disabledAt: string | null;
  authUserId: string | null;
  invitedAt: string;
  lastSignInAt: string | null;
}

/** `auth.users` is not exposed through the REST schema, so its `last_sign_in_at` cannot be
 *  selected with a PostgREST join. The GoTrue Admin API is the only way to reach it, and that API
 *  takes one id at a time — there is no "get these N users" call — so this fires one lookup per
 *  distinct `auth_user_id` collected from the first query, in parallel, rather than N+1 sequential
 *  round trips. A lookup that errors (or a user since deleted from auth) resolves to `null` rather
 *  than failing the whole list: a missing last-sign-in time is not a reason to hide someone from
 *  the member list.
 *
 *  `adminDb` IS A SEPARATE PARAMETER, AND IT MUST BE THE SERVICE CLIENT. This is the one call in
 *  this file that is not a PostgREST query, and a tenant token cannot make it: GoTrue answers a
 *  token whose role is `app_tenant` with 403 `{"error_code":"not_admin"}` — measured against the
 *  local stack, not assumed. Passing the tenant client here does not error, it just makes every
 *  timestamp null (the catch above swallows it) and spends a wasted 403 round trip per member per
 *  render, which is precisely how the /users column sat permanently blank without anyone noticing.
 *
 *  Nothing else moves off the tenant client for this: the members rows themselves are still read
 *  through `db`, so the set of `authUserIds` reaching this function is already organisation-scoped
 *  by policy. The service role only ever sees ids that RLS already agreed to hand over. */
async function lastSignInTimes(
  adminDb: SupabaseClient, authUserIds: string[]
): Promise<Map<string, string | null>> {
  const ids = [...new Set(authUserIds)];
  const entries = await Promise.all(
    ids.map(async (id): Promise<[string, string | null]> => {
      try {
        const { data, error } = await adminDb.auth.admin.getUserById(id);
        if (error || !data.user) return [id, null];
        return [id, data.user.last_sign_in_at ?? null];
      } catch {
        return [id, null];
      }
    })
  );
  return new Map(entries);
}

/** Sorted by name then email, so the invite list reads the way a person would scan it — not by
 *  insertion order, which is invite order and puts nobody where a reader expects them.
 *
 *  `db` is the TENANT client and stays that way — the members query below is the whole reason this
 *  function exists and it must be scoped by policy. `adminDb` is the service client, used for
 *  exactly one thing (see lastSignInTimes) and nothing else. Two clients rather than one because
 *  they reach two different services with two different notions of authority, not because this
 *  function needs extra privilege on `members`. */
export async function listMembers(db: SupabaseClient, adminDb: SupabaseClient): Promise<MemberRow[]> {
  const { data, error } = await db
    .from("members")
    .select("id, email, name, role, disabled_at, auth_user_id, invited_at");
  if (error) throw new Error(`listMembers: ${error.message}`);
  const rows = data ?? [];

  const authUserIds = rows
    .map((r) => (r.auth_user_id === null ? null : String(r.auth_user_id)))
    .filter((id): id is string => id !== null);
  const signIns = await lastSignInTimes(adminDb, authUserIds);

  return rows
    .map((r): MemberRow => {
      const authUserId = r.auth_user_id === null ? null : String(r.auth_user_id);
      return {
        id: String(r.id),
        email: String(r.email),
        name: String(r.name ?? ""),
        role: isRole(r.role) ? r.role : "viewer",
        disabledAt: r.disabled_at === null ? null : String(r.disabled_at),
        authUserId,
        invitedAt: String(r.invited_at),
        lastSignInAt: authUserId ? signIns.get(authUserId) ?? null : null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

/** The full current role list, read at write time. The last-admin invariant must be checked
 *  against THIS, never against a list a screen was showing earlier — see wouldLeaveNoAdmin. */
export async function listRolesForInvariant(
  db: SupabaseClient
): Promise<{ role: Role; disabledAt: string | null }[]> {
  const { data, error } = await db.from("members").select("role, disabled_at");
  if (error) throw new Error(`listRolesForInvariant: ${error.message}`);
  return (data ?? []).map((r) => ({
    role: isRole(r.role) ? r.role : "viewer",
    disabledAt: r.disabled_at === null ? null : String(r.disabled_at),
  }));
}

/** `email` MUST already be normalised (lowercase, trimmed) — the column has a CHECK constraint
 *  enforcing that, so an un-normalised address fails the insert rather than being silently fixed
 *  up here. `invited_at` and `disabled_at` are left to their column defaults (now(), null). */
export async function insertMember(
  db: SupabaseClient, email: string, name: string, role: Role, orgId: string
): Promise<void> {
  const { error } = await db.from("members").insert({ email, name, role, org_id: orgId });
  if (error) throw new Error(`insertMember: ${error.message}`);
}

export async function updateMemberRole(db: SupabaseClient, id: string, role: Role): Promise<void> {
  const { error } = await db.from("members").update({ role }).eq("id", id);
  if (error) throw new Error(`updateMemberRole: ${error.message}`);
}

/** Revocation, not deletion — see migration 0017. `disabled` true sets `disabled_at` to now();
 *  false clears it, restoring access. */
export async function setMemberDisabled(
  db: SupabaseClient, id: string, disabled: boolean
): Promise<void> {
  const { error } = await db
    .from("members")
    .update({ disabled_at: disabled ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) throw new Error(`setMemberDisabled: ${error.message}`);
}

/** `lastSignInAt` is ALWAYS null here, deliberately. Both callers (setMemberRoleAction and
 *  setMemberDisabledAction in ./actions.ts) read this row to re-check the target's role and
 *  disabled state at write time; neither looks at the sign-in time. Firing the GoTrue admin lookup
 *  for it would need the service client threaded through a purely tenant-scoped write path to
 *  populate a field nobody reads — and on the tenant client it was buying a 403 per call and a null
 *  anyway. The /users page, which is the only screen that renders the column, uses listMembers. */
export async function findMemberById(db: SupabaseClient, id: string): Promise<MemberRow | null> {
  const { data, error } = await db
    .from("members")
    .select("id, email, name, role, disabled_at, auth_user_id, invited_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`findMemberById: ${error.message}`);
  if (!data) return null;
  const authUserId = data.auth_user_id === null ? null : String(data.auth_user_id);
  return {
    id: String(data.id),
    email: String(data.email),
    name: String(data.name ?? ""),
    role: isRole(data.role) ? data.role : "viewer",
    disabledAt: data.disabled_at === null ? null : String(data.disabled_at),
    authUserId,
    invitedAt: String(data.invited_at),
    lastSignInAt: null,
  };
}
