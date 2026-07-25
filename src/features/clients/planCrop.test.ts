import { describe, it, expect } from "vitest";
import { toCropRect, cropPointToFull, cropToPixels } from "./planCrop";

describe("toCropRect", () => {
  it("accepts a plausible drawing-area box", () => {
    // The real locate response measured on the CELLAR sheet.
    expect(toCropRect({ x: 0.181, y: 0.262, w: 0.476, h: 0.592 }))
      .toEqual({ x: 0.181, y: 0.262, w: 0.476, h: 0.592 });
  });

  it("clamps an overshooting extent to what remains of the sheet", () => {
    // The prompt tells the model to err large, so this is the expected shape of a miss.
    const c = toCropRect({ x: 0.7, y: 0.5, w: 0.9, h: 0.9 });
    expect(c).toEqual({ x: 0.7, y: 0.5, w: 0.30000000000000004, h: 0.5 });
  });

  it("falls back to null for a box too small to trust", () => {
    // Cropping to this would likely clip rooms out of the pass entirely.
    expect(toCropRect({ x: 0.4, y: 0.4, w: 0.1, h: 0.1 })).toBeNull();
  });

  it("falls back to null for a degenerate sliver even when its area looks fine", () => {
    expect(toCropRect({ x: 0, y: 0, w: 0.05, h: 1 })).toBeNull();
  });

  it("falls back to null when the box is the whole sheet (nothing to gain)", () => {
    expect(toCropRect({ x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it("never throws on garbage, returning null so the caller uses the full image", () => {
    for (const bad of [null, undefined, "x", 42, {}, { x: 0, y: 0, w: "wide", h: 0.5 }, { x: NaN, y: 0, w: 0.5, h: 0.5 }]) {
      expect(toCropRect(bad)).toBeNull();
    }
  });
});

describe("cropPointToFull", () => {
  const crop = { x: 0.2, y: 0.25, w: 0.5, h: 0.5 };

  it("maps the crop's own corners back onto the sheet", () => {
    expect(cropPointToFull([0, 0], crop)).toEqual([0.2, 0.25]);
    expect(cropPointToFull([1, 1], crop)).toEqual([0.7, 0.75]);
  });

  it("maps an interior point proportionally", () => {
    expect(cropPointToFull([0.5, 0.5], crop)).toEqual([0.45, 0.5]);
  });

  it("is the identity when there was no crop", () => {
    expect(cropPointToFull([0.3, 0.8], null)).toEqual([0.3, 0.8]);
  });

  it("keeps the 0-edge a real coordinate rather than treating it as absent", () => {
    // The Null Island rule: [0,0] in crop space is a genuine point, not "unset".
    expect(cropPointToFull([0, 0], { x: 0, y: 0, w: 0.5, h: 0.5 })).toEqual([0, 0]);
  });
});

describe("cropToPixels", () => {
  it("converts a crop to an in-bounds pixel rect on the real plan size", () => {
    expect(cropToPixels({ x: 0.181, y: 0.262, w: 0.476, h: 0.592 }, 2600, 1733))
      .toEqual({ left: 471, top: 454, width: 1238, height: 1026 });
  });

  it("never lets rounding push the window past the image edge", () => {
    const r = cropToPixels({ x: 0.9999, y: 0.9999, w: 1, h: 1 }, 2600, 1733);
    expect(r.left + r.width).toBeLessThanOrEqual(2600);
    expect(r.top + r.height).toBeLessThanOrEqual(1733);
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });
});
