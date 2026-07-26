import "server-only";
import type { WallRun, PlanLabel } from "@/lib/supabase/types";
import { buildWallRuns, collapseWallPairs, normalizeRuns } from "./planGeometry";
import { decodePlanPage } from "./planPaths";

const MAX_LABELS = 400;

/**
 * Wall runs and text labels for one PDF page.
 *
 * The pdf.js operator walk itself lives in planPaths.decodePlanPage — shared with symbol picking,
 * so the two features can never disagree about where a path is. This file is only the wall-run
 * derivation on top of it.
 */
export async function extractPlanGeometry(
  pdfBytes: Uint8Array,
  pageIndex: number
): Promise<{ walls: WallRun[]; labels: PlanLabel[]; width: number; height: number }> {
  const { paths, texts, width: W, height: H } = await decodePlanPage(pdfBytes, pageIndex);

  const segs: { a: [number, number]; b: [number, number]; grey: boolean }[] = [];
  for (const p of paths) {
    for (const s of p.segs) segs.push({ a: s.a, b: s.b, grey: p.grey });
  }

  const walls = normalizeRuns(collapseWallPairs(buildWallRuns(segs, W, H), W, H), W, H);

  const labels: PlanLabel[] = [];
  for (const t of texts) {
    labels.push({
      text: t.text,
      x: Math.max(0, Math.min(1, t.x / W)),
      y: Math.max(0, Math.min(1, t.y / H)),
    });
    if (labels.length >= MAX_LABELS) break;
  }

  return { walls, labels, width: W, height: H };
}
