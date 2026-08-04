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

export async function clearPendingVerification(db: SupabaseClient, memberId: string): Promise<void> {
  const { error } = await db.from("phone_verifications").delete().eq("member_id", memberId);
  if (error) throw new Error(`clearPendingVerification: ${error.message}`);
}

export async function markPhoneVerified(
  db: SupabaseClient, memberId: string, atIso: string
): Promise<void> {
  const { error } = await db
    .from("members").update({ phone_verified_at: atIso }).eq("id", memberId);
  if (error) throw new Error(`markPhoneVerified: ${error.message}`);
}

/** A number that changed has not been confirmed. */
export async function clearPhoneVerified(db: SupabaseClient, memberId: string): Promise<void> {
  const { error } = await db
    .from("members").update({ phone_verified_at: null }).eq("id", memberId);
  if (error) throw new Error(`clearPhoneVerified: ${error.message}`);
}
