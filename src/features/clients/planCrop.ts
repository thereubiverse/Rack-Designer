import type { NormPoint } from "./floorPlanOps";

/** A crop window over the plan sheet, as 0..1 fractions of the full image. */
export interface CropRect { x: number; y: number; w: number; h: number }

/** A located box smaller than this (as a fraction of the sheet's area) is treated as a bad read —
 *  cropping to it would risk clipping rooms out of the pass entirely, which is a far worse failure
 *  than simply losing the resolution gain. */
const MIN_CROP_AREA = 0.06;
/** ...and neither side may collapse, which catches a degenerate sliver with a plausible area. */
const MIN_CROP_SIDE = 0.2;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Turn the model's raw locate response into a usable crop, or null to fall back to the full sheet.
 *  Null is always safe: the caller just sends the uncropped image, exactly as before this existed. */
export function toCropRect(raw: unknown): CropRect | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (!isFiniteNum(r.x) || !isFiniteNum(r.y) || !isFiniteNum(r.w) || !isFiniteNum(r.h)) return null;
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  // Clamp the extent to what actually remains of the sheet, so a model that overshoots
  // (it is told to err large) can never produce an out-of-bounds extract.
  const w = Math.min(clamp01(r.w), 1 - x);
  const h = Math.min(clamp01(r.h), 1 - y);
  if (w < MIN_CROP_SIDE || h < MIN_CROP_SIDE || w * h < MIN_CROP_AREA) return null;
  // A box covering essentially the whole sheet buys nothing; skip the re-encode.
  if (w > 0.97 && h > 0.97) return null;
  return { x, y, w, h };
}

/** Map a point expressed in CROP space back onto the full sheet. Proposals are always stored and
 *  rendered against the full image, so every coordinate returned by a cropped pass must come back
 *  through here — otherwise the whole floor's geometry lands in the top-left corner. */
export function cropPointToFull(p: NormPoint, crop: CropRect | null): NormPoint {
  if (!crop) return p;
  return [crop.x + p[0] * crop.w, crop.y + p[1] * crop.h];
}

/** Pixel rectangle for an image extract, derived from the normalized crop. Rounded outward-safe:
 *  every value is clamped into the image so a rounding step can't push the window past its edge. */
export function cropToPixels(crop: CropRect, imgW: number, imgH: number) {
  const left = Math.max(0, Math.min(imgW - 1, Math.round(crop.x * imgW)));
  const top = Math.max(0, Math.min(imgH - 1, Math.round(crop.y * imgH)));
  return {
    left,
    top,
    width: Math.max(1, Math.min(imgW - left, Math.round(crop.w * imgW))),
    height: Math.max(1, Math.min(imgH - top, Math.round(crop.h * imgH))),
  };
}
