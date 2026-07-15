import { describe, it, expect } from "vitest";
import {
  PULL_DIST, SNAP_MS, RACK_LATCH_X, BOX_OPACITY, pullProgress, easeOutCubic, easeInLag, latchGrow,
  blobTarget, blobSize, neckHalfWidth, neckPath, pullGeometry, pullAt, nearRack, type PullState,
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
  it("latchGrow runs 0 -> 1 and overshoots in between (that IS the spring)", () => {
    // Starting at 0 is correct here: the box is still BLOB-sized when it solidifies, so this lerps
    // blob -> one RU. It is only wrong when applied to a box that is already at its target.
    expect(latchGrow(0)).toBe(0);
    expect(latchGrow(1)).toBe(1);
    expect(latchGrow(1.5)).toBe(1);             // clamps — the solid branch feeds k unclamped
    const samples = Array.from({ length: 50 }, (_, i) => latchGrow(i / 49));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });
  it("easeInLag is pinned at both ends and lags a linear travel the whole way", () => {
    expect(easeInLag(0)).toBe(0);
    expect(easeInLag(1)).toBe(1);
    for (let t = 0.1; t < 1; t += 0.1) expect(easeInLag(t)).toBeLessThan(t);
  });
  it("easeInLag lags far harder than the ease-OUT the size uses (which gave ~no visible lag)", () => {
    expect(easeInLag(0.5)).toBeLessThan(easeOutCubic(0.5) / 2);
  });
});

describe("the blob", () => {
  it("is a nub on the chip at t=0 and a lump at t=1", () => {
    const nub = blobSize(0, CHIP), lump = blobSize(1, CHIP);
    expect(lump).toEqual(blobTarget(CHIP));
    expect(nub.w).toBeLessThan(lump.w);
    expect(nub.h).toBeLessThan(lump.h);
  });
  it("NEVER reaches RU size, however far you pull — only the rack can do that", () => {
    // The whole point of this behaviour: carrying it around the page must not look like carrying a
    // device. Only solidifying at the rack turns it into one.
    for (let t = 0; t <= 1.0001; t += 0.1) {
      expect(blobSize(t, CHIP).w).toBeLessThan(RACK_INTERIOR_W);
      expect(blobSize(t, CHIP).h).toBeLessThan(RU_PX);
    }
  });
  it("swells monotonically", () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const w = blobSize(t, CHIP).w;
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
  });
});

describe("nearRack", () => {
  it("is true within RACK_LATCH_X of the rack's centre line, on either side", () => {
    expect(nearRack(500, 500)).toBe(true);
    expect(nearRack(500 - RACK_LATCH_X, 500)).toBe(true);
    expect(nearRack(500 + RACK_LATCH_X, 500)).toBe(true);
  });
  it("is false beyond it", () => {
    expect(nearRack(500 - RACK_LATCH_X - 1, 500)).toBe(false);
    expect(nearRack(500 + RACK_LATCH_X + 1, 500)).toBe(false);
  });
  it("is false when the rack cannot be measured — never latch on a guess", () => {
    expect(nearRack(500, null)).toBe(false);
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
    expect(neckHalfWidth(CHIP.h, 0)).toBe(CHIP.h / 2);
    expect(neckHalfWidth(CHIP.h, 1)).toBe(0);
  });
  it("has snapped — no path at all — once the blob is free", () => {
    expect(neckPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 1, CHIP.h)).toBe("");
    expect(neckPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 1.5, CHIP.h)).toBe("");
  });
  it("draws a closed ribbon between chip and blob while stretching", () => {
    const d = neckPath({ x: 10, y: 10 }, { x: 150, y: 40 }, 0.5, CHIP.h);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("Q");            // curved, not a straight polygon
    expect(d).not.toContain("NaN");
  });
  it("survives a zero-length pull without NaN (pointer still on the chip)", () => {
    expect(neckPath({ x: 10, y: 10 }, { x: 10, y: 10 }, 0, CHIP.h)).not.toContain("NaN");
  });
});

describe("pullGeometry — the single source of truth both paint paths call", () => {
  const chip = { x: 100, y: 100 };
  const base: PullState = {
    typeId: "t1", chip, chipSize: CHIP, x: 100, y: 100, phase: "pulling",
    snapFrom: null, snapStart: 0, snapSize: null,
  };

  it("while pulling it is a BLOB, not the device", () => {
    const p: PullState = { ...base, x: 100 + PULL_DIST / 2, y: 100 };
    const g = pullGeometry(p, 1, 0);
    expect(g.solid).toBe(false);              // the painter draws the lump, not the faceplate
    expect(g.size).toEqual(blobSize(pullProgress(PULL_DIST / 2), CHIP));
    expect(g.neck).not.toBe("");
  });

  it("REGRESSION: solid at the instant it latches is the BLOB's size — not 0, not already full", () => {
    // Two failure modes this pins. Collapse: a spring starting at 0 would zero the box out on the
    // first frame after latching and pop it back. Teleport: jumping straight to full RU would skip
    // the grow entirely. It must start at exactly the lump it was.
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    const g = pullGeometry(p, 1, 1000);
    expect(g.size).toEqual(blobTarget(CHIP));
    expect(g.size.w).toBeGreaterThan(0);
    expect(g.size.w).toBeLessThan(RACK_INTERIOR_W);
    expect(g.solid).toBe(true);               // but it IS drawn as the device from the first frame
  });

  it("solid settles to EXACTLY one RU of rack, scaled by the canvas", () => {
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    expect(pullGeometry(p, 1, 1000 + SNAP_MS * 20).size).toEqual({ w: RACK_INTERIOR_W, h: RU_PX });
    expect(pullGeometry(p, 0.5, 1000 + SNAP_MS * 20).size).toEqual({ w: RACK_INTERIOR_W * 0.5, h: RU_PX * 0.5 });
  });

  it("solid overshoots one RU mid-spring (that IS the spring)", () => {
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    let overshot = false;
    for (let dt = 0; dt <= SNAP_MS; dt += SNAP_MS / 40) {
      if (pullGeometry(p, 1, 1000 + dt).size.w > RACK_INTERIOR_W) overshot = true;
    }
    expect(overshot).toBe(true);
  });

  it("snapback melts back to slime and shrinks from the size it actually was", () => {
    // Whatever it was — blob or full device — it retreats as a blob and is sucked in. snapSize is
    // captured at abandon so it never jumps to some assumed size first.
    const snapFrom = { x: 400, y: 100 }, snapSize = { w: 300, h: 40 };
    const p: PullState = { ...base, phase: "snapback", snapFrom, snapSize, snapStart: 2000 };
    const g = pullGeometry(p, 1, 2000);
    expect(g.at).toEqual(snapFrom);
    expect(g.size).toEqual(snapSize);
    expect(g.neck).toBe("");
    expect(g.solid).toBe(false);              // melts back into goo on the way home
    expect(g.opacity).toBeCloseTo(BOX_OPACITY, 5);
  });

  it("snapback ends on the chip, at nothing, invisible", () => {
    const p: PullState = { ...base, phase: "snapback", snapFrom: { x: 400, y: 100 },
      snapSize: { w: 300, h: 40 }, snapStart: 2000 };
    const g = pullGeometry(p, 1, 2000 + SNAP_MS * 5);
    expect(g.at).toEqual(chip);
    expect(g.size).toEqual({ w: 0, h: 0 });
    expect(g.opacity).toBe(0);
  });
});

describe("pullAt — the blob is dragged OUT of the chip, it doesn't teleport to the cursor", () => {
  const chip = { x: 100, y: 100 };
  const base = { typeId: "t", chip, chipSize: CHIP, phase: "pulling" as const,
    snapFrom: null, snapStart: 0, snapSize: null };

  it("sits ON the chip at t=0 — the blob is still part of the slime, not under your finger", () => {
    expect(pullAt({ ...base, x: chip.x, y: chip.y })).toEqual(chip);
  });

  it("has arrived at the pointer by the time the neck snaps", () => {
    expect(pullAt({ ...base, phase: "solid" as const, x: 900, y: 400 })).toEqual({ x: 900, y: 400 });
  });

  it("LAGS the cursor mid-pull — strictly between the chip and the pointer", () => {
    const p = { ...base, x: chip.x + PULL_DIST / 2, y: chip.y };
    const at = pullAt(p);
    expect(at.x).toBeGreaterThan(chip.x);
    expect(at.x).toBeLessThan(p.x);
  });

  it("pullGeometry paints the box at that lagged position, not at the pointer", () => {
    const p = { ...base, x: chip.x + PULL_DIST / 2, y: chip.y };
    expect(pullGeometry(p, 1, 0).at).toEqual(pullAt(p));
  });
});
