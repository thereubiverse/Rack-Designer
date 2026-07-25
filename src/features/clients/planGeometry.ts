import type { WallRun } from "@/lib/supabase/types";

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

/** Group segments by the INFINITE LINE they lie on — angle θ plus perpendicular offset ρ — then
 *  merge overlapping/adjacent spans along each line. Rotation-invariant by construction: grouping
 *  by axis + position instead silently discards every wall in a rotated wing. */
export function buildWallRuns(segs: RawSeg[], W: number, H: number, opts: WallOpts = {}): WallRun[] {
  const o = { ...DEFAULTS, ...opts };
  const minLen = Math.max(W, H) * o.minLenFrac;

  const lines = new Map<string, { th: number; rho: number; spans: [number, number][] }>();
  for (const s of segs) {
    if (!s.grey) continue;
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    if (Math.hypot(dx, dy) < 0.5) continue;
    // θ in [0, π): a segment and its reverse describe the same line.
    let th = Math.atan2(dy, dx);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - 1e-9) th = 0;
    const rho = s.a[0] * Math.sin(th) - s.a[1] * Math.cos(th);
    const key = `${Math.round(th / o.thetaBucketRad)}_${Math.round(rho / o.rhoBucketPx)}`;
    let entry = lines.get(key);
    if (!entry) { entry = { th, rho, spans: [] }; lines.set(key, entry); }
    // Project both endpoints onto the line direction to get a 1-D span.
    const ux = Math.cos(th), uy = Math.sin(th);
    const p = s.a[0] * ux + s.a[1] * uy, q = s.b[0] * ux + s.b[1] * uy;
    entry.spans.push([Math.min(p, q), Math.max(p, q)]);
  }

  const runs: WallRun[] = [];
  for (const { th, rho, spans } of lines.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    const ux = Math.cos(th), uy = Math.sin(th), nx = Math.sin(th), ny = -Math.cos(th);
    let [cs, ce] = spans[0];
    const flush = () => {
      if (ce - cs >= minLen) {
        runs.push({
          x1: ux * cs + nx * rho, y1: uy * cs + ny * rho,
          x2: ux * ce + nx * rho, y2: uy * ce + ny * rho,
        });
      }
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

/** Pixels → normalized 0..1 over the page, clamped. `0` is a real coordinate, never "missing". */
export function normalizeRuns(runs: WallRun[], W: number, H: number): WallRun[] {
  return runs.map((r) => ({
    x1: clamp01(r.x1 / W), y1: clamp01(r.y1 / H),
    x2: clamp01(r.x2 / W), y2: clamp01(r.y2 / H),
  }));
}
