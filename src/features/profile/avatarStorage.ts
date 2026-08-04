import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "avatars";
const SIGNED_URL_TTL_SECONDS = 3600;

/** Thin wrappers around the `avatars` bucket, mirroring planStorage.ts — kept deliberately dumb so
 *  the action tests can fake this whole module with plain vi.fn()s and never touch real storage. */

/** One object per member, overwritten on replace, so pictures never accumulate. */
export function avatarPathFor(memberId: string): string {
  return `${memberId}/avatar`;
}

export async function uploadAvatarObject(
  db: SupabaseClient, path: string, bytes: Uint8Array, contentType: string
): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, { upsert: true, contentType });
  if (error) throw new Error(`uploadAvatarObject: ${error.message}`);
}

export async function createAvatarSignedUrl(db: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) throw new Error(`createAvatarSignedUrl: ${error.message}`);
  return data?.signedUrl ?? null;
}

export async function removeAvatarObject(db: SupabaseClient, path: string): Promise<void> {
  const { error } = await db.storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`removeAvatarObject: ${error.message}`);
}
