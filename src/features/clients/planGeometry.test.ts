import { describe, it, expect } from "vitest";
import { buildWallRuns, normalizeRuns, MAX_WALL_RUNS } from "./planGeometry";

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
