import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

const BUCKET = "floor-plans";
const SIGNED_URL_TTL_SECONDS = 3600;

/** Thin wrappers around the `floor-plans` storage bucket — kept deliberately dumb so
 *  planActions.test.ts can fake the whole module with plain vi.fn()s and never touch real
 *  storage/network. House style: error prefix is the function name. */

export async function uploadPlanObject(db: SupabaseClient, path: string, bytes: Uint8Array): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, {
    upsert: true,
    contentType: "image/png",
  });
  if (error) throw new Error(`uploadPlanObject: ${error.message}`);
}

export async function createPlanSignedUrl(db: SupabaseClient, path: string): Promise<string | null> {
  const { data, error } = await db.storage.from(BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error) throw new Error(`createPlanSignedUrl: ${error.message}`);
  return data?.signedUrl ?? null;
}

export async function removePlanObject(db: SupabaseClient, path: string): Promise<void> {
  const { error } = await db.storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`removePlanObject: ${error.message}`);
}
