/** Membership: who is allowed to use this app, as opposed to who has proved an identity.
 *
 *  PURE — no database, no Supabase. The lookup lives in getCurrentMember; this file only decides,
 *  because deciding is the part that must not be wrong. */

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
