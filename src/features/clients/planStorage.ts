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

/** The stored object for a floor's plan. Organisation first, for the same reason as avatarPathFor:
 *  slice 2's storage policies match on the leading path segment. */
export function planPathFor(
  orgId: string, siteId: string, floorId: string, ext: "png" | "pdf"
): string {
  return `${orgId}/${siteId}/${floorId}.${ext}`;
}

/** Server-side fetch of a stored plan's bytes (for the AI discovery pass). */
export async function downloadPlanObject(db: SupabaseClient, path: string): Promise<Uint8Array> {
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) throw new Error(`downloadPlanObject: ${error?.message ?? "no data"}`);
  return new Uint8Array(await data.arrayBuffer());
}

const PDF_CONTENT_TYPE = "application/pdf";

/** The original upload, retained so geometry can be re-extracted when the wall filter improves. */
export async function uploadPlanPdf(db: SupabaseClient, path: string, bytes: Uint8Array): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, {
    upsert: true,
    contentType: PDF_CONTENT_TYPE,
  });
  if (error) throw new Error(`uploadPlanPdf: ${error.message}`);
}

export async function removePlanPdf(db: SupabaseClient, path: string): Promise<void> {
  const { error } = await db.storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`removePlanPdf: ${error.message}`);
}
