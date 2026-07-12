import { describe, it, expect } from "vitest";
import {
  spanOf, canPlace, findFreeSlot, nextCode, resolveMove, validateDeviceCode, minRackHeight,
  fitScale, clampPan, type PlacementLike,
} from "./rackOps";

const ru = { t1: 1, t2: 2 }; // template heights
const p = (id: string, tid: string, code: string, startU: number): PlacementLike =>
  ({ id, deviceTemplateId: tid, code, startU });

describe("spanOf", () => {
  it("computes bottom/top from startU and template height", () => {
    expect(spanOf(p("a", "t2", "SW01", 5), ru)).toEqual({ bottom: 5, top: 6 });
    expect(spanOf(p("a", "t1", "SW01", 1), ru)).toEqual({ bottom: 1, top: 1 });
  });
});

describe("canPlace", () => {
  const placed = [p("a", "t2", "SW01", 5)]; // occupies 5-6
  it("accepts a free, in-bounds span", () => {
    expect(canPlace(placed, ru, 1, 1, 12)).toBe(true);
    expect(canPlace(placed, ru, 7, 2, 12)).toBe(true);
  });
  it("rejects overlaps and out-of-bounds", () => {
    expect(canPlace(placed, ru, 6, 1, 12)).toBe(false);  // overlaps top of a
    expect(canPlace(placed, ru, 4, 2, 12)).toBe(false);  // 4-5 overlaps bottom
    expect(canPlace(placed, ru, 12, 2, 12)).toBe(false); // 12-13 exceeds rack
    expect(canPlace(placed, ru, 0, 1, 12)).toBe(false);  // below U1
  });
  it("ignores the moving device itself via ignoreId", () => {
    expect(canPlace(placed, ru, 5, 2, 12, "a")).toBe(true);
  });
});

describe("findFreeSlot", () => {
  const placed = [p("a", "t2", "SW01", 5), p("b", "t1", "PP01", 1)];
  it("prefers the requested U when legal, else nearest free slot, else null", () => {
    expect(findFreeSlot(placed, ru, 1, 12, 3)).toBe(3);
    expect(findFreeSlot(placed, ru, 1, 12, 5)).toBe(4);            // 5 occupied → nearest
    expect(findFreeSlot([p("x", "t2", "A01", 1)], ru, 2, 2)).toBeNull(); // full rack
  });
});

describe("nextCode", () => {
  it("increments per type code and reuses gaps", () => {
    expect(nextCode([], "SW")).toBe("SW01");
    expect(nextCode([p("a", "t1", "SW01", 1), p("b", "t1", "SW03", 3)], "SW")).toBe("SW02");
    expect(nextCode([p("a", "t1", "PP01", 1)], "SW")).toBe("SW01");
  });
});

describe("resolveMove", () => {
  const placed = [p("a", "t2", "SW01", 5), p("b", "t1", "PP01", 8)];
  it("returns the target when legal, clamps into the rack, keeps position when blocked", () => {
    expect(resolveMove(placed, ru, "a", 2, 12)).toBe(2);
    expect(resolveMove(placed, ru, "a", 14, 12)).toBe(11); // clamped so 2U fits
    expect(resolveMove(placed, ru, "a", 8, 12)).toBe(5);   // 8-9 blocked by b → stay
  });
});

describe("validateDeviceCode", () => {
  it("enforces uppercase alphanumeric/underscore/hyphen, 1-10 chars", () => {
    expect(validateDeviceCode("SW01")).toBeNull();
    expect(validateDeviceCode("RK001_M")).toBeNull();
    expect(validateDeviceCode("")).not.toBeNull();
    expect(validateDeviceCode("sw01")).not.toBeNull();
    expect(validateDeviceCode("HAS SPACE")).not.toBeNull();
    expect(validateDeviceCode("ELEVENCHARS")).not.toBeNull();
  });
});

describe("minRackHeight", () => {
  it("is the highest occupied U, 0 when empty", () => {
    expect(minRackHeight([], ru)).toBe(0);
    expect(minRackHeight([p("a", "t2", "SW01", 5)], ru)).toBe(6);
  });
});

describe("fitScale", () => {
  it("width mode fills the viewport width (rack scrolls vertically)", () => {
    // 2000-wide rack in a 1000×1000 box (margin 16): (1000-32)/2000 = 0.484.
    expect(fitScale("width", 1000, 1000, 2000, 800)).toBeCloseTo(0.484, 3);
  });
  it("height mode fits the whole rack in the viewport height", () => {
    // 2000-tall rack: (1000-32)/2000 = 0.484 regardless of width.
    expect(fitScale("height", 1000, 1000, 500, 2000)).toBeCloseTo(0.484, 3);
  });
  it("width and height modes differ for a non-square rack", () => {
    const w = fitScale("width", 1000, 1000, 500, 2000);   // (1000-32)/500 = 1.936
    const h = fitScale("height", 1000, 1000, 500, 2000);  // (1000-32)/2000 = 0.484
    expect(w).toBeCloseTo(1.936, 3);
    expect(h).toBeCloseTo(0.484, 3);
  });
  it("returns 1 for a degenerate (too-small) box", () => {
    expect(fitScale("width", 10, 10, 500, 500)).toBe(1);
    expect(fitScale("height", 10, 10, 500, 500)).toBe(1);
  });
});

describe("clampPan", () => {
  it("keeps a `margin` sliver of a large (overflowing) rack on-screen in both directions", () => {
    // 2000-tall content in a 500×500 view (margin 48): x/y clamp to [48-2000, 500-48].
    expect(clampPan(9999, 9999, 500, 500, 2000, 2000, 48)).toEqual({ x: 452, y: 452 });
    expect(clampPan(-9999, -9999, 500, 500, 2000, 2000, 48)).toEqual({ x: -1952, y: -1952 });
  });
  it("allows free panning within the range for a large rack (no clamp when in-bounds)", () => {
    expect(clampPan(-300, 100, 500, 500, 2000, 2000, 48)).toEqual({ x: -300, y: 100 });
  });
  it("lets a small rack pan across the viewport (clamps to the reachable edges)", () => {
    // 100-wide content in a 500 view (margin 48): range [48-100, 500-48] = [-52, 452].
    expect(clampPan(999, 999, 500, 500, 100, 100, 48)).toEqual({ x: 452, y: 452 });
    expect(clampPan(-999, -999, 500, 500, 100, 100, 48)).toEqual({ x: -52, y: -52 });
  });
  it("centres instead of inverting when the viewport is smaller than the keep-visible band", () => {
    // view 50, content 10, margin 48 → band collapses (lo>hi) → pin to centre (50-10)/2 = 20.
    expect(clampPan(999, -999, 50, 50, 10, 10, 48)).toEqual({ x: 20, y: 20 });
  });
});
