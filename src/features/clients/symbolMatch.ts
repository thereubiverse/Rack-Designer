/**
 * Raster template matching for floor-plan device symbols.
 *
 * The user drags a box around one symbol (a card reader, a GFI outlet); this
 * module finds every other instance of it on the sheet.
 *
 * WHY RASTER, NOT VECTOR: measured on a real sheet, "identical" symbols are not
 * drawn identically — the same CP symbol appears with a different vertex count
 * per instance. Anything keyed on geometric identity is ruled out. They are
 * however visually identical, so normalised cross-correlation on pixels is the
 * right tool.
 *
 * PURE MODULE. No I/O, no pdf.js, no React, no globals, no randomness. It
 * receives pixel data and returns hits. Keep it that way.
 *
 * MEASURED on the real Cellar sheet (2600x1733 raster, symbols ~13-24px):
 *   - Feed it the PLAIN GREYSCALE raster. Pre-isolating the black foreground
 *     from the screened-back architecture was tried and is WORSE (CP 6/10 vs
 *     9/10): the grey context around a symbol is consistent between instances
 *     and NCC uses it. Hard binarisation is worse still (CP 3/10).
 *   - minScore around 0.65 was the useful operating point; 0.7 costs real
 *     detections. Scores on genuine instances ran 0.66-1.0, not 0.9+, because
 *     the window includes surrounding drawing that differs per instance.
 *   - Recall with the fixed rotations [0,90,180,270]: CP 9/10, GFI 12/14.
 *     Both GFI misses sit where the drawing changes orientation. The sheet uses
 *     TWO grids, 0 and 9.3 degrees, and the template happens to be cut from the
 *     9.3-degree one. `dominantAngles` reads those grids off the plan's own wall
 *     runs and searches the differences between them: GFI goes to 13/14 and CP
 *     stays 9/10 with every score improved (0.66-0.75 -> 0.72-0.87 on the four
 *     instances in the rotated part).
 *   - Runtime ~1.6-2.9s per symbol per full sheet at four rotations, single
 *     threaded; ~2-4.5x that at the twelve `dominantAngles` derives here — the
 *     rotated variants have larger bounding boxes as well as being more numerous.
 *   - The last GFI miss is NOT a rotation failure: swept at 1-degree steps its
 *     best score anywhere is 0.657, barely over the 0.65 operating point, and it
 *     wants about -6 degrees rather than the wing's -9.3.
 */

export interface GreyImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Template {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface SymbolHit {
  /** Centre of the detection, in image pixels (pixel-centre coordinates). */
  x: number;
  y: number;
  /** Normalised cross-correlation in [-1, 1]. */
  score: number;
  /** Which entry of `rotations` produced this hit. Clockwise degrees. */
  rotationDeg: number;
}

export interface MatchOpts {
  /** NCC threshold a refined peak must reach to be reported. Default 0.7. */
  minScore?: number;
  /** Degrees to try. Default [0, 90, 180, 270]. */
  rotations?: number[];
  /** Cap on returned hits, highest scoring first. Default unlimited. */
  maxHits?: number;
  /** Non-max suppression radius between hit centres. Default max(w,h)/2. */
  suppressRadiusPx?: number;
  /**
   * A candidate window whose ink density is below `inkRatioMin * templateDensity` is rejected
   * before it can become a hit, however well it correlates. Default 0.5. Set to 0 to disable
   * (exact previous behaviour) — this is what every pre-existing caller and test relies on.
   *
   * WHY: measured on the real Cellar sheet, a generously-drawn selection (mostly background) makes
   * a low-variance template that correlates with blank paper everywhere — 400 hits at minScore 0.65,
   * versus 7 genuine hits for a tight box around the same symbol. NCC alone does not catch this: a
   * faint-but-correctly-shaped window is SUPPOSED to score well (that's the contrast-invariance this
   * module relies on for genuine faint instances), so the gate has to be ink density, not score.
   */
  inkRatioMin?: number;
}

const DEFAULT_ROTATIONS = [0, 90, 180, 270];
const DEFAULT_MIN_SCORE = 0.7;
const DEFAULT_INK_RATIO_MIN = 0.5;
/** cropToInk / hasInk default — a pixel darker than this counts as ink for trimming a selection. */
const INK_THRESHOLD = 160;
/**
 * The matcher's OWN ink cut, deliberately looser than INK_THRESHOLD. This gate exists to reject
 * windows that are grossly unlike the template (blank paper scoring well against a low-variance
 * template — the reported bug), NOT to second-guess a genuine low-contrast instance. NCC is
 * explicitly contrast-invariant by design (see the module header), so a faint-but-real stroke must
 * still count as ink here even though a tight crop would not treat it as ink at all. 230 sits well
 * clear of any real stroke value seen on the measured sheet (dark strokes run well under 160) while
 * still sitting below plain white/background.
 */
const MATCH_INK_THRESHOLD = 230;

/**
 * How far below the coarse threshold a refined peak may start. Downsampling
 * blurs detail, so a true instance scores lower at the coarse level than at
 * full resolution; the coarse gate has to be looser than `minScore` or real
 * symbols never reach the refinement stage at all.
 */
const COARSE_SLACK = 0.35;
const COARSE_FLOOR = 0.25;

/**
 * Early rejection. A window whose standard deviation is a small fraction of the
 * template's is near-blank paper; skip it before paying for the correlation
 * sum. Deliberately conservative — NCC is contrast-invariant, so a faint but
 * correctly shaped window can still correlate perfectly, and we must not cull
 * one. This only removes windows that are essentially flat.
 */
const BLANK_STD_RATIO = 0.1;

/** Safety valve on refinement work if a sheet produces a pathological number of peaks. */
const MAX_CANDIDATES_PER_ROTATION = 4000;

// ---------------------------------------------------------------------------
// Template extraction
// ---------------------------------------------------------------------------

/** Crop `box` out of `img`, clamped to the image. A box fully outside yields a 0x0 template. */
export function extractTemplate(
  img: GreyImage,
  box: { x: number; y: number; w: number; h: number }
): Template {
  const x0 = clampInt(Math.round(box.x), 0, img.width);
  const y0 = clampInt(Math.round(box.y), 0, img.height);
  const x1 = clampInt(Math.round(box.x + box.w), 0, img.width);
  const y1 = clampInt(Math.round(box.y + box.h), 0, img.height);
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const data = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const src = (y0 + row) * img.width + x0;
    data.set(img.data.subarray(src, src + width), row * width);
  }
  return { data, width, height };
}

// ---------------------------------------------------------------------------
// Auto-crop to ink
// ---------------------------------------------------------------------------

export interface CropOpts {
  /** A pixel darker than this counts as ink. Default 160. */
  inkThreshold?: number;
  /** Border kept around the ink bounding box. Default 2. */
  marginPx?: number;
  /** The crop never returns smaller than this on either side. Default 6. */
  minSizePx?: number;
}

const DEFAULT_CROP_MARGIN_PX = 2;
const DEFAULT_CROP_MIN_SIZE_PX = 6;

/** Bounding box of pixels darker than `threshold` inside [x0,x1) x [y0,y1). Null if none. */
function inkBounds(
  img: GreyImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  threshold: number
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = y0; y < y1; y++) {
    const row = y * img.width;
    for (let x = x0; x < x1; x++) {
      if (img.data[row + x] < threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

/**
 * Shrink a user-drawn box to the bounding box of its ink, plus a small margin.
 *
 * WHY: the user frames a symbol; they should not have to draw a pixel-tight box. A generously-drawn
 * box is mostly background, and a low-variance template correlates with blank paper everywhere —
 * measured on the real Cellar sheet at 400 hits (the cap) for a blank template vs 7 genuine hits for
 * a tight one. Tightening the box before it becomes a template is the real fix; matchSymbol's
 * inkRatioMin gate is only a second line of defence.
 *
 * If the box contains no ink at all, the original box is returned UNCHANGED — this function never
 * throws, and it is the caller's job to decide what an empty selection means (see hasInk).
 */
export function cropToInk(
  img: GreyImage,
  box: { x: number; y: number; w: number; h: number },
  opts: CropOpts = {}
): { x: number; y: number; w: number; h: number } {
  const threshold = opts.inkThreshold ?? INK_THRESHOLD;
  const margin = opts.marginPx ?? DEFAULT_CROP_MARGIN_PX;
  const minSize = opts.minSizePx ?? DEFAULT_CROP_MIN_SIZE_PX;

  const x0 = clampInt(Math.round(box.x), 0, img.width);
  const y0 = clampInt(Math.round(box.y), 0, img.height);
  const x1 = clampInt(Math.round(box.x + box.w), 0, img.width);
  const y1 = clampInt(Math.round(box.y + box.h), 0, img.height);

  const bounds = inkBounds(img, x0, y0, x1, y1, threshold);
  if (!bounds) return { x: box.x, y: box.y, w: box.w, h: box.h };

  let nx0 = clampInt(bounds.minX - margin, 0, img.width);
  let ny0 = clampInt(bounds.minY - margin, 0, img.height);
  let nx1 = clampInt(bounds.maxX + 1 + margin, 0, img.width);
  let ny1 = clampInt(bounds.maxY + 1 + margin, 0, img.height);

  if (nx1 - nx0 < minSize) {
    const cx = (nx0 + nx1) / 2;
    const cap = Math.max(0, img.width - minSize);
    nx0 = clampInt(Math.round(cx - minSize / 2), 0, cap);
    nx1 = Math.min(img.width, nx0 + minSize);
  }
  if (ny1 - ny0 < minSize) {
    const cy = (ny0 + ny1) / 2;
    const cap = Math.max(0, img.height - minSize);
    ny0 = clampInt(Math.round(cy - minSize / 2), 0, cap);
    ny1 = Math.min(img.height, ny0 + minSize);
  }

  return { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 };
}

/** Whether any pixel in `box` is darker than `inkThreshold` (default 160). Never throws. */
export function hasInk(
  img: GreyImage,
  box: { x: number; y: number; w: number; h: number },
  opts: { inkThreshold?: number } = {}
): boolean {
  const threshold = opts.inkThreshold ?? INK_THRESHOLD;
  const x0 = clampInt(Math.round(box.x), 0, img.width);
  const y0 = clampInt(Math.round(box.y), 0, img.height);
  const x1 = clampInt(Math.round(box.x + box.w), 0, img.width);
  const y1 = clampInt(Math.round(box.y + box.h), 0, img.height);
  return inkBounds(img, x0, y0, x1, y1, threshold) !== null;
}

// ---------------------------------------------------------------------------
// Orientations the building actually uses
// ---------------------------------------------------------------------------

/** One extracted wall centreline, normalized 0..1 against the page (floor_plans.wall_runs). */
export interface AngleRun {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DominantAnglesOpts {
  /** Histogram bucket width, degrees. Default 2. */
  bucketDeg?: number;
  /** Cap on how many distinct building orientations are detected. Default 3. */
  maxAngles?: number;
  /** An orientation must hold at least this fraction of total wall length. Default 0.05. */
  minShareFrac?: number;
  /**
   * pixelWidth / pixelHeight of the page the runs were normalized against. Default 1.
   *
   * REQUIRED for a non-square page. Normalising x by W and y by H is an ANISOTROPIC scaling, and
   * anisotropic scaling does not commute with rotation: measured on the real Cellar sheet
   * (2600 x 1733), the single 9.3-degree wall family reads as TWO different families (5.4 and 12.4
   * degrees) if the angles are taken straight from the normalized coordinates. Undo the squash
   * before measuring an angle, or the peaks are fiction.
   */
  aspectRatio?: number;
}

const DEFAULT_BUCKET_DEG = 2;
const DEFAULT_MAX_ANGLES = 3;
const DEFAULT_MIN_SHARE_FRAC = 0.05;
/** Two rotations closer than this are the same search. See the merge loop below. */
const MERGE_DEG = 0.5;

/**
 * The rotations worth trying for a symbol on THIS building, derived from its wall runs.
 *
 * Devices mount on walls, so a symbol's rotation follows the wall it sits on: the orientations a
 * drawing uses are exactly the orientations of its walls. Brute-forcing every 5 degrees multiplies
 * the search cost over angles the drawing never uses; this reads them off the geometry instead.
 *
 * WHAT COMES BACK IS RELATIVE, NOT ABSOLUTE — the pairwise DIFFERENCES between the detected
 * orientations (0 always among them), each expanded to its four quadrants. This is the part that is
 * easy to get wrong, and getting it wrong was measured on the real Cellar sheet: the sheet uses two
 * orientations, 0 and 9.3 degrees; the GFI outlet the user picks sits in the 9.3-degree part of the
 * plan, and the two instances discovery misses sit in the axis-aligned part. Matching them needs the
 * template turned by MINUS 9.3 degrees. Searching the absolute orientations [0, 9.3] and their
 * quadrants leaves recall at 12/14 — unchanged; searching the differences [0, +9.3, -9.3] and their
 * quadrants takes it to 13/14. The template is cut from one instance whose own orientation is not
 * known in advance, so only the differences are meaningful.
 *
 * 0/90/180/270 are always present, so this can never search less than the previous fixed set.
 * PURE: no I/O, no clock, no randomness. Never throws — garbage in yields the four square angles.
 */
export function dominantAngles(runs: AngleRun[], opts: DominantAnglesOpts = {}): number[] {
  const bucketDeg = clampNum(opts.bucketDeg ?? DEFAULT_BUCKET_DEG, 0.25, 45);
  const maxAngles = Math.max(1, Math.floor(clampNum(opts.maxAngles ?? DEFAULT_MAX_ANGLES, 1, 12)));
  const minShareFrac = clampNum(opts.minShareFrac ?? DEFAULT_MIN_SHARE_FRAC, 0, 1);
  const aspect =
    Number.isFinite(opts.aspectRatio) && (opts.aspectRatio as number) > 0
      ? (opts.aspectRatio as number)
      : 1;

  const nb = Math.max(1, Math.round(90 / bucketDeg));
  const step = 90 / nb;
  const weight = new Float64Array(nb);
  // Doubled-angle (x4, since the period here is 90 degrees) vector sums, so a peak can be refined to
  // the length-weighted mean of its bucket and its two neighbours WITHOUT the wraparound bug that
  // averaging raw degrees has at the 0/90 seam. Measured: the sheet's near-vertical walls read
  // 89.87 degrees, which a naive mean would place at the far end of the histogram from 0.
  const vx = new Float64Array(nb);
  const vy = new Float64Array(nb);
  let total = 0;

  for (const r of runs ?? []) {
    if (!isFiniteRun(r)) continue;
    // Undo the normalisation's squash before measuring the angle (see aspectRatio above). Only the
    // RATIO matters, so scaling x by the aspect and leaving y alone is the whole correction.
    const dx = (r.x2 - r.x1) * aspect;
    const dy = r.y2 - r.y1;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    // mod 90: a wall at 10 degrees and one at 100 belong to the SAME building grid.
    let a = (Math.atan2(dy, dx) * 180) / Math.PI;
    a = ((a % 90) + 90) % 90;
    const b = Math.min(nb - 1, Math.floor(a / step));
    // Length-weighted: a 700px wall says far more about the building's grid than a 3px stub.
    weight[b] += len;
    total += len;
    const q = (4 * a * Math.PI) / 180;
    vx[b] += len * Math.cos(q);
    vy[b] += len * Math.sin(q);
  }

  if (!(total > 0)) return [...DEFAULT_ROTATIONS];

  // Peaks: heaviest buckets first, skipping any that merely neighbours one already taken (a real
  // orientation smears across two buckets when it straddles a boundary).
  const order = Array.from({ length: nb }, (_, i) => i).sort(
    (a, b) => weight[b] - weight[a] || a - b
  );
  const peaks: { deg: number; weight: number }[] = [];
  const takenBuckets: number[] = [];
  for (const b of order) {
    if (peaks.length >= maxAngles) break;
    if (weight[b] / total < minShareFrac) break; // sorted descending: nothing after this qualifies
    if (takenBuckets.some((t) => circularBucketDist(t, b, nb) <= 1)) continue;
    takenBuckets.push(b);
    let sx = 0;
    let sy = 0;
    let w = 0;
    for (let d = -1; d <= 1; d++) {
      const i = ((b + d) % nb + nb) % nb;
      sx += vx[i];
      sy += vy[i];
      w += weight[i];
    }
    let deg = (Math.atan2(sy, sx) * 180) / Math.PI / 4;
    deg = ((deg % 90) + 90) % 90;
    peaks.push({ deg, weight: w });
  }

  // 0 is always a candidate ORIENTATION, not just a candidate answer: legends, schedules and title
  // blocks are drawn square even on a rotated plan, so the user's picked example may well be square
  // while the instances are not. Its weight floor keeps it competitive when ranking below.
  const base = [...peaks];
  if (!base.some((p) => nearAngle(p.deg, 0, 90, MERGE_DEG))) {
    base.push({ deg: 0, weight: Math.max(total * minShareFrac, 0) });
  }

  // Pairwise differences, mod 90, ranked by the combined weight of the pair they come from.
  const rel: { deg: number; weight: number }[] = [];
  for (const a of base) {
    for (const b of base) {
      let d = (a.deg - b.deg) % 90;
      if (d < 0) d += 90;
      rel.push({ deg: d, weight: a.weight * b.weight });
    }
  }
  rel.sort((a, b) => b.weight - a.weight || a.deg - b.deg);
  // Merge near-identical angles, heaviest first. Below MERGE_DEG two rotations are the same search:
  // half a degree moves the corner of a 20px template by less than a tenth of a pixel, so keeping
  // both would double the runtime for nothing. It also absorbs the measurement noise in a refined
  // peak (the real sheet's axis-aligned family refines to 0.007 degrees, not 0).
  const ranked: { deg: number; weight: number }[] = [];
  for (const r of rel) {
    // Every extra relative angle is another full scan of the sheet. Cap it.
    if (ranked.length >= maxAngles + 1) break;
    if (ranked.some((k) => nearAngle(k.deg, r.deg, 90, MERGE_DEG))) continue;
    ranked.push(r);
  }

  const out: number[] = [...DEFAULT_ROTATIONS];
  for (const r of ranked) {
    for (const quadrant of DEFAULT_ROTATIONS) out.push((r.deg + quadrant) % 360);
  }
  out.sort((a, b) => a - b);
  const deduped: number[] = [];
  for (const v of out) {
    if (deduped.length === 0 || v - deduped[deduped.length - 1] > 1e-6) deduped.push(v);
  }
  return deduped;
}

function isFiniteRun(r: AngleRun): boolean {
  return (
    r != null &&
    Number.isFinite(r.x1) &&
    Number.isFinite(r.y1) &&
    Number.isFinite(r.x2) &&
    Number.isFinite(r.y2)
  );
}

function circularBucketDist(a: number, b: number, nb: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, nb - d);
}

function nearAngle(a: number, b: number, period: number, tol: number): boolean {
  let d = Math.abs(a - b) % period;
  if (d > period / 2) d = period - d;
  return d < tol;
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export function matchSymbol(img: GreyImage, tpl: Template, opts: MatchOpts = {}): SymbolHit[] {
  const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
  const maxHits = opts.maxHits ?? Number.POSITIVE_INFINITY;
  const rotations = normaliseRotations(opts.rotations ?? DEFAULT_ROTATIONS);
  const inkRatioMin = opts.inkRatioMin ?? DEFAULT_INK_RATIO_MIN;

  if (!isUsable(img) || !isUsable(tpl)) return [];
  if (img.data.length < img.width * img.height) return [];
  if (tpl.data.length < tpl.width * tpl.height) return [];

  const found: SymbolHit[] = [];
  // The coarse image depends only on the downsample factor, and every rotation
  // of a template shares one, so build it at most once per factor.
  const coarseImages = new Map<number, GreyImage>();
  for (const deg of rotations) {
    const variant = rotateTemplate(tpl, deg);
    if (variant.width > img.width || variant.height > img.height) continue;
    const stats = patchStats(variant.data, variant.data.length);
    // A flat template correlates with nothing; its denominator is zero. Bail
    // rather than divide by it.
    if (stats.denom <= 0) continue;
    // Per ROTATED VARIANT, not once for the template as given. A 90-degree turn is an exact
    // permutation and cannot change the ink fraction, but an arbitrary angle can: the rotated
    // bounding box is larger (1.41x each side at 45 degrees, so 2x the area) and the same ink now
    // occupies half the fraction. Measured: computing this once from the unrotated template made
    // the gate reject EVERY window for a genuine 45-degree instance, which never showed up while
    // only right angles were searched.
    const density = inkFraction(variant.data, variant.width * variant.height, MATCH_INK_THRESHOLD);
    scanRotation(img, variant, stats, deg, minScore, inkRatioMin * density, found, coarseImages);
  }

  const suppressRadius = opts.suppressRadiusPx ?? Math.max(tpl.width, tpl.height) / 2;
  return suppressNonMaxima(found, suppressRadius, maxHits);
}

/** Fraction of `data[0..n)` darker than `threshold`. 0 for an empty patch. */
function inkFraction(data: Uint8Array, n: number, threshold: number): number {
  if (n <= 0) return 0;
  let count = 0;
  for (let i = 0; i < n; i++) if (data[i] < threshold) count++;
  return count / n;
}

/** Scan one rotated template over the image: coarse pass, then stride-1 refinement. */
function scanRotation(
  img: GreyImage,
  tpl: Template,
  tplStats: PatchStats,
  rotationDeg: number,
  minScore: number,
  minInkFrac: number,
  out: SymbolHit[],
  coarseImages: Map<number, GreyImage>
): void {
  const k = chooseCoarseFactor(tpl.width, tpl.height, img.width, img.height);

  if (k === 1) {
    // Template (or image) too small to downsample usefully — a stride-1 scan of
    // the whole image is cheap at this size, so just do it directly.
    const peaks = fullScan(img, tpl, tplStats, minScore, minInkFrac);
    for (const p of peaks) out.push({ ...p, rotationDeg });
    return;
  }

  let cImg = coarseImages.get(k);
  if (!cImg) {
    cImg = smoothDownsample(img, k);
    coarseImages.set(k, cImg);
  }
  const cTpl = smoothDownsample(tpl, k);
  const cStats = patchStats(cTpl.data, cTpl.data.length);
  if (cStats.denom <= 0) {
    // Downsampling flattened the symbol away (very fine detail). Fall back.
    const peaks = fullScan(img, tpl, tplStats, minScore, minInkFrac);
    for (const p of peaks) out.push({ ...p, rotationDeg });
    return;
  }

  const coarseMin = Math.max(COARSE_FLOOR, minScore - COARSE_SLACK);
  const candidates = coarsePeaks(cImg, cTpl, cStats, coarseMin);

  // Refine each coarse peak at stride 1 on the full-resolution image. A coarse
  // cell (cx, cy) corresponds to full-res (cx*k, cy*k) give or take a cell —
  // the true peak can be up to k-1 px inside the cell AND the smoothed coarse
  // response can crest one cell early or late, so the reach must cover 2k.
  const reach = 2 * k;
  const maxX = img.width - tpl.width;
  const maxY = img.height - tpl.height;
  const seen = new Set<number>();
  for (const c of candidates) {
    const cx = c.x * k;
    const cy = c.y * k;
    const x0 = clampInt(cx - reach, 0, maxX);
    const x1 = clampInt(cx + reach, 0, maxX);
    const y0 = clampInt(cy - reach, 0, maxY);
    const y1 = clampInt(cy + reach, 0, maxY);
    let best = -Infinity;
    let bx = x0;
    let by = y0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const s = nccAt(img, tpl, tplStats, x, y, minInkFrac);
        if (s > best) {
          best = s;
          bx = x;
          by = y;
        }
      }
    }
    if (best < minScore) continue;
    // Neighbouring coarse cells often refine onto the same full-res peak.
    const key = by * img.width + bx;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      x: bx + (tpl.width - 1) / 2,
      y: by + (tpl.height - 1) / 2,
      score: best,
      rotationDeg,
    });
  }
}

/**
 * Coarse pass: NCC of the downsampled template against every position of the
 * downsampled image, keeping local maxima above `coarseMin`.
 *
 * Window mean and variance come from integral images built over the SAME
 * downsampled pixels the correlation sum runs over — not a subsample, not the
 * full-resolution image. Mismatching those two pixel sets is the documented way
 * this algorithm silently fails.
 */
function coarsePeaks(
  img: GreyImage,
  tpl: Template,
  tplStats: PatchStats,
  coarseMin: number
): { x: number; y: number; score: number }[] {
  const { width: iw, height: ih } = img;
  const { width: tw, height: th } = tpl;
  const n = tw * th;
  const spanX = iw - tw;
  const spanY = ih - th;
  if (spanX < 0 || spanY < 0) return [];

  const integral = buildIntegral(img);
  // Standard deviation below which a window is treated as blank paper.
  const tplStd = tplStats.denom / n;
  const minStd = BLANK_STD_RATIO * tplStd;
  const minVarSum = minStd * minStd * n * n; // compare against `denom^2` to avoid a sqrt

  const scores = new Float32Array((spanX + 1) * (spanY + 1));
  for (let y = 0; y <= spanY; y++) {
    for (let x = 0; x <= spanX; x++) {
      const sums = windowSums(integral, iw, x, y, tw, th);
      const varSum = n * sums.sq - sums.sum * sums.sum;
      if (!(varSum > minVarSum)) continue; // early rejection: near-blank window
      // The window's OWN mean/variance, over exactly the pixels correlated below.
      let dot = 0;
      for (let ty = 0; ty < th; ty++) {
        let ii = (y + ty) * iw + x;
        let ti = ty * tw;
        for (let tx = 0; tx < tw; tx++) dot += tpl.data[ti++] * img.data[ii++];
      }
      const numer = n * dot - tplStats.sum * sums.sum;
      scores[y * (spanX + 1) + x] = numer / (tplStats.denom * Math.sqrt(varSum));
    }
  }

  // Local maxima only, so one blob does not spawn hundreds of candidates.
  const radius = Math.max(1, Math.floor(Math.max(tw, th) / 4));
  const peaks: { x: number; y: number; score: number }[] = [];
  const rowLen = spanX + 1;
  for (let y = 0; y <= spanY; y++) {
    for (let x = 0; x <= spanX; x++) {
      const s = scores[y * rowLen + x];
      if (s < coarseMin) continue;
      let isMax = true;
      const ny0 = Math.max(0, y - radius);
      const ny1 = Math.min(spanY, y + radius);
      const nx0 = Math.max(0, x - radius);
      const nx1 = Math.min(spanX, x + radius);
      for (let ny = ny0; ny <= ny1 && isMax; ny++) {
        for (let nx = nx0; nx <= nx1; nx++) {
          if (nx === x && ny === y) continue;
          const o = scores[ny * rowLen + nx];
          // Strict on one side, >= on the other, so a plateau keeps exactly its
          // first (top-left) cell. Deterministic.
          if (o > s || (o === s && (ny < y || (ny === y && nx < x)))) {
            isMax = false;
            break;
          }
        }
      }
      if (isMax) peaks.push({ x, y, score: s });
    }
  }

  if (peaks.length > MAX_CANDIDATES_PER_ROTATION) {
    peaks.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    peaks.length = MAX_CANDIDATES_PER_ROTATION;
  }
  return peaks;
}

/** Stride-1 scan of the whole image. Used when the template is too small to downsample. */
function fullScan(
  img: GreyImage,
  tpl: Template,
  tplStats: PatchStats,
  minScore: number,
  minInkFrac: number
): { x: number; y: number; score: number }[] {
  const spanX = img.width - tpl.width;
  const spanY = img.height - tpl.height;
  if (spanX < 0 || spanY < 0) return [];
  const n = tpl.width * tpl.height;
  const integral = buildIntegral(img);
  const tplStd = tplStats.denom / n;
  const minVarSum = BLANK_STD_RATIO * BLANK_STD_RATIO * tplStd * tplStd * n * n;

  const hits: { x: number; y: number; score: number }[] = [];
  for (let y = 0; y <= spanY; y++) {
    for (let x = 0; x <= spanX; x++) {
      const sums = windowSums(integral, img.width, x, y, tpl.width, tpl.height);
      const varSum = n * sums.sq - sums.sum * sums.sum;
      if (!(varSum > minVarSum) || varSum <= 0) continue;
      let dot = 0;
      let ink = 0;
      for (let ty = 0; ty < tpl.height; ty++) {
        let ii = (y + ty) * img.width + x;
        let ti = ty * tpl.width;
        for (let tx = 0; tx < tpl.width; tx++) {
          const v = img.data[ii++];
          if (v < MATCH_INK_THRESHOLD) ink++;
          dot += tpl.data[ti++] * v;
        }
      }
      // Ink gate: a window with far less ink than the template is not that symbol, however well
      // it correlates. minInkFrac is 0 whenever the gate is disabled or the template itself has no
      // ink, so this never rejects anything in either of those cases.
      if (ink / n < minInkFrac) continue;
      const score = (n * dot - tplStats.sum * sums.sum) / (tplStats.denom * Math.sqrt(varSum));
      if (score >= minScore) {
        hits.push({ x: x + (tpl.width - 1) / 2, y: y + (tpl.height - 1) / 2, score });
      }
    }
  }
  return hits;
}

/**
 * NCC of `tpl` against the window of `img` whose top-left is (x, y).
 *
 * The window's mean and standard deviation are computed here, in the same loop,
 * over exactly the pixels that feed the correlation sum. Never source them from
 * a different pixel set (a subsample, a wider patch, the whole image) — that
 * produces plausible-looking scores that are quietly meaningless.
 *
 * `minInkFrac` gates a window whose ink fraction falls short of it: such a window returns
 * -Infinity rather than its correlation, so it can never win the local "best" search below and can
 * never clear `minScore`. 0 (the disabled state) never rejects, since a fraction is never < 0.
 */
function nccAt(
  img: GreyImage,
  tpl: Template,
  tplStats: PatchStats,
  x: number,
  y: number,
  minInkFrac: number
): number {
  const { width: tw, height: th } = tpl;
  const n = tw * th;
  let sum = 0;
  let sq = 0;
  let dot = 0;
  let ink = 0;
  for (let ty = 0; ty < th; ty++) {
    let ii = (y + ty) * img.width + x;
    let ti = ty * tw;
    for (let tx = 0; tx < tw; tx++) {
      const v = img.data[ii++];
      if (v < MATCH_INK_THRESHOLD) ink++;
      sum += v;
      sq += v * v;
      dot += tpl.data[ti++] * v;
    }
  }
  if (ink / n < minInkFrac) return -Infinity;
  const varSum = n * sq - sum * sum;
  if (varSum <= 0) return 0; // flat window: no variance, no correlation, no NaN
  return (n * dot - tplStats.sum * sum) / (tplStats.denom * Math.sqrt(varSum));
}

// ---------------------------------------------------------------------------
// Non-maximum suppression
// ---------------------------------------------------------------------------

function suppressNonMaxima(hits: SymbolHit[], radius: number, maxHits: number): SymbolHit[] {
  const ordered = [...hits].sort(
    (a, b) => b.score - a.score || a.rotationDeg - b.rotationDeg || a.y - b.y || a.x - b.x
  );
  const r2 = radius * radius;
  const kept: SymbolHit[] = [];
  for (const h of ordered) {
    if (kept.length >= maxHits) break;
    let clash = false;
    for (const k of kept) {
      const dx = k.x - h.x;
      const dy = k.y - h.y;
      if (dx * dx + dy * dy <= r2) {
        clash = true;
        break;
      }
    }
    if (!clash) kept.push(h);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Pixel helpers
// ---------------------------------------------------------------------------

interface PatchStats {
  sum: number;
  /** n * standardDeviation, i.e. sqrt(n*sumSq - sum^2). Zero for a flat patch. */
  denom: number;
}

function patchStats(data: Uint8Array, n: number): PatchStats {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    sum += v;
    sq += v * v;
  }
  const varSum = n * sq - sum * sum;
  return { sum, denom: varSum > 0 ? Math.sqrt(varSum) : 0 };
}

/** Summed-area tables for value and value^2, sized (w+1) x (h+1). */
function buildIntegral(img: GreyImage): { sum: Float64Array; sq: Float64Array } {
  const w = img.width;
  const h = img.height;
  const stride = w + 1;
  const sum = new Float64Array(stride * (h + 1));
  const sq = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSq = 0;
    const src = y * w;
    const cur = (y + 1) * stride;
    const prev = y * stride;
    for (let x = 0; x < w; x++) {
      const v = img.data[src + x];
      rowSum += v;
      rowSq += v * v;
      sum[cur + x + 1] = sum[prev + x + 1] + rowSum;
      sq[cur + x + 1] = sq[prev + x + 1] + rowSq;
    }
  }
  return { sum, sq };
}

function windowSums(
  integral: { sum: Float64Array; sq: Float64Array },
  imgWidth: number,
  x: number,
  y: number,
  w: number,
  h: number
): { sum: number; sq: number } {
  const stride = imgWidth + 1;
  const a = y * stride + x;
  const b = y * stride + x + w;
  const c = (y + h) * stride + x;
  const d = (y + h) * stride + x + w;
  return {
    sum: integral.sum[d] - integral.sum[b] - integral.sum[c] + integral.sum[a],
    sq: integral.sq[d] - integral.sq[b] - integral.sq[c] + integral.sq[a],
  };
}

/**
 * Downsample by an integer factor, averaging over a window WIDER than the cell.
 *
 * A plain k x k box average is a bad anti-alias filter for line art, and that
 * is not a theoretical worry: with it, symbols whose true position was not a
 * multiple of k were silently lost by the coarse pass (a 1px stroke shifted 2px
 * lands in a different cell entirely, so the coarse patterns stop resembling
 * each other and the peak never clears the coarse threshold). Overlapping the
 * windows by a halo makes the coarse response vary smoothly as the symbol
 * shifts within a cell, which is the property the coarse pass actually needs.
 * `symbolMatch.test.ts` sweeps all k*k sub-cell offsets to hold this.
 *
 * Windows are clipped at the edges and divided by their true area, so border
 * cells stay comparable between image and template.
 */
function smoothDownsample(img: GreyImage, k: number): GreyImage {
  const w = Math.floor(img.width / k);
  const h = Math.floor(img.height / k);
  const halo = Math.max(1, Math.round(k / 2));
  const integral = buildIntegral(img);
  const stride = img.width + 1;
  const out = new Uint8Array(w * h);
  for (let cy = 0; cy < h; cy++) {
    const y0 = Math.max(0, cy * k - halo);
    const y1 = Math.min(img.height, cy * k + k + halo);
    for (let cx = 0; cx < w; cx++) {
      const x0 = Math.max(0, cx * k - halo);
      const x1 = Math.min(img.width, cx * k + k + halo);
      const sum =
        integral.sum[y1 * stride + x1] -
        integral.sum[y0 * stride + x1] -
        integral.sum[y1 * stride + x0] +
        integral.sum[y0 * stride + x0];
      out[cy * w + cx] = Math.round(sum / ((x1 - x0) * (y1 - y0)));
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Pick the coarse-pass downsample factor.
 *
 * Rationale: a naive stride-N scan of the sharp image misses peaks, because a
 * crisp thin-stroked symbol offset by 2px correlates poorly with itself. Box
 * averaging blurs the symbol so its response survives sub-cell offsets, which
 * is what makes the coarse pass safe to skip positions with. Aim for a coarse
 * template of roughly 8-16px on its short side.
 */
function chooseCoarseFactor(tw: number, th: number, iw: number, ih: number): number {
  const short = Math.min(tw, th);
  let k = clampInt(Math.floor(short / 8), 1, 4);
  // Never downsample so far that the coarse template loses all structure, or
  // that the coarse image cannot hold it.
  while (k > 1 && (Math.floor(short / k) < 3 || Math.floor(iw / k) < Math.floor(tw / k) || Math.floor(ih / k) < Math.floor(th / k))) {
    k--;
  }
  return k;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/** Rotate the template clockwise by `deg`. Multiples of 90 are exact permutations. */
function rotateTemplate(tpl: Template, deg: number): Template {
  const { data, width: w, height: h } = tpl;
  if (deg === 0) return { data, width: w, height: h };

  if (deg === 90 || deg === 180 || deg === 270) {
    const dw = deg === 180 ? w : h;
    const dh = deg === 180 ? h : w;
    const out = new Uint8Array(dw * dh);
    for (let dy = 0; dy < dh; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        let sx: number;
        let sy: number;
        if (deg === 90) {
          sx = dy;
          sy = h - 1 - dx;
        } else if (deg === 180) {
          sx = w - 1 - dx;
          sy = h - 1 - dy;
        } else {
          sx = w - 1 - dy;
          sy = dx;
        }
        out[dy * dw + dx] = data[sy * w + sx];
      }
    }
    return { data: out, width: dw, height: dh };
  }

  // Arbitrary angle: bilinear resample into the rotated bounding box. Pixels
  // that fall outside the source are filled with the template's mean so they
  // contribute nothing to the correlation numerator.
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dw = Math.max(1, Math.round(Math.abs(w * cos) + Math.abs(h * sin)));
  const dh = Math.max(1, Math.round(Math.abs(w * sin) + Math.abs(h * cos)));
  const fill = backgroundValue(data);
  const out = new Uint8Array(dw * dh);
  const scx = (w - 1) / 2;
  const scy = (h - 1) / 2;
  const dcx = (dw - 1) / 2;
  const dcy = (dh - 1) / 2;
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      // Inverse rotation (clockwise forward => counter-clockwise inverse).
      const ox = dx - dcx;
      const oy = dy - dcy;
      const sx = cos * ox + sin * oy + scx;
      const sy = -sin * ox + cos * oy + scy;
      out[dy * dw + dx] = sampleBilinear(data, w, h, sx, sy, fill);
    }
  }
  return { data: out, width: dw, height: dh };
}

/**
 * The template's BACKGROUND (paper) level: the 90th percentile of its values.
 *
 * This is what a rotation fills the corners of its bounding box with. Filling them with black would
 * paint a hard dark frame that correlates with whatever dark ink happens to sit near a candidate
 * window and wrecks the score; filling them with the MEAN paints a mid-grey wash that no real page
 * region matches. Paper is what actually surrounds a symbol on the sheet, and a symbol template is
 * mostly paper, so a high percentile of its own pixels is the paper value — measured, not assumed
 * (an explicit 255 would be wrong for the screened-back grey the architecture puts behind a symbol).
 */
function backgroundValue(data: Uint8Array): number {
  if (data.length === 0) return 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  const target = Math.floor(data.length * 0.9);
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen > target) return v;
  }
  return 255;
}

function sampleBilinear(
  data: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  fill: number
): number {
  if (x < -0.5 || y < -0.5 || x > w - 0.5 || y > h - 0.5) return Math.round(fill);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (px: number, py: number) =>
    px < 0 || py < 0 || px >= w || py >= h ? fill : data[py * w + px];
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return Math.round(Math.max(0, Math.min(255, top * (1 - fy) + bot * fy)));
}

// ---------------------------------------------------------------------------

function normaliseRotations(rotations: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const r of rotations) {
    if (!Number.isFinite(r)) continue;
    let d = r % 360;
    if (d < 0) d += 360;
    // Snap near-exact right angles so they take the exact permutation path.
    const snapped = Math.round(d / 90) * 90;
    if (Math.abs(d - snapped) < 1e-9) d = snapped % 360;
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

function isUsable(p: { width: number; height: number }): boolean {
  return (
    Number.isFinite(p.width) && Number.isFinite(p.height) && p.width > 0 && p.height > 0
  );
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
