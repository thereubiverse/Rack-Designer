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
}

/** The profile columns are deliberately NOT folded into the Member type in features/auth: that type
 *  is the membership gate's, it is read on every request, and it should carry only what deciding
 *  needs. */
export async function readProfile(db: SupabaseClient, memberId: string): Promise<MemberProfile | null> {
  const { data, error } = await db
    .from("members")
    .select("id, email, name, phone, position, address, avatar_path")
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
