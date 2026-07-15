import { describe, it, expect } from "vitest";
import {
  PULL_DIST, SNAP_MS, RACK_LATCH_X, BOX_OPACITY, NECK_SNAP, JIGGLE_MAX, JIGGLE_SPEED_FULL,
  restingJiggle, jiggleTarget, stepJiggle, jiggleScale, pullProgress, easeOutCubic, latchGrow,
  blobTarget, blobSize, pullGeometry, chipExit, neckRootW, neckPath, nearRack, type PullState,
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

describe("pullGeometry — the single source of truth both paint paths call", () => {
  const chip = { x: 100, y: 100 };
  const base: PullState = {
    typeId: "t1", label: "Switch", chip, chipSize: CHIP, x: 100, y: 100, phase: "pulling",
    snapFrom: null, snapStart: 0, snapSize: null,
    vx: 0, vy: 0, lastMoveAt: 0, jiggle: restingJiggle(),
  };

  it("while pulling it is a BLOB, not the device", () => {
    const p: PullState = { ...base, x: 100 + PULL_DIST / 2, y: 100 };
    const g = pullGeometry(p, 1, 0);
    expect(g.solid).toBe(false);              // the painter draws the lump, not the faceplate
    expect(g.size).toEqual(blobSize(pullProgress(PULL_DIST / 2), CHIP));
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


describe("the tear — the chip's own outline is what splits", () => {
  const chip = { x: 100, y: 100 };
  const base: PullState = {
    typeId: "t1", label: "Switch", chip, chipSize: CHIP, x: 100, y: 100, phase: "pulling",
    snapFrom: null, snapStart: 0, snapSize: null,
    vx: 0, vy: 0, lastMoveAt: 0, jiggle: restingJiggle(),
  };

  it("the blob sits EXACTLY under the cursor — no lag curve", () => {
    const p: PullState = { ...base, x: 260, y: 175 };
    expect(pullGeometry(p, 1, 0).at).toEqual({ x: 260, y: 175 });
  });

  it("chipExit clamps to the chip's box, so it IS the cursor while still inside it", () => {
    // That zero length is what stops anything being drawn before the cursor leaves the chip.
    const inside = { x: 110, y: 104 };
    expect(chipExit(base, inside)).toEqual(inside);
  });

  it("chipExit sits on the chip's edge once outside — the tear point, never the centre", () => {
    const out = { x: 400, y: 100 };
    const e = chipExit(base, out);
    expect(e.x).toBe(chip.x + CHIP.w / 2);      // the near edge
    expect(e.y).toBe(100);
    expect(e).not.toEqual(chip);                // NOT the centre: that is what drew the "arrow"
  });

  it("REGRESSION: no neck at all while the cursor is inside the chip", () => {
    // The old centre-rooted neck always had length, so it drew a spike across the chip's own face
    // whenever the blob lagged inside it. Rooted at the exit point there is nothing to span.
    for (const at of [{ x: 100, y: 100 }, { x: 150, y: 108 }, { x: 40, y: 92 }]) {
      const p: PullState = { ...base, x: at.x, y: at.y };
      expect(pullGeometry(p, 1, 0).neck).toBe("");
    }
  });

  it("a neck appears once the cursor leaves the chip, and thins to nothing as it pulls away", () => {
    const near: PullState = { ...base, x: chip.x + CHIP.w / 2 + 10, y: 100 };
    expect(pullGeometry(near, 1, 0).neck).not.toBe("");
    let prev = Infinity;
    for (let gap = 0; gap <= NECK_SNAP; gap += NECK_SNAP / 8) {
      const w = neckRootW(CHIP.h, gap);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
    expect(neckRootW(CHIP.h, NECK_SNAP)).toBe(0);   // snapped
  });

  it("the neck is gone once it has snapped, however far you drag", () => {
    const far: PullState = { ...base, x: chip.x + CHIP.w / 2 + NECK_SNAP + 50, y: 100 };
    expect(pullGeometry(far, 1, 0).neck).toBe("");
  });

  it("the neck spans exit -> blob without NaN, and is a closed ribbon", () => {
    const d = neckPath({ x: 10, y: 10 }, { x: 90, y: 40 }, 12, 6);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("Q");
    expect(d).not.toContain("NaN");
  });

  it("a zero-length or snapped neck draws nothing rather than a degenerate sliver", () => {
    expect(neckPath({ x: 10, y: 10 }, { x: 10, y: 10 }, 12, 6)).toBe("");
    expect(neckPath({ x: 10, y: 10 }, { x: 90, y: 40 }, 0, 6)).toBe("");
  });

  it("solid draws no neck — it has long since let go", () => {
    const p: PullState = { ...base, phase: "solid", x: 800, y: 300, snapStart: 0 };
    expect(pullGeometry(p, 1, 0).neck).toBe("");
  });
});

describe("the jiggle — a soft square that reacts to how fast you fling it", () => {
  it("is a SQUARE at rest, not an oval", () => {
    expect(blobTarget(CHIP).w).toBe(blobTarget(CHIP).h);
  });

  it("stretches more the faster the cursor moves, and clamps", () => {
    expect(jiggleTarget(0)).toBe(0);
    expect(jiggleTarget(JIGGLE_SPEED_FULL / 2)).toBeCloseTo(JIGGLE_MAX / 2, 5);
    expect(jiggleTarget(JIGGLE_SPEED_FULL)).toBe(JIGGLE_MAX);
    expect(jiggleTarget(JIGGLE_SPEED_FULL * 10)).toBe(JIGGLE_MAX); // a fling can't tear it to a needle
    expect(jiggleTarget(-JIGGLE_SPEED_FULL)).toBe(JIGGLE_MAX);     // direction-agnostic: it's a speed
  });

  it("squash-and-stretch preserves volume — what it gains along it loses across", () => {
    for (const st of [0, 0.1, JIGGLE_MAX, 1]) {
      const { along, across } = jiggleScale(st);
      expect(along * across).toBeCloseTo(1, 10);
    }
    expect(jiggleScale(0)).toEqual({ along: 1, across: 1 });      // rest = an undeformed square
    expect(jiggleScale(0.4).along).toBeGreaterThan(1);
    expect(jiggleScale(0.4).across).toBeLessThan(1);
  });

  it("OVERSHOOTS the target — that ring IS the jiggle, and a lerp could never do it", () => {
    // The point of using a spring. Drive it at a fixed target and it must sail PAST it, not ease in.
    let j = restingJiggle();
    let peak = 0;
    for (let i = 0; i < 200; i++) {
      j = stepJiggle(j, JIGGLE_MAX, 0, 1 / 60);
      peak = Math.max(peak, j.stretch);
    }
    expect(peak).toBeGreaterThan(JIGGLE_MAX);
  });

  it("rings back down and settles once the cursor stops", () => {
    let j = restingJiggle();
    for (let i = 0; i < 60; i++) j = stepJiggle(j, JIGGLE_MAX, 0, 1 / 60);  // fling
    for (let i = 0; i < 400; i++) j = stepJiggle(j, 0, 0, 1 / 60);          // let go
    expect(Math.abs(j.stretch)).toBeLessThan(0.005);
    expect(Math.abs(j.v)).toBeLessThan(0.05);
  });

  it("holds its angle when the cursor stops, so a settling square doesn't spin", () => {
    // atan2(0,0) is 0, so a decaying velocity would otherwise snap the axis back to horizontal
    // mid-wobble and the square would visibly rotate as it settled.
    let j = stepJiggle(restingJiggle(), JIGGLE_MAX, 1.2, 1 / 60);
    expect(j.angle).toBeCloseTo(1.2, 5);
    j = stepJiggle(j, 0, 0, 1 / 60);   // stopped: target 0, angle argument meaningless
    expect(j.angle).toBeCloseTo(1.2, 5);
  });

  it("survives a stalled tab: a huge dt is clamped rather than exploding the spring", () => {
    const j = stepJiggle(restingJiggle(), JIGGLE_MAX, 0, 30); // 30 SECONDS between frames
    expect(Number.isFinite(j.stretch)).toBe(true);
    expect(Math.abs(j.stretch)).toBeLessThan(1);
    expect(jiggleScale(j.stretch).along).toBeGreaterThan(0);   // never inverts the square
  });

  it("a solid device does not jiggle — it is a rack device now, not slime", () => {
    const p: PullState = {
      typeId: "t1", label: "Switch", chip: { x: 100, y: 100 }, chipSize: CHIP, x: 400, y: 100,
      phase: "solid", snapFrom: null, snapStart: 0, snapSize: null,
      vx: 9999, vy: 9999, lastMoveAt: 0, jiggle: { stretch: 0.4, v: 3, angle: 1 },
    };
    expect(pullGeometry(p, 1, 0).jiggle).toEqual({ along: 1, across: 1, angle: 0 });
  });
});
