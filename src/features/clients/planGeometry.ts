import type { WallRun } from "@/lib/supabase/types";
import type { NormPoint } from "./floorPlanOps";

export interface RawSeg { a: [number, number]; b: [number, number]; grey: boolean }
export interface WallOpts {
  minLenFrac?: number;
  mergeGapPx?: number;
  thetaBucketRad?: number;
  rhoBucketPx?: number;
}

/** Bounded so a pathological sheet cannot produce an unbounded payload. */
export const MAX_WALL_RUNS = 4000;

// Tuned on the real sheet (see the spec's §5.4 table): 94.9% of hand-traced room edges land
// within 6px of an extracted run, at ~1,013 runs.
const DEFAULTS: Required<WallOpts> = {
  minLenFrac: 0.010,
  mergeGapPx: 6,
  thetaBucketRad: Math.PI / 180, // 1 degree
  rhoBucketPx: 1.5,
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** The infinite-line parameterisation shared by `buildWallRuns` (grouping raw segments onto
 *  infinite lines) and `collapseWallPairs` (comparing already-built runs for wall-face pairing):
 *  angle θ normalised to [0, π), perpendicular offset ρ, and the endpoints' projections s/e (the
 *  1-D span) onto the line direction. A segment and its reverse describe the same line, which is
 *  why θ is folded into [0, π) rather than the full [0, 2π) atan2 range. */
interface LineParams { th: number; rho: number; s: number; e: number; len: number }

function toLineParams(ax: number, ay: number, bx: number, by: number): LineParams {
  const dx = bx - ax, dy = by - ay;
  let th = Math.atan2(dy, dx);
  if (th < 0) th += Math.PI;
  if (th >= Math.PI - 1e-9) th = 0;
  const rho = ax * Math.sin(th) - ay * Math.cos(th);
  const ux = Math.cos(th), uy = Math.sin(th);
  const p = ax * ux + ay * uy, q = bx * ux + by * uy;
  const s = Math.min(p, q), e = Math.max(p, q);
  return { th, rho, s, e, len: e - s };
}

/** Inverse of `toLineParams`: turns a (θ, ρ, s, e) line description back into pixel endpoints. */
function runFromLineParams(th: number, rho: number, s: number, e: number): WallRun {
  const ux = Math.cos(th), uy = Math.sin(th), nx = Math.sin(th), ny = -Math.cos(th);
  return {
    x1: ux * s + nx * rho, y1: uy * s + ny * rho,
    x2: ux * e + nx * rho, y2: uy * e + ny * rho,
  };
}

/** Group segments by the INFINITE LINE they lie on — angle θ plus perpendicular offset ρ — then
 *  merge overlapping/adjacent spans along each line. Rotation-invariant by construction: grouping
 *  by axis + position instead silently discards every wall in a rotated wing. */
export function buildWallRuns(segs: RawSeg[], W: number, H: number, opts: WallOpts = {}): WallRun[] {
  const o = { ...DEFAULTS, ...opts };
  const minLen = Math.max(W, H) * o.minLenFrac;

  const lines = new Map<string, { th: number; rho: number; spans: [number, number][] }>();
  for (const s of segs) {
    if (!s.grey) continue;
    const lp = toLineParams(s.a[0], s.a[1], s.b[0], s.b[1]);
    if (lp.len < 0.5) continue;
    let th = lp.th, rho = lp.rho, spanLo = lp.s, spanHi = lp.e;
    // A line at (θ, ρ) is the same line as (θ−π, −ρ). Without folding, a near-horizontal wall whose
    // segments have sign-flipping dy noise straddles the [0, π) seam — θ≈179.97° and θ≈0.017° describe
    // one wall but land 180 buckets apart and can never merge. Folding θ reverses the span direction
    // too, so s/e swap and negate along with it.
    if (th >= Math.PI - o.thetaBucketRad / 2) { th -= Math.PI; rho = -rho; spanLo = -lp.e; spanHi = -lp.s; }
    const key = `${Math.round(th / o.thetaBucketRad)}_${Math.round(rho / o.rhoBucketPx)}`;
    let entry = lines.get(key);
    if (!entry) { entry = { th, rho, spans: [] }; lines.set(key, entry); }
    entry.spans.push([spanLo, spanHi]);
  }

  const runs: WallRun[] = [];
  for (const { th, rho, spans } of lines.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let [cs, ce] = spans[0];
    const flush = () => {
      if (ce - cs >= minLen) runs.push(runFromLineParams(th, rho, cs, ce));
    };
    for (let i = 1; i < spans.length; i++) {
      if (spans[i][0] <= ce + o.mergeGapPx) ce = Math.max(ce, spans[i][1]);
      else { flush(); [cs, ce] = spans[i]; }
    }
    flush();
    if (runs.length >= MAX_WALL_RUNS) break;
  }
  return runs.slice(0, MAX_WALL_RUNS);
}

export interface CollapseOpts { maxGapFrac?: number; thetaTolRad?: number; minOverlapFrac?: number }

// Measured on the real sheet (2600×1733, 1,014 runs): gap-to-nearest-parallel-partner p10=0.9px,
// p50=2.8px, p90=55.1px. 5-15px is real wall thickness at this drawing's scale; 0-5px is duplicate
// linework (same edge drawn twice); beyond ~20px is two distinct walls across a gap. 14px on this
// 2600px sheet (706 runs, 95.3% coverage @6px on the hand-traced rooms) is the chosen cutoff,
// expressed as a fraction of the sheet's long edge so it scales to other sheet sizes.
const COLLAPSE_DEFAULTS: Required<CollapseOpts> = {
  maxGapFrac: 14 / 2600,
  thetaTolRad: (2 * Math.PI) / 180,
  minOverlapFrac: 0.5,
};

/** Fold `b`'s line parameters onto the same θ branch as `aTh` when they sit on opposite sides of
 *  the [0, π) seam (e.g. aTh≈0.01, b.th≈π−0.01 describe near-identical orientations but land ~π
 *  apart in raw θ). Folding negates ρ and reverses the projection axis, so the span endpoints swap
 *  and negate too. Without this, two genuinely-matching near-horizontal wall faces can have their
 *  ρ computed on opposite sides of the atan2 cut and compare as wildly far apart when they are not. */
function alignToBranch(aTh: number, b: LineParams): LineParams {
  let { th, rho, s, e } = b;
  if (aTh - th > Math.PI / 2) { th += Math.PI; rho = -rho; [s, e] = [-e, -s]; }
  else if (aTh - th < -Math.PI / 2) { th -= Math.PI; rho = -rho; [s, e] = [-e, -s]; }
  return { th, rho, s, e, len: b.len };
}

/** Collapse pairs of parallel, overlapping wall runs — the two poché faces of one wall — onto a
 *  single centreline run. Walls are drawn as two parallel outlines with hatching between them; the
 *  extractor emits both faces as separate runs, doubling the snap-target density for no benefit.
 *
 *  Runs are processed longest-first so a wall's full-length face claims its true partner before a
 *  short stub (e.g. a jamb return or a linework fragment) gets a chance to steal it — greedy
 *  claiming is order-dependent, and processing shortest-first can let a stub grab one of a mutually-
 *  matching pair, stranding the other. Each run is claimed by at most one partner. */
export function collapseWallPairs(runs: WallRun[], W: number, H: number, opts: CollapseOpts = {}): WallRun[] {
  const o = { ...COLLAPSE_DEFAULTS, ...opts };
  const maxGap = o.maxGapFrac * Math.max(W, H);

  const items = runs.map((r) => ({ run: r, ...toLineParams(r.x1, r.y1, r.x2, r.y2) }));
  const order = items.map((_, i) => i).sort((i, j) => items[j].len - items[i].len);
  const claimed = new Array(items.length).fill(false);
  const out: WallRun[] = [];

  for (const i of order) {
    if (claimed[i]) continue;
    const a = items[i];
    let bestJ = -1;
    let bestGap = Infinity;
    let bestMerge: { rho: number; s: number; e: number } | null = null;

    for (let j = 0; j < items.length; j++) {
      if (j === i || claimed[j]) continue;
      const b = alignToBranch(a.th, items[j]);
      if (Math.abs(a.th - b.th) > o.thetaTolRad) continue;
      const gap = Math.abs(a.rho - b.rho);
      if (gap > maxGap) continue;
      const overlap = Math.min(a.e, b.e) - Math.max(a.s, b.s);
      const shorterLen = Math.min(a.len, items[j].len);
      if (overlap < o.minOverlapFrac * shorterLen) continue;
      if (gap < bestGap) {
        bestGap = gap;
        bestJ = j;
        bestMerge = { rho: (a.rho + b.rho) / 2, s: Math.min(a.s, b.s), e: Math.max(a.e, b.e) };
      }
    }

    if (bestJ >= 0 && bestMerge) {
      claimed[i] = true;
      claimed[bestJ] = true;
      out.push(runFromLineParams(a.th, bestMerge.rho, bestMerge.s, bestMerge.e));
    } else {
      claimed[i] = true;
      out.push(a.run);
    }
  }
  return out;
}

/** Pixels → normalized 0..1 over the page, clamped. `0` is a real coordinate, never "missing". */
export function normalizeRuns(runs: WallRun[], W: number, H: number): WallRun[] {
  return runs.map((r) => ({
    x1: clamp01(r.x1 / W), y1: clamp01(r.y1 / H),
    x2: clamp01(r.x2 / W), y2: clamp01(r.y2 / H),
  }));
}

export interface CornerOpts { nearPx?: number; dedupePx?: number; maxCorners?: number }

// nearPx=12: walls that meet at a real corner routinely stop a few pixels short of touching —
// extraction sees the poché boundary, not an idealised drafting intent. Rejecting anything that
// doesn't touch exactly loses real corners (see planGeometry.test.ts's "6px short" case). dedupePx=6
// matches the poché-face gap tuning in COLLAPSE_DEFAULTS above: two intersections closer than that
// are the same corner computed from different (already-doubled) wall faces, not two distinct corners.
const CORNER_DEFAULTS: Required<CornerOpts> = {
  nearPx: 12,
  dedupePx: 6,
  maxCorners: 4000,
};

// Below this, treat two runs as parallel: their intersection is numerically unstable and, if used,
// lands far off-page. This is sin(angle-between) — the cross product of the two UNIT direction
// vectors — so it is scale-independent, unlike a raw cross-product epsilon which would need
// re-tuning for every sheet size.
const PARALLEL_SIN_EPS = 1e-6;

/** Intersections of the wall runs — the actual room corners. A run's ENDPOINT is wherever
 *  extraction stopped, often mid-wall; a corner is where two walls cross.
 *
 *  O(n²) over every pair of runs — 704 runs is ~247k pairs, fine as a one-off but NOT something to
 *  call on every pointer move. Callers must memoise this, keyed on the run list. */
export function deriveWallCorners(runs: WallRun[], W: number, H: number, opts: CornerOpts = {}): NormPoint[] {
  const o = { ...CORNER_DEFAULTS, ...opts };
  // Keyed on a `dedupePx` pixel grid cell; the first intersection to land in a cell wins and later
  // ones in the same cell are dropped — cheap O(1) de-duplication without a distance search.
  const cells = new Map<string, [number, number]>();

  outer: for (let i = 0; i < runs.length; i++) {
    const a = runs[i];
    const ax = a.x2 - a.x1, ay = a.y2 - a.y1;
    const aLen = Math.hypot(ax, ay);
    if (aLen < 1e-9) continue;

    for (let j = i + 1; j < runs.length; j++) {
      const b = runs[j];
      const bx = b.x2 - b.x1, by = b.y2 - b.y1;
      const bLen = Math.hypot(bx, by);
      if (bLen < 1e-9) continue;

      const denom = ax * by - ay * bx;
      const sinAngle = denom / (aLen * bLen);
      if (Math.abs(sinAngle) < PARALLEL_SIN_EPS) continue; // near-parallel: skip before dividing by denom

      const dx = b.x1 - a.x1, dy = b.y1 - a.y1;
      const t = (dx * by - dy * bx) / denom; // param along a, 0..1 is on-segment
      const u = (dx * ay - dy * ax) / denom; // param along b, 0..1 is on-segment

      const tOvershoot = o.nearPx / aLen;
      const uOvershoot = o.nearPx / bLen;
      if (t < -tOvershoot || t > 1 + tOvershoot) continue;
      if (u < -uOvershoot || u > 1 + uOvershoot) continue;

      const px = a.x1 + t * ax;
      const py = a.y1 + t * ay;

      const key = `${Math.round(px / o.dedupePx)}_${Math.round(py / o.dedupePx)}`;
      if (!cells.has(key)) {
        cells.set(key, [px, py]);
        if (cells.size >= o.maxCorners) break outer;
      }
    }
  }

  return Array.from(cells.values(), ([px, py]): NormPoint => [clamp01(px / W), clamp01(py / H)]);
}
