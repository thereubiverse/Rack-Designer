import { describe, it, expect } from "vitest";
import { buildWallRuns, collapseWallPairs, normalizeRuns, MAX_WALL_RUNS } from "./planGeometry";
import type { WallRun } from "@/lib/supabase/types";

const seg = (ax: number, ay: number, bx: number, by: number, grey = true) =>
  ({ a: [ax, ay] as [number, number], b: [bx, by] as [number, number], grey });

describe("buildWallRuns", () => {
  it("merges co-linear touching segments into one run", () => {
    const out = buildWallRuns([seg(0, 0, 50, 0), seg(50, 0, 100, 0)], 1000, 1000, { minLenFrac: 0.01 });
    expect(out).toHaveLength(1);
    expect(out[0].x1).toBeCloseTo(0, 1);
    expect(out[0].x2).toBeCloseTo(100, 1);
  });

  it("keeps ANGLED walls — the rotated-wing regression", () => {
    // A 45-degree wall. Axis-aligned grouping would discard this entirely.
    const out = buildWallRuns([seg(0, 0, 70, 70), seg(70, 70, 140, 140)], 1000, 1000, { minLenFrac: 0.01 });
    expect(out).toHaveLength(1);
    expect(Math.hypot(out[0].x2 - out[0].x1, out[0].y2 - out[0].y1)).toBeGreaterThan(190);
  });

  it("does NOT merge parallel segments on different lines", () => {
    const out = buildWallRuns([seg(0, 0, 100, 0), seg(0, 40, 100, 40)], 1000, 1000, { minLenFrac: 0.01 });
    expect(out).toHaveLength(2);
  });

  it("does NOT merge co-linear segments separated by more than the gap", () => {
    const out = buildWallRuns([seg(0, 0, 50, 0), seg(300, 0, 400, 0)], 1000, 1000,
      { minLenFrac: 0.01, mergeGapPx: 6 });
    expect(out).toHaveLength(2);
  });

  it("drops runs shorter than minLenFrac of the long edge", () => {
    const out = buildWallRuns([seg(0, 0, 5, 0)], 1000, 1000, { minLenFrac: 0.01 }); // 5px < 10px
    expect(out).toEqual([]);
  });

  it("ignores non-grey segments — walls live in the screened-back class", () => {
    const out = buildWallRuns([seg(0, 0, 100, 0, false)], 1000, 1000, { minLenFrac: 0.01 });
    expect(out).toEqual([]);
  });

  it("never throws on degenerate input and caps the output", () => {
    expect(buildWallRuns([], 1000, 1000)).toEqual([]);
    expect(buildWallRuns([seg(5, 5, 5, 5)], 1000, 1000)).toEqual([]); // zero length
    const many = Array.from({ length: MAX_WALL_RUNS + 500 }, (_, i) => seg(0, i * 3, 900, i * 3));
    expect(buildWallRuns(many, 1000, 20000, { minLenFrac: 0.001 }).length).toBeLessThanOrEqual(MAX_WALL_RUNS);
  });

  it("merges near-horizontal segments across the θ=0/π wraparound seam", () => {
    // Both segments belong to the same nearly-horizontal wall, but sign-flipping dy noise
    // (a realistic vector-path rounding artifact) pushes the first segment's angle to just
    // under 180° and the second's to just over 0° -- 180 buckets apart without folding.
    const out = buildWallRuns(
      [seg(0, 0, 1000, -0.05), seg(1000, -0.05, 2000, 0)],
      3000, 3000,
      { minLenFrac: 0.01 },
    );
    expect(out).toHaveLength(1);
    expect(Math.hypot(out[0].x2 - out[0].x1, out[0].y2 - out[0].y1)).toBeCloseTo(2000, 0);
  });

  it("round-trips a folded segment's endpoints", () => {
    // θ for this segment normalizes to ~179.97°, which folds to ~-0.029°. The emitted
    // endpoints must still land on the original segment -- the ρ negation on fold must not
    // mirror the wall to the wrong side of the page.
    const out = buildWallRuns([seg(0, 0, 1000, -0.5)], 3000, 3000, { minLenFrac: 0.01 });
    expect(out).toHaveLength(1);
    expect(out[0].x1).toBeCloseTo(0, 0);
    expect(out[0].y1).toBeCloseTo(0, 0);
    expect(out[0].x2).toBeCloseTo(1000, 0);
    expect(out[0].y2).toBeCloseTo(-0.5, 0);
  });

  it("merges near-vertical segments with sign-flipping dx noise (no seam here to fold)", () => {
    // θ≈90° is nowhere near the [0,π) wrap boundary, so this was never broken -- included as a
    // cheap sanity check that the horizontal-seam fold didn't regress vertical walls.
    const out = buildWallRuns(
      [seg(0, 0, -0.05, 1000), seg(-0.05, 1000, 0, 2000)],
      3000, 3000,
      { minLenFrac: 0.01 },
    );
    expect(out).toHaveLength(1);
    expect(Math.hypot(out[0].x2 - out[0].x1, out[0].y2 - out[0].y1)).toBeCloseTo(2000, 0);
  });
});

describe("normalizeRuns", () => {
  it("maps pixels to 0..1 and keeps the 0 edge", () => {
    const out = normalizeRuns([{ x1: 0, y1: 0, x2: 500, y2: 250 }], 1000, 500);
    expect(out[0]).toEqual({ x1: 0, y1: 0, x2: 0.5, y2: 0.5 });
  });
  it("clamps out-of-page coordinates into range", () => {
    const out = normalizeRuns([{ x1: -50, y1: 0, x2: 2000, y2: 250 }], 1000, 500);
    expect(out[0].x1).toBe(0);
    expect(out[0].x2).toBe(1);
  });
});

describe("collapseWallPairs", () => {
  const run = (x1: number, y1: number, x2: number, y2: number): WallRun => ({ x1, y1, x2, y2 });

  it("collapses two parallel faces onto the centreline", () => {
    // Two horizontal runs 10px apart, fully overlapping in x.
    const a = run(0, 0, 100, 0);
    const b = run(0, 10, 100, 10);
    const out = collapseWallPairs([a, b], 2600, 2600);
    expect(out).toHaveLength(1);
    // Exact centre coordinate: midpoint of y=0 and y=10.
    expect(out[0].x1).toBeCloseTo(0, 6);
    expect(out[0].y1).toBeCloseTo(5, 6);
    expect(out[0].x2).toBeCloseTo(100, 6);
    expect(out[0].y2).toBeCloseTo(5, 6);
  });

  it("does NOT collapse distant parallels (60px apart, beyond the 14px threshold on a 2600px sheet)", () => {
    const a = run(0, 0, 100, 0);
    const b = run(0, 60, 100, 60);
    const out = collapseWallPairs([a, b], 2600, 2600);
    expect(out).toHaveLength(2);
  });

  it("does NOT collapse parallel runs whose spans don't overlap", () => {
    const a = run(0, 0, 50, 0);
    const b = run(100, 10, 150, 10);
    const out = collapseWallPairs([a, b], 2600, 2600);
    expect(out).toHaveLength(2);
  });

  it("passes a lone wall through unchanged", () => {
    const a = run(12, 34, 200, 34);
    const out = collapseWallPairs([a], 2600, 2600);
    expect(out).toEqual([a]);
  });

  it("collapses angled (45-degree) wall faces onto the centreline, preserving the angle", () => {
    // Two parallel 45-degree runs (y = x, and y = x + 10*sqrt(2), i.e. 10px perpendicular apart).
    const offset = 10 * Math.sqrt(2);
    const a = run(0, 0, 100, 100);
    const b = run(0, offset, 100, 100 + offset);
    const out = collapseWallPairs([a, b], 2600, 2600);
    expect(out).toHaveLength(1);
    // Still at 45 degrees: dx ≈ dy.
    expect(out[0].x2 - out[0].x1).toBeCloseTo(out[0].y2 - out[0].y1, 6);
    // Centreline sits halfway between the two faces (offset/2 above y = x).
    expect(out[0].y1 - out[0].x1).toBeCloseTo(offset / 2, 6);
    expect(out[0].y2 - out[0].x2).toBeCloseTo(offset / 2, 6);
  });

  it("claims the long partner before a short stub steals it (longest-first)", () => {
    // Long face A (y=0) and its true long partner B (y=15) are mutually closest to each other.
    // Short stub C (y=40) is within threshold of both, but farther from A than B is, and farther
    // from B than A is -- if C were processed first it could steal B, leaving A unpaired.
    const a = run(0, 0, 200, 0);
    const b = run(0, 15, 200, 15);
    const c = run(80, 40, 100, 40);
    const out = collapseWallPairs([a, b, c], 2600, 2600, { maxGapFrac: 50 / 2600 });
    expect(out).toHaveLength(2);
    const merged = out.find((r) => Math.abs(r.x2 - r.x1) === 200)!;
    const stub = out.find((r) => Math.abs(r.x2 - r.x1) === 20)!;
    expect(merged).toBeDefined();
    expect(stub).toBeDefined();
    // The merged run must be A+B (centre y=7.5), NOT B+C (centre y=27.5).
    expect(merged.y1).toBeCloseTo(7.5, 6);
    expect(merged.y2).toBeCloseTo(7.5, 6);
    // The stub survives at its original position, unmerged.
    expect(stub.y1).toBeCloseTo(40, 6);
  });

  it("pairs each run at most once (three parallel runs collapse to two, not one or three)", () => {
    const a = run(0, 0, 100, 0);
    const b = run(0, 5, 100, 5);
    const c = run(0, 10, 100, 10);
    const out = collapseWallPairs([a, b, c], 2600, 2600);
    expect(out).toHaveLength(2);
  });

  it("collapses two wall faces whose θ straddles the [0, π) seam", () => {
    // Both runs describe near-perfectly-horizontal wall faces ~10px apart (real wall thickness),
    // but sign-flipping sub-pixel dy noise pushes their independently-computed θ to opposite sides
    // of atan2's [0, π) cut: `a`'s dy is slightly negative (dx>0, dy<0 -> atan2 negative -> folds to
    // just UNDER π), `b`'s dy is slightly positive (dx>0, dy>0 -> atan2 positive, no fold -> just
    // OVER 0). Without aligning them onto a common θ branch before comparing ρ, these look like two
    // unrelated near-antiparallel lines and never collapse -- the same class of bug that cost 36
    // points of edge coverage earlier in this slice (and needed its own fix in buildWallRuns).
    const a = run(0, 0, 1000, -0.05);
    const b = run(0, 10, 1000, 10.05);
    const out = collapseWallPairs([a, b], 2600, 2600);
    expect(out).toHaveLength(1);
    const y1 = out[0].y1, y2 = out[0].y2;
    const x1 = out[0].x1, x2 = out[0].x2;
    expect(Math.min(x1, x2)).toBeCloseTo(0, 0);
    expect(Math.max(x1, x2)).toBeCloseTo(1000, 0);
    // Centreline sits at the midpoint of the two faces (~y=5), not collapsed onto either face.
    expect(y1).toBeCloseTo(5, 0);
    expect(y2).toBeCloseTo(5, 0);
  });
});
