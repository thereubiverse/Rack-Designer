"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { getFloorPlan } from "@/features/locations/repository";
import type { PlanLabel } from "@/lib/supabase/types";
import { downloadPlanObject } from "./planStorage";
import { renderPlanGrey } from "./planRaster";
import { extractTemplate, matchSymbol, type GreyImage, type SymbolHit } from "./symbolMatch";
import { coerceTypeCode, type Confidence, type DeviceProposal } from "./planDetect";

export type DiscoverSymbolsResult =
  | { ok: true; proposals: DeviceProposal[] }
  | { ok: false; error: string };

/** The measured operating point (see symbolMatch's header): 0.65 with the four square rotations
 *  gave CP 9/10 and GFI 12/14 on the real sheet; 0.7 costs real detections. */
const MIN_SCORE = 0.65;
const ROTATIONS = [0, 90, 180, 270];
/** A sheet has hundreds of outlets, not thousands. The cap bounds both the response and the review
 *  list; the matcher returns highest-scoring first, so a truncated run keeps the best hits. */
const MAX_HITS = 200;
/** Below this the "symbol" is a few pixels of noise: correlating it would return a wall of
 *  meaningless hits rather than nothing, which is the worse failure. */
const MIN_TEMPLATE_PX = 6;
/** How far from a hit's centre a plan label may sit and still be that symbol's code. Symbols run
 *  13-24px on this raster and their callouts sit right beside them. */
const LABEL_RADIUS_PX = 40;
/** A device code, not prose. The text layer is ~400 entries of both. */
const CODE_SHAPED = /^[A-Za-z0-9_-]{2,12}$/;

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Normalized 0..1 box -> a pixel window guaranteed to lie inside the page, or null if what's left
 *  is too small to be a symbol. The client box is UNTRUSTED: it may be inverted (a bottom-right to
 *  top-left drag), may overshoot the sheet, and may not be numbers at all. */
function toPixelBox(
  box: { x: number; y: number; w: number; h: number },
  imgW: number,
  imgH: number
): { x: number; y: number; w: number; h: number } | null {
  if (!isFiniteNum(box?.x) || !isFiniteNum(box?.y) || !isFiniteNum(box?.w) || !isFiniteNum(box?.h)) {
    return null;
  }
  // Clamp the two CORNERS rather than origin+extent, so an inverted drag and an overshooting one
  // both collapse onto the same in-page rectangle.
  const left = clamp(box.x * imgW, 0, imgW);
  const right = clamp((box.x + box.w) * imgW, 0, imgW);
  const top = clamp(box.y * imgH, 0, imgH);
  const bottom = clamp((box.y + box.h) * imgH, 0, imgH);
  const x = Math.round(Math.min(left, right));
  const y = Math.round(Math.min(top, bottom));
  const w = Math.round(Math.abs(right - left));
  const h = Math.round(Math.abs(bottom - top));
  if (w < MIN_TEMPLATE_PX || h < MIN_TEMPLATE_PX) return null;
  return { x, y, w, h };
}

function toConfidence(score: number): Confidence {
  if (score >= 0.85) return "high";
  if (score >= 0.72) return "medium";
  return "low";
}

/** The nearest CODE-SHAPED plan label within LABEL_RADIUS_PX of the hit, or "". Empty is a fine
 *  answer — the accept path falls back to suggestDeviceCode — and far better than handing a device
 *  a code lifted from a note ("FOR CARD MACHINE"), which is why the shape gate comes first and the
 *  distance contest runs only among survivors. */
function nearestCode(labels: PlanLabel[], hit: SymbolHit, imgW: number, imgH: number): string {
  let best = "";
  let bestDist = LABEL_RADIUS_PX;
  for (const l of labels) {
    const text = typeof l?.text === "string" ? l.text.trim() : "";
    if (!CODE_SHAPED.test(text)) continue;
    if (!isFiniteNum(l.x) || !isFiniteNum(l.y)) continue;
    const dist = Math.hypot(l.x * imgW - hit.x, l.y * imgH - hit.y);
    if (dist < bestDist) {
      bestDist = dist;
      best = text;
    }
  }
  return best;
}

/**
 * Find every instance of the symbol the user boxed, and stage them as device proposals.
 *
 * NOT an AI pass despite living beside one: this is exact raster template matching (symbolMatch),
 * measured on the real sheet. No model, no key, no network beyond fetching the plan's own PDF.
 *
 * `floorId` is the ONLY client input trusted for scope — the plan, its PDF and its labels are all
 * derived from it server-side. The box is clamped into the page and the type code is coerced
 * against the known floor types, so neither can carry a client's mistake into the database.
 *
 * NOTHING may escape as a rejection: getFloorPlan, downloadPlanObject, renderPlanGrey and
 * matchSymbol can all throw, so every one of them is awaited INSIDE this single try/catch. An
 * earlier slice shipped exactly that bug by awaiting a helper outside it.
 */
export async function discoverSymbolsAction(input: {
  floorId: string;
  box: { x: number; y: number; w: number; h: number };
  typeCode: string;
}): Promise<DiscoverSymbolsResult> {
  try {
    const db = createServiceClient();
    const plan = await getFloorPlan(db, input.floorId);
    if (!plan) return { ok: false, error: "Upload a plan first." };
    if (plan.pdf_storage_path == null) return { ok: false, error: "This plan has no source PDF." };

    const bytes = await downloadPlanObject(db, plan.pdf_storage_path);
    // pdf_page of 0 is a real, valid page index — never coerce with `||`, only `??`.
    const img: GreyImage = await renderPlanGrey(bytes, plan.pdf_page ?? 0);

    const box = toPixelBox(input.box, img.width, img.height);
    if (!box) {
      return { ok: false, error: "That selection is too small — drag a box around one whole symbol." };
    }

    const tpl = extractTemplate(img, box);
    const hits = matchSymbol(img, tpl, {
      minScore: MIN_SCORE,
      rotations: ROTATIONS,
      maxHits: MAX_HITS,
    });

    // Coerced ONCE for the whole run: every hit is the same symbol, so it is the same type.
    const typeCode = coerceTypeCode(input.typeCode);
    const labels = plan.plan_labels ?? [];
    const proposals: DeviceProposal[] = hits.map((h, i) => ({
      id: `sym-${i}`,
      label: nearestCode(labels, h, img.width, img.height),
      typeCode,
      // Hits are CENTRES in page pixels; the canvas works in 0..1 against the same raster.
      point: [clamp(h.x / img.width, 0, 1), clamp(h.y / img.height, 0, 1)],
      confidence: toConfidence(h.score),
    }));

    return { ok: true, proposals };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[discoverSymbols]", detail);
    return { ok: false, error: "Couldn't search this plan for that symbol." };
  }
}
