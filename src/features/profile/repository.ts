import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProfileFields } from "./profileRules";

export interface MemberProfile {
  id: string;
  email: string;
  name: string;
  phone: string;
  position: string;
  address: string;
  avatarPath: string | null;
  phoneVerifiedAt: string | null;
}

/** The profile columns are deliberately NOT folded into the Member type in features/auth: that type
 *  is the membership gate's, it is read on every request, and it should carry only what deciding
 *  needs. */
export async function readProfile(db: SupabaseClient, memberId: string): Promise<MemberProfile | null> {
  const { data, error } = await db
    .from("members")
    .select("id, email, name, phone, position, address, avatar_path, phone_verified_at")
    .eq("id", memberId)
    .maybeSingle();
  if (error) throw new Error(`readProfile: ${error.message}`);
  if (!data) return null;
  return {
    id: String(data.id),
    email: String(data.email),
    name: String(data.name ?? ""),
    phone: String(data.phone ?? ""),
    position: String(data.position ?? ""),
    address: String(data.address ?? ""),
    avatarPath: data.avatar_path === null ? null : String(data.avatar_path),
    phoneVerifiedAt: data.phone_verified_at === null ? null : String(data.phone_verified_at),
  };
}

export async function writeProfile(
  db: SupabaseClient, memberId: string, fields: ProfileFields
): Promise<void> {
  const { error } = await db
    .from("members")
    .update({
      name: fields.name,
      phone: fields.phone,
      position: fields.position,
      address: fields.address,
    })
    .eq("id", memberId);
  if (error) throw new Error(`writeProfile: ${error.message}`);
}

export async function writeAvatarPath(
  db: SupabaseClient, memberId: string, path: string | null
): Promise<void> {
  const { error } = await db.from("members").update({ avatar_path: path }).eq("id", memberId);
  if (error) throw new Error(`writeAvatarPath: ${error.message}`);
}

export interface PendingVerification {
  memberId: string;
  phone: string;
  code: string;
  attempts: number;
  expiresAt: string;
  createdAt: string;
}

export async function readPendingVerification(
  db: SupabaseClient, memberId: string
): Promise<PendingVerification | null> {
  const { data, error } = await db
    .from("phone_verifications")
    .select("member_id, phone, code, attempts, expires_at, created_at")
    .eq("member_id", memberId)
    .maybeSingle();
  if (error) throw new Error(`readPendingVerification: ${error.message}`);
  if (!data) return null;
  return {
    memberId: String(data.member_id),
    phone: String(data.phone),
    code: String(data.code),
    attempts: Number(data.attempts ?? 0),
    expiresAt: String(data.expires_at),
    createdAt: String(data.created_at),
  };
}

/** Upsert on the primary key: asking for a new code REPLACES any code already in flight, so a
 *  member never has two live codes and a stale one cannot confirm a later number. */
export async function writePendingVerification(
  db: SupabaseClient, memberId: string, phone: string, code: string, expiresAtIso: string
): Promise<void> {
  const { error } = await db.from("phone_verifications").upsert({
    member_id: memberId,
    phone,
    code,
    attempts: 0,
    expires_at: expiresAtIso,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`writePendingVerification: ${error.message}`);
}

export async function bumpVerificationAttempts(
  db: SupabaseClient, memberId: string, attempts: number
): Promise<void> {
  const { error } = await db
    .from("phone_verifications").update({ attempts }).eq("member_id", memberId);
  if (error) throw new Error(`bumpVerificationAttempts: ${error.message}`);
}

/** Atomically claims the right to send a code, via the `claim_phone_verification` Postgres
 *  function (migration 0024). Returns true only if THIS caller won the claim — meaning it is the
 *  one that should actually send the text. A plain read-then-write here would let two concurrent
 *  requests both see no pending row (or a stale one) and both send a message; the database
 *  function serialises on the primary key so only one caller's write applies. */
export async function claimPhoneVerification(
  db: SupabaseClient, memberId: string, phone: string, code: string,
  ttlSeconds: number, cooldownSeconds: number
): Promise<boolean> {
  const { data, error } = await db.rpc("claim_phone_verification", {
    p_member_id: memberId,
    p_phone: phone,
    p_code: code,
    p_ttl_seconds: ttlSeconds,
    p_cooldown_seconds: cooldownSeconds,
  });
  if (error) throw new Error(`claimPhoneVerification: ${error.message}`);
  return Boolean(data);
}

export async function clearPendingVerification(db: SupabaseClient, memberId: string): Promise<void> {
  const { error } = await db.from("phone_verifications").delete().eq("member_id", memberId);
  if (error) throw new Error(`clearPendingVerification: ${error.message}`);
}

/** Marks a phone verified ONLY IF the profile still holds the exact number the code was sent to.
 *  The read-then-write in confirmPhoneCodeAction checks this too, but that check and this write are
 *  not atomic: a save landing in between can change the number after the check passes and before
 *  this runs. Making the WRITE itself conditional (`.eq("phone", expectedPhone)`) closes that gap —
 *  the update simply touches no row if the number moved, and the caller learns that from the
 *  return value instead of from a second read that could itself be stale. */
export async function markPhoneVerified(
  db: SupabaseClient, memberId: string, atIso: string, expectedPhone: string
): Promise<boolean> {
  const { data, error } = await db
    .from("members")
    .update({ phone_verified_at: atIso })
    .eq("id", memberId)
    .eq("phone", expectedPhone)
    .select("id");
  if (error) throw new Error(`markPhoneVerified: ${error.message}`);
  return Boolean(data && data.length > 0);
}

/** A number that changed has not been confirmed. */
export async function clearPhoneVerified(db: SupabaseClient, memberId: string): Promise<void> {
  const { error } = await db
    .from("members").update({ phone_verified_at: null }).eq("id", memberId);
  if (error) throw new Error(`clearPhoneVerified: ${error.message}`);
}
