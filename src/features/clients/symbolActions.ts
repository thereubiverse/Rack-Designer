"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { getFloorPlan } from "@/features/locations/repository";
import type { PlanLabel } from "@/lib/supabase/types";
import { downloadPlanObject } from "./planStorage";
import { renderPlanGrey } from "./planRaster";
import {
  extractTemplate,
  matchSymbol,
  cropToInk,
  hasInk,
  dominantAngles,
  type GreyImage,
  type SymbolHit,
} from "./symbolMatch";
import { decodePlanPage, type PlanPath, type PlanTextItem } from "./planPaths";
import { coerceTypeCode, type Confidence, type DeviceProposal } from "./planDetect";

export type DiscoverSymbolsResult =
  | { ok: true; proposals: DeviceProposal[] }
  | { ok: false; error: string };

export type PickSymbolResult =
  | { ok: true; box: { x: number; y: number; w: number; h: number }; pathCount: number }
  | { ok: false; error: string };

/** The measured operating point (see symbolMatch's header): 0.65 with the four square rotations
 *  gave CP 9/10 and GFI 12/14 on the real sheet; 0.7 costs real detections. */
const MIN_SCORE = 0.65;
/** What to search when the plan has no extracted wall geometry to derive orientations from — the
 *  four square rotations this feature shipped with. */
const SQUARE_ROTATIONS = [0, 90, 180, 270];
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
/** One message for every "that click resolved to nothing" case, so the user is told what to do
 *  rather than which internal gate refused. */
const NO_SYMBOL_THERE = "No symbol there — click directly on a device symbol.";

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
 * Find every instance of the symbol the user picked, and stage them as device proposals.
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
      return { ok: false, error: "That symbol is too small to search for." };
    }

    // A mostly-background template correlates with blank paper everywhere (measured: 400 hits on
    // the real sheet for a box drawn on blank paper, vs 7 genuine ones for a tight box on the same
    // symbol). pickSymbolAction now hands over a box cut from the PDF's own vector bounds, so this
    // is a belt-and-braces pass rather than the load-bearing fix it was when the box was dragged —
    // kept because the box is still client input and the caller could send anything.
    const cropped = cropToInk(img, box);
    if (!hasInk(img, cropped)) {
      return { ok: false, error: "Nothing to match there — try a different symbol." };
    }

    // Devices mount on walls, so a symbol's rotation follows the wall it sits on. The plan's own
    // extracted wall runs say which orientations this building uses; searching those (and nothing
    // else) is what recovers a symbol drawn in a rotated wing without paying for arbitrary angles
    // the drawing never uses. Measured on the real Cellar sheet: GFI recall 12/14 -> 13/14, CP
    // 9/10 -> 9/10, at ~2x the runtime. A plan whose geometry has never been extracted has
    // wall_runs null; that falls back to exactly the previous behaviour.
    const rotations =
      plan.wall_runs && plan.wall_runs.length > 0
        ? dominantAngles(plan.wall_runs, { aspectRatio: img.width / img.height })
        : SQUARE_ROTATIONS;

    const tpl = extractTemplate(img, cropped);
    const hits = matchSymbol(img, tpl, {
      minScore: MIN_SCORE,
      rotations,
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

// ---- Click-to-pick: resolve a click to the symbol's own vector paths ------------------------
//
// All three constants are in PAGE PIXELS at the 2600-long-edge render (planPaths.RENDER_LONG_EDGE).
// They were TUNED ON ONE SHEET (a real cellar-level electrical plan) and are the first thing to
// adjust if picking starts grabbing too much or too little.

/** How far outside a path's bbox a click still counts as "on" it. A stroked arc is a hairline in
 *  vector space; without slack, clicking a circle's outline would miss it more often than not. */
const PICK_HIT_TOLERANCE_PX = 3;
/** How close another path's bbox must come to the group's for it to join. Small enough that the
 *  next symbol along does not chain in, large enough to bridge a symbol's own gaps (a circle and
 *  the letters inside it are separate paths). */
const PICK_LINK_PX = 4;
/** The longest side a picked group may have. This is the guard that stops the group swallowing the
 *  wall the symbol sits on, or a long leader line: a path is refused if adding it would push the
 *  group past this, no matter how close it is. Symbols on this sheet run 15-60px. */
const PICK_MAX_SIDE_PX = 70;

/** How far a text glyph's measured box is padded before a path's centre is tested against it. A
 *  glyph's OUTLINE can spill a hair past its metrics box (curve endpoints past the ink), so a
 *  tight test would let a couple of stray path fragments back into the group; small enough that it
 *  can't reach a genuinely separate symbol a few pixels away. */
const TEXT_BOX_PAD_PX = 2;

type Box = { minX: number; minY: number; maxX: number; maxY: number };

const longestSide = (b: Box) => Math.max(b.maxX - b.minX, b.maxY - b.minY);

/** True if a path is a letter/digit rather than device ink: its WHOLE bbox is contained inside some
 *  text item's (padded) box. Tested on full containment, not centre-in-box or any overlap — a
 *  centre-only test was tried and measured wrong on the real sheet: some symbols have their own
 *  label drawn INSIDE their ring (a card reader's circle has "CP" written at its centre), so the
 *  ring's bbox centre sits inside the "CP" text box even though the ring is plainly not a glyph.
 *  A glyph's own path is always fully bounded by its run's box by construction (the box is derived
 *  FROM that ink); a symbol's own ink is bigger than one label and will poke past that box on some
 *  side even when the two overlap or share a centre. */
function isTextGlyph(p: PlanPath, textBoxes: Box[]): boolean {
  for (const b of textBoxes) {
    if (p.minX >= b.minX && p.maxX <= b.maxX && p.minY >= b.minY && p.maxY <= b.maxY) return true;
  }
  return false;
}

/** 0..1, or null if the client sent something that isn't a number. Clamping is deliberate — a
 *  click reported a hair off the sheet edge is a click on the edge, not an error. */
function clamp01(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return clamp(v, 0, 1);
}

/**
 * The symbol under (x, y) in page pixels, as the bbox of the paths that make it up — or null if the
 * click landed on nothing but background.
 *
 * Vectors are used ONLY to decide this region; matching still happens on the raster. Matching on
 * vectors was measured and ruled out (the same symbol appears with differing vertex counts).
 *
 * The rule, verified on the real sheet (three different click points on one symbol all resolved to
 * the same group): seed on the SMALLEST foreground path the click is inside that is not already
 * symbol-sized-or-larger, then repeatedly absorb any foreground path that comes within
 * PICK_LINK_PX of the group — refusing any addition that would push the group past
 * PICK_MAX_SIDE_PX. Text glyphs are excluded from the group entirely (never seeded on, never
 * absorbed): the sheet's device tags (e.g. "AC-C-1", "AC-C-3", …) carry different digits at every
 * instance, so a template that swallows one is distinctive to that ONE instance rather than to the
 * symbol — measured on the real sheet, a click on a card reader used to grow 59.0 x 22.9 (circle
 * plus its "AC-C-n" tag) and cost real match recall; excluding the tag brings the box down to the
 * circle alone, ~24px wide.
 */
function pickSymbolGroup(
  paths: PlanPath[],
  texts: PlanTextItem[],
  x: number,
  y: number
): { box: Box; pathCount: number } | null {
  const textBoxes: Box[] = texts.map((t) => ({
    minX: t.minX - TEXT_BOX_PAD_PX,
    minY: t.minY - TEXT_BOX_PAD_PX,
    maxX: t.maxX + TEXT_BOX_PAD_PX,
    maxY: t.maxY + TEXT_BOX_PAD_PX,
  }));
  // Foreground, non-text only: the architecture is screened back (planPaths), and a text glyph is
  // never part of the device's own ink — see the header comment above.
  const fg = paths.filter((p) => !p.grey && !isTextGlyph(p, textBoxes));

  let seed: PlanPath | null = null;
  let seedArea = Infinity;
  for (const p of fg) {
    if (x < p.minX - PICK_HIT_TOLERANCE_PX || x > p.maxX + PICK_HIT_TOLERANCE_PX) continue;
    if (y < p.minY - PICK_HIT_TOLERANCE_PX || y > p.maxY + PICK_HIT_TOLERANCE_PX) continue;
    if (longestSide(p) > PICK_MAX_SIDE_PX) continue;   // a wall or leader line, never a seed
    const area = (p.maxX - p.minX) * (p.maxY - p.minY);
    if (area < seedArea) {
      seed = p;
      seedArea = area;
    }
  }
  if (!seed) return null;

  const box: Box = { minX: seed.minX, minY: seed.minY, maxX: seed.maxX, maxY: seed.maxY };
  const taken = new Set<PlanPath>([seed]);
  // Repeat until a whole sweep adds nothing: a path that only becomes adjacent AFTER the group has
  // grown must still get its chance, which one pass would miss.
  let growing = true;
  while (growing) {
    growing = false;
    for (const p of fg) {
      if (taken.has(p)) continue;
      const near =
        p.minX <= box.maxX + PICK_LINK_PX &&
        p.maxX >= box.minX - PICK_LINK_PX &&
        p.minY <= box.maxY + PICK_LINK_PX &&
        p.maxY >= box.minY - PICK_LINK_PX;
      if (!near) continue;
      const next: Box = {
        minX: Math.min(box.minX, p.minX),
        minY: Math.min(box.minY, p.minY),
        maxX: Math.max(box.maxX, p.maxX),
        maxY: Math.max(box.maxY, p.maxY),
      };
      // THE guard. Without it the group walks straight down the wall the symbol sits on.
      if (longestSide(next) > PICK_MAX_SIDE_PX) continue;
      box.minX = next.minX;
      box.minY = next.minY;
      box.maxX = next.maxX;
      box.maxY = next.maxY;
      taken.add(p);
      growing = true;
    }
  }

  return { box, pathCount: taken.size };
}

/**
 * Resolve a click on the plan to the exact bounds of the symbol under it.
 *
 * Replaces the old drag-a-box step of symbol discovery. A dragged box inevitably carries
 * background, and a mostly-blank template correlates with blank paper across the whole sheet; the
 * PDF knows where the symbol's ink actually is, so the reference region becomes pixel-tight by
 * construction. The returned box feeds discoverSymbolsAction unchanged.
 *
 * `floorId` is the ONLY client input trusted for scope — the plan and its PDF are derived from it
 * server-side. The point is clamped into the page rather than trusted or rejected.
 *
 * NOTHING may escape as a rejection: getFloorPlan, downloadPlanObject and decodePlanPage can all
 * throw, so every one of them is awaited INSIDE this single try/catch.
 */
export async function pickSymbolAction(input: {
  floorId: string;
  point: { x: number; y: number };
}): Promise<PickSymbolResult> {
  try {
    const db = createServiceClient();
    const plan = await getFloorPlan(db, input.floorId);
    if (!plan) return { ok: false, error: "Upload a plan first." };
    if (plan.pdf_storage_path == null) return { ok: false, error: "This plan has no source PDF." };

    const nx = clamp01(input.point?.x);
    const ny = clamp01(input.point?.y);
    if (nx == null || ny == null) return { ok: false, error: NO_SYMBOL_THERE };

    const bytes = await downloadPlanObject(db, plan.pdf_storage_path);
    // pdf_page of 0 is a real, valid page index — never coerce with `||`, only `??`.
    const page = await decodePlanPage(bytes, plan.pdf_page ?? 0);

    const found = pickSymbolGroup(page.paths, page.texts, nx * page.width, ny * page.height);
    if (!found) return { ok: false, error: NO_SYMBOL_THERE };

    // Back to 0..1 against the SAME raster the canvas and the matcher use. Clamped at the edges:
    // a path may run a fraction past the trimmed page box.
    const left = clamp(found.box.minX / page.width, 0, 1);
    const right = clamp(found.box.maxX / page.width, 0, 1);
    const top = clamp(found.box.minY / page.height, 0, 1);
    const bottom = clamp(found.box.maxY / page.height, 0, 1);
    return {
      ok: true,
      box: { x: left, y: top, w: right - left, h: bottom - top },
      pathCount: found.pathCount,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[pickSymbol]", detail);
    return { ok: false, error: "Couldn't read this plan's shapes." };
  }
}
