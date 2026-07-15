import { describe, it, expect } from "vitest";
import {
  PULL_DIST, pullProgress, easeOutCubic, easeOutElastic, boxSize, neckHalfWidth, neckPath,
} from "./palettePull";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";

const CHIP = { w: 132, h: 34 };

describe("pullProgress", () => {
  it("runs 0 -> 1 over PULL_DIST and clamps at both ends", () => {
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(-5)).toBe(0);           // defensive: never negative
    expect(pullProgress(PULL_DIST / 2)).toBeCloseTo(0.5, 5);
    expect(pullProgress(PULL_DIST)).toBe(1);
    expect(pullProgress(PULL_DIST * 10)).toBe(1); // clamps, never exceeds 1
  });
});

describe("easings", () => {
  it("easeOutCubic is pinned at both ends and monotonic between", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const v = easeOutCubic(t);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
  it("easeOutElastic is pinned at both ends and overshoots 1 in between (that IS the spring)", () => {
    expect(easeOutElastic(0)).toBe(0);
    expect(easeOutElastic(1)).toBe(1);
    const samples = Array.from({ length: 50 }, (_, i) => easeOutElastic(i / 49));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });
});

describe("boxSize", () => {
  it("is EXACTLY one RU of rack at t=1, scaled by the canvas", () => {
    // The whole point of the gesture: it solidifies at the size of the RU space it will occupy.
    expect(boxSize(1, 1, CHIP)).toEqual({ w: RACK_INTERIOR_W, h: RU_PX });
    expect(boxSize(1, 0.5, CHIP)).toEqual({ w: RACK_INTERIOR_W * 0.5, h: RU_PX * 0.5 });
  });
  it("starts at the chip's own size at t=0", () => {
    expect(boxSize(0, 1, CHIP)).toEqual({ w: CHIP.w, h: CHIP.h });
  });
  it("grows monotonically between", () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const w = boxSize(t, 1, CHIP).w;
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
  });
});

describe("the neck", () => {
  it("thins monotonically to nothing as the pull stretches", () => {
    let prev = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const w = neckHalfWidth(CHIP.h, t);
      expect(w).toBeLessThan(prev);
      prev = w;
    }
    expect(neckHalfWidth(CHIP.h, 1)).toBe(0);
  });
  it("has snapped — no path at all — once solid", () => {
    expect(neckPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 1, CHIP.h)).toBe("");
    expect(neckPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 1.5, CHIP.h)).toBe("");
  });
  it("draws a closed ribbon between chip and box while stretching", () => {
    const d = neckPath({ x: 10, y: 10 }, { x: 150, y: 40 }, 0.5, CHIP.h);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("Q");            // curved, not a straight polygon
    expect(d).not.toContain("NaN");
  });
  it("survives a zero-length pull without NaN (pointer still on the chip)", () => {
    const d = neckPath({ x: 10, y: 10 }, { x: 10, y: 10 }, 0, CHIP.h);
    expect(d).not.toContain("NaN");
  });
});
