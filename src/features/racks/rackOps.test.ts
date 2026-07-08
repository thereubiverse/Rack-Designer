import { describe, it, expect } from "vitest";
import {
  spanOf, canPlace, findFreeSlot, nextCode, resolveMove, validateDeviceCode, minRackHeight,
  type PlacementLike,
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
