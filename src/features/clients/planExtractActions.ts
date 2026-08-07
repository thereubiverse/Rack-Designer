"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { createTenantClient } from "@/lib/supabase/tenant";
import { getFloorPlan, saveFloorPlanGeometry } from "@/features/locations/repository";
import { downloadPlanObject } from "./planStorage";
import { extractPlanGeometry } from "./planExtract";
import { withEditor } from "@/features/auth/withMember";

export type ExtractResult =
  | { ok: true; walls: number; labels: number }
  | { ok: false; error: string };

/** Ties Slice D's pipeline together: load the plan row, fetch the retained PDF, run the
 *  extraction pass, persist the result. getFloorPlan, downloadPlanObject, and
 *  extractPlanGeometry can ALL throw/reject (DB error, storage error, malformed or encrypted
 *  PDF) — every one of them lives inside this single try/catch so nothing escapes as an
 *  unhandled rejection. Early-outs (no row, no PDF) return before their side effect
 *  (downloadPlanObject) runs. */
export const extractPlanGeometryAction = withEditor("ai.extractGeometry", async (member, floorId: string): Promise<ExtractResult> => {
  try {
    const db = createTenantClient(member);
    const plan = await getFloorPlan(db, floorId);
    if (!plan) return { ok: false, error: "Upload a plan first." };
    if (plan.pdf_storage_path == null) return { ok: false, error: "This plan has no source PDF." };

    // app_tenant has no grant on the storage schema — narrow, service-client ONLY for this
    // download; the DB read/write above and below both use `db`.
    const storageDb = createServiceClient();
    const bytes = await downloadPlanObject(storageDb, plan.pdf_storage_path);
    // pdf_page of 0 is a real, valid page index — never coerce with `||`, only `??`.
    const { walls, labels } = await extractPlanGeometry(bytes, plan.pdf_page ?? 0);

    // RE-MINT before the write. A tenant token is valid 60 seconds plus PostgREST's 30 seconds of
    // leeway — 90 in total — and the work between the mint above and this line is UNBOUNDED: a
    // storage download of an arbitrarily large PDF, then a parse whose cost is set by the file, not
    // by us. Past 90 seconds the token expires and PGRST303 lands on THE WRITE ONLY: the download
    // and the parse have both already succeeded, so the failure looks like a broken PDF rather than
    // an expired token — the catch below reports "Couldn't extract wall geometry from this PDF",
    // which would be a lie. Minting again is one HMAC and removes the window entirely. Same shape
    // as discoverActions.ts's post-Gemini re-mint.
    await saveFloorPlanGeometry(createTenantClient(member), floorId, { walls, labels });

    revalidatePath("/clients");
    return { ok: true, walls: walls.length, labels: labels.length };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[extractPlanGeometry]", detail);
    return { ok: false, error: "Couldn't extract wall geometry from this PDF." };
  }
});
