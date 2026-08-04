/** Membership: who is allowed to use this app, as opposed to who has proved an identity.
 *
 *  PURE — no database, no Supabase. The lookup lives in getCurrentMember; this file only decides,
 *  because deciding is the part that must not be wrong. */

import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { getSessionEmail } from "@/lib/supabase/auth";

export interface Member {
  id: string;
  email: string;
  name: string;
  authUserId: string | null;
  disabledAt: string | null;
}

export type MemberDecision = { allowed: true; member: Member } | { allowed: false };

/** ONE refusal message for every reason. Distinguishing "revoked" from "never invited" from "no such
 *  account" would tell someone outside the company which addresses are real. */
export const NOT_A_MEMBER =
  "That account doesn't have access to this app. Ask an administrator to invite you.";

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
  const { data } = await db
    .from("members")
    .select("id, email, name, auth_user_id, disabled_at")
    .eq("email", normaliseEmail(email))
    .maybeSingle();
  const row = data
    ? {
        id: String(data.id),
        email: String(data.email),
        name: String(data.name ?? ""),
        authUserId: data.auth_user_id === null ? null : String(data.auth_user_id),
        disabledAt: data.disabled_at === null ? null : String(data.disabled_at),
      }
    : null;
  const decision = memberDecision(row);
  return decision.allowed ? decision.member : null;
}
