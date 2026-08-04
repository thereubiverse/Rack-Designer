"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
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
export const extractPlanGeometryAction = withEditor(async (_member, floorId: string): Promise<ExtractResult> => {
  try {
    const db = createServiceClient();
    const plan = await getFloorPlan(db, floorId);
    if (!plan) return { ok: false, error: "Upload a plan first." };
    if (plan.pdf_storage_path == null) return { ok: false, error: "This plan has no source PDF." };

    const bytes = await downloadPlanObject(db, plan.pdf_storage_path);
    // pdf_page of 0 is a real, valid page index — never coerce with `||`, only `??`.
    const { walls, labels } = await extractPlanGeometry(bytes, plan.pdf_page ?? 0);
    await saveFloorPlanGeometry(db, floorId, { walls, labels });

    revalidatePath("/clients");
    return { ok: true, walls: walls.length, labels: labels.length };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[extractPlanGeometry]", detail);
    return { ok: false, error: "Couldn't extract wall geometry from this PDF." };
  }
});
