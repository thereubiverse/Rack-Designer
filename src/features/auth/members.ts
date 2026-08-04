/** Membership: who is allowed to use this app, as opposed to who has proved an identity.
 *
 *  PURE — no database, no Supabase. The lookup lives in getCurrentMember; this file only decides,
 *  because deciding is the part that must not be wrong. */

import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { getSessionEmail } from "@/lib/supabase/auth";
import { isRole, type Role } from "./roles";

export interface Member {
  id: string;
  email: string;
  name: string;
  authUserId: string | null;
  disabledAt: string | null;
  /** The member's stored avatar object, or null. The other profile columns deliberately stay out of
   *  this type — it belongs to the gate and is read on every request, so it should carry only what
   *  deciding needs. This one earns its place: the root layout draws the avatar on EVERY page, and
   *  without it here the layout has to select the same row a second time on every navigation. */
  avatarPath: string | null;
  role: Role;
}

export type MemberDecision = { allowed: true; member: Member } | { allowed: false };

/** ONE refusal message for every reason. Distinguishing "revoked" from "never invited" from "no such
 *  account" would tell someone outside the company which addresses are real.
 *
 *  Re-exported here (defined in ./messages) so every existing `import { NOT_A_MEMBER } from
 *  "./members"` keeps working — only LoginForm, a client component, needs to import it from
 *  ./messages directly, to avoid this file's `server-only` import. */
export { NOT_A_MEMBER } from "./messages";

/** Emails arrive from three different providers with three different ideas about capitalisation, and
 *  the invite was typed by a human. Normalise both sides or a real member gets refused. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** No row means never invited; a `disabledAt` means revoked. Both refuse, identically.
 *  A null `authUserId` is NOT a refusal — that is simply someone's first sign-in. */
export function memberDecision(row: Member | null | undefined): MemberDecision {
  if (!row) return { allowed: false };
  if (row.disabledAt !== null) return { allowed: false };
  return { allowed: true, member: row };
}

/** The signed-in person, if they are an active member. Null covers every refusal case: no session,
 *  a session for someone never invited, and a session for someone revoked.
 *
 *  The lookup is by EMAIL, not auth user id, because a member is invited before they have an auth
 *  user at all — and because someone signing in with Google after a password (or vice versa) can
 *  arrive with a different auth user id for the same person. */
export async function getCurrentMember(): Promise<Member | null> {
  const email = await getSessionEmail();
  if (!email) return null;
  const db = createServiceClient();
  const { data, error } = await db
    .from("members")
    .select("id, email, name, auth_user_id, disabled_at, avatar_path, role")
    .eq("email", normaliseEmail(email))
    .maybeSingle();
  // A query failure (outage, bad credentials, misconfiguration) also leaves `data` null, which is
  // indistinguishable from "never invited" in the return value on purpose — the refusal message must
  // not leak which case occurred. Log server-side so an operator can tell them apart; the return
  // value stays the same uniform null either way.
  if (error) {
    console.error("getCurrentMember: members query failed", { error });
  }
  const row = data
    ? {
        id: String(data.id),
        email: String(data.email),
        name: String(data.name ?? ""),
        authUserId: data.auth_user_id === null ? null : String(data.auth_user_id),
        disabledAt: data.disabled_at === null ? null : String(data.disabled_at),
        avatarPath: data.avatar_path == null ? null : String(data.avatar_path),
        role: isRole(data.role) ? data.role : "viewer",
      }
    : null;
  const decision = memberDecision(row);
  return decision.allowed ? decision.member : null;
}
