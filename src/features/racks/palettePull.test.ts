import { describe, it, expect } from "vitest";
import {
  PULL_DIST, SNAP_MS, BOX_OPACITY, pullProgress, easeOutCubic, latchScale, boxSize, neckHalfWidth,
  neckPath, pullGeometry, type PullState,
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
  it("latchScale starts at 1 (the box is already full size when it latches) and overshoots in between", () => {
    // NOT easeOutElastic, which starts at 0 — that is exactly the collapse bug this replaces.
    expect(latchScale(0)).toBe(1);
    expect(latchScale(1)).toBe(1);
    const samples = Array.from({ length: 50 }, (_, i) => latchScale(i / 49));
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

describe("pullGeometry — the single source of truth both paint paths call", () => {
  const chip = { x: 100, y: 100 };
  const chipSize = CHIP;
  const base: PullState = {
    typeId: "t1", chip, chipSize, x: 100, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, snapT: 0,
  };

  it("REGRESSION: phase solid at the instant it latches (now === snapStart) is full RU size, not 0x0", () => {
    // This is the collapse bug: easeOutElastic(0) === 0 would zero the box out on the very first
    // frame after latching, then pop it back to full size. latchScale must start at 1.
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    const g = pullGeometry(p, 1, 1000);
    expect(g.size).toEqual({ w: RACK_INTERIOR_W, h: RU_PX });
  });

  it("phase solid long after snapStart settles to exactly full size", () => {
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    const g = pullGeometry(p, 1, 1000 + SNAP_MS * 20);
    expect(g.size).toEqual({ w: RACK_INTERIOR_W, h: RU_PX });
  });

  it("phase solid mid-spring overshoots full size (that IS the spring)", () => {
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    let overshot = false;
    for (let dt = 0; dt <= SNAP_MS; dt += SNAP_MS / 40) {
      const g = pullGeometry(p, 1, 1000 + dt);
      if (g.size.w > RACK_INTERIOR_W) overshot = true;
    }
    expect(overshot).toBe(true);
  });

  it("phase snapback at k=0: at equals snapFrom, neck is empty, opacity is BOX_OPACITY", () => {
    const snapFrom = { x: 400, y: 100 };
    const p: PullState = { ...base, phase: "snapback", snapFrom, snapStart: 2000 };
    const g = pullGeometry(p, 1, 2000);
    expect(g.at).toEqual(snapFrom);
    expect(g.neck).toBe("");
    expect(g.opacity).toBeCloseTo(BOX_OPACITY, 5);
  });

  it("REGRESSION: snapback sizes from the box's actual size at abandon, not full RU size", () => {
    // A pull abandoned early (small box, still stretching) must shrink from THAT size, not jump to
    // full RU size and then shrink. snapT pins the progress at the moment of abandon; k=0 (the
    // start of the snap-back) must reproduce boxSize(snapT, ...) exactly, never boxSize(1, ...).
    const snapFrom = { x: 130, y: 100 };
    const p: PullState = { ...base, phase: "snapback", snapFrom, snapStart: 2000, snapT: 0.5 };
    const g = pullGeometry(p, 1, 2000); // k=0
    expect(g.size).toEqual(boxSize(0.5, 1, chipSize));
    expect(g.size).not.toEqual({ w: RACK_INTERIOR_W, h: RU_PX }); // not full RU size
  });

  it("phase snapback at k>=1: at equals chip, size equals the chip's size, opacity is 0", () => {
    const snapFrom = { x: 400, y: 100 };
    const p: PullState = { ...base, phase: "snapback", snapFrom, snapStart: 2000 };
    const g = pullGeometry(p, 1, 2000 + SNAP_MS * 5);
    expect(g.at).toEqual(chip);
    expect(g.size).toEqual(chipSize);
    expect(g.opacity).toBe(0);
  });

  it("phase pulling mid-pull: neck is non-empty", () => {
    const p: PullState = { ...base, phase: "pulling", x: 100 + PULL_DIST / 2, y: 100 };
    const g = pullGeometry(p, 1, 0);
    expect(g.neck).not.toBe("");
  });
});
