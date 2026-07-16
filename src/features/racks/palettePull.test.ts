import { describe, it, expect } from "vitest";
import {
  SNAP_MS, RACK_LATCH_X, BOX_OPACITY, CHIP_R, FLEX_MAX, FLEX_SPEED_FULL,
  restingFlex, flexTarget, stepFlex, flexScale, latchGrow, pullGeometry, nearRack, overChip, cancelledHome,
  type PullState,
} from "./palettePull";
import { RACK_INTERIOR_W } from "./RackFrame";
import { CORNER_R } from "@/features/device-library/faceplate/Faceplate";
import { RU_PX } from "@/domain/faceplate-geometry";

const CHIP = { w: 132, h: 34 };


describe("latchGrow — the spring that opens the chip into the device", () => {
  it("runs 0 -> 1 and overshoots in between (that IS the elastic pop)", () => {
    // Starting at 0 is correct: it lerps FROM the chip's size, so it has something to grow out of.
    expect(latchGrow(0)).toBe(0);
    expect(latchGrow(1)).toBe(1);
    expect(latchGrow(1.5)).toBe(1);             // clamps — the solid branch feeds k unclamped
    const samples = Array.from({ length: 50 }, (_, i) => latchGrow(i / 49));
    expect(Math.max(...samples)).toBeGreaterThan(1);
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
  const CHIP_BOX = { w: 132, h: 34 };
  const base: PullState = {
    typeId: "t1", label: "Switch", chip, chipSize: CHIP_BOX, x: 100, y: 100, phase: "pulling",
    snapFrom: null, snapStart: 0, snapSize: null, left: false,
    vx: 0, vy: 0, lastMoveAt: 0, flex: restingFlex(),
  };

  it("what you carry IS the chip: its own size, its own radius, under the cursor", () => {
    const p: PullState = { ...base, x: 400, y: 250 };
    const g = pullGeometry(p, 1, 0);
    expect(g.at).toEqual({ x: 400, y: 250 });
    expect(g.size).toEqual(CHIP_BOX);
    expect(g.radius).toBe(CHIP_R);
    expect(g.openness).toBe(0);                 // still a chip: label shown, no face
  });

  it("REGRESSION: at the instant it opens it is still exactly CHIP-sized — not 0, not already full", () => {
    // Two failure modes this pins. Collapse: a spring starting the SIZE at 0 would zero the box out
    // on the first frame and pop it back. Teleport: jumping straight to full RU would skip the
    // spring entirely. It must grow out of the chip you were carrying.
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    const g = pullGeometry(p, 1, 1000);
    expect(g.size).toEqual(CHIP_BOX);
    expect(g.openness).toBe(0);
  });

  it("opens to EXACTLY one RU of rack, scaled by the canvas, and fully faced", () => {
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    const g = pullGeometry(p, 1, 1000 + SNAP_MS * 20);
    expect(g.size).toEqual({ w: RACK_INTERIOR_W, h: RU_PX });
    expect(g.openness).toBe(1);
    expect(g.radius).toBe(CORNER_R);            // and has taken the device's own corner
    expect(pullGeometry(p, 0.5, 1000 + SNAP_MS * 20).size).toEqual({ w: RACK_INTERIOR_W * 0.5, h: RU_PX * 0.5 });
  });

  it("overshoots one RU mid-spring (that IS the elastic pop)", () => {
    const p: PullState = { ...base, phase: "solid", x: 400, y: 100, snapStart: 1000 };
    let overshot = false;
    for (let dt = 0; dt <= SNAP_MS; dt += SNAP_MS / 40) {
      if (pullGeometry(p, 1, 1000 + dt).size.w > RACK_INTERIOR_W) overshot = true;
    }
    expect(overshot).toBe(true);
  });

  it("snapback shrinks from the size it actually was, back onto the chip, to nothing", () => {
    const snapFrom = { x: 400, y: 100 }, snapSize = { w: 300, h: 40 };
    const p: PullState = { ...base, phase: "snapback", snapFrom, snapSize, snapStart: 2000 };
    const start = pullGeometry(p, 1, 2000);
    expect(start.at).toEqual(snapFrom);
    expect(start.size).toEqual(snapSize);       // never jumps to an assumed size first
    expect(start.opacity).toBeCloseTo(BOX_OPACITY, 5);
    const end = pullGeometry(p, 1, 2000 + SNAP_MS * 5);
    expect(end.at).toEqual(chip);
    expect(end.size).toEqual({ w: 0, h: 0 });
    expect(end.opacity).toBe(0);
  });
});



describe("the flex — an upright chip whose outline gives with movement and speed", () => {
  it("moving SIDEWAYS makes it wide and short", () => {
    const t = flexTarget(FLEX_SPEED_FULL, 0);
    expect(t).toBe(FLEX_MAX);
    const { sx, sy } = flexScale(t);
    expect(sx).toBeGreaterThan(1);
    expect(sy).toBeLessThan(1);
  });

  it("moving UP or DOWN makes it narrow and tall — the mirror image", () => {
    const t = flexTarget(0, FLEX_SPEED_FULL);
    expect(t).toBe(-FLEX_MAX);
    const { sx, sy } = flexScale(t);
    expect(sx).toBeLessThan(1);
    expect(sy).toBeGreaterThan(1);
  });

  it("is direction-agnostic: left flexes like right, up like down", () => {
    expect(flexTarget(-FLEX_SPEED_FULL, 0)).toBe(flexTarget(FLEX_SPEED_FULL, 0));
    expect(flexTarget(0, -FLEX_SPEED_FULL)).toBe(flexTarget(0, FLEX_SPEED_FULL));
  });

  it("a perfect diagonal cancels — the honest answer when the shape cannot rotate", () => {
    expect(flexTarget(900, 900)).toBe(0);
  });

  it("flexes more the faster it moves, and clamps", () => {
    expect(flexTarget(0, 0)).toBe(0);
    expect(flexTarget(FLEX_SPEED_FULL / 2, 0)).toBeCloseTo(FLEX_MAX / 2, 5);
    expect(flexTarget(FLEX_SPEED_FULL * 10, 0)).toBe(FLEX_MAX);  // a fling can't tear it to a ribbon
  });

  it("the flex is gentle — this is a device chip, not slime", () => {
    // It was 0.45 when the carried thing was a blob. A chip that gelatinous reads as broken.
    expect(FLEX_MAX).toBeLessThan(0.25);
  });

  it("is volume-preserving, so it never appears to grow as it flexes", () => {
    for (const st of [-FLEX_MAX, -0.05, 0, 0.05, FLEX_MAX]) {
      const { sx, sy } = flexScale(st);
      expect(sx * sy).toBeCloseTo(1, 10);
    }
    expect(flexScale(0)).toEqual({ sx: 1, sy: 1 });   // at rest it is exactly the chip
  });

  it("never inverts, however hard the spring overshoots", () => {
    expect(flexScale(-5).sx).toBeGreaterThan(0);
    expect(flexScale(-5).sy).toBeGreaterThan(0);
  });

  it("OVERSHOOTS the target — that ring IS the flex, and a lerp could never do it", () => {
    let f = restingFlex();
    let peak = 0;
    for (let i = 0; i < 200; i++) { f = stepFlex(f, FLEX_MAX, 1 / 60); peak = Math.max(peak, f.stretch); }
    expect(peak).toBeGreaterThan(FLEX_MAX);
  });

  it("rings back to the chip's true shape once the cursor stops", () => {
    let f = restingFlex();
    for (let i = 0; i < 60; i++) f = stepFlex(f, FLEX_MAX, 1 / 60);   // fling
    for (let i = 0; i < 400; i++) f = stepFlex(f, 0, 1 / 60);         // let go
    expect(Math.abs(f.stretch)).toBeLessThan(0.005);
    expect(Math.abs(f.v)).toBeLessThan(0.05);
  });

  it("survives a stalled tab: a huge dt is clamped rather than exploding the spring", () => {
    const f = stepFlex(restingFlex(), FLEX_MAX, 30);   // 30 SECONDS between frames
    expect(Number.isFinite(f.stretch)).toBe(true);
    expect(Math.abs(f.stretch)).toBeLessThan(1);
    expect(flexScale(f.stretch).sx).toBeGreaterThan(0);
  });
});

describe("bring it home to cancel", () => {
  const chip = { x: 100, y: 100 };
  const CHIP_BOX = { w: 132, h: 34 };
  const base: PullState = {
    typeId: "t1", label: "Switch", chip, chipSize: CHIP_BOX, x: 100, y: 100, phase: "pulling",
    snapFrom: null, snapStart: 0, snapSize: null, left: false,
    vx: 0, vy: 0, lastMoveAt: 0, flex: restingFlex(),
  };

  it("overChip is the chip's own box — 'back where it came from' is exactly that", () => {
    expect(overChip({ x: 100, y: 100 }, base)).toBe(true);
    expect(overChip({ x: 100 + CHIP_BOX.w / 2, y: 100 }, base)).toBe(true);   // on the edge
    expect(overChip({ x: 100 + CHIP_BOX.w / 2 + 1, y: 100 }, base)).toBe(false);
    expect(overChip({ x: 100, y: 100 + CHIP_BOX.h / 2 + 1 }, base)).toBe(false);
  });

  it("REGRESSION: does NOT cancel on the press itself, which starts ON the chip", () => {
    // Without the `left` latch this fires the instant you touch the chip and the gesture is dead on
    // arrival — the cursor is over the chip by definition at pointerdown.
    expect(cancelledHome({ ...base, left: false })).toBe(false);
  });

  it("cancels once it has been taken away and brought back", () => {
    expect(cancelledHome({ ...base, left: true, x: 100, y: 100 })).toBe(true);
  });

  it("does not cancel while it is still away from the chip", () => {
    expect(cancelledHome({ ...base, left: true, x: 900, y: 400 })).toBe(false);
  });

  it("cancels an OPENED device too, not just a carried chip", () => {
    // The point of the rule: change your mind after it has become a device and bringing it home
    // still puts it back.
    expect(cancelledHome({ ...base, left: true, phase: "solid", x: 100, y: 100 })).toBe(true);
  });
});
