import { describe, it, expect } from "vitest";
import {
  SNAP_MS, RACK_LATCH_X, BOX_OPACITY, CHIP_R, FLEX_MAX, FLEX_SPEED_FULL,
  restingFlex, flexTarget, stepFlex, flexScale, easeOutCubic, openReveal, pullGeometry, nearRack,
  type PullState,
} from "./palettePull";
import { RACK_INTERIOR_W } from "./RackFrame";
import { CORNER_R } from "@/features/device-library/faceplate/Faceplate";
import { RU_PX } from "@/domain/faceplate-geometry";

const CHIP = { w: 132, h: 34 };


describe("the open is driven by POSITION, and eases", () => {
  const CHIP_BOX = { w: 132, h: 34 };
  const p = (x: number): PullState => ({
    typeId: "t1", label: "Switch", chip: { x: 0, y: 0 }, grab: { x: 0, y: 0 }, chipSize: CHIP_BOX,
    x, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, snapSize: null,
    vx: 0, vy: 0, lastMoveAt: 0, flex: restingFlex(), invalid: false,
  });

  it("easeOutCubic is monotonic, pinned EXACTLY at 0 and 1, and FAST off the mark", () => {
    expect(easeOutCubic(0)).toBe(0);            // exactly
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-3)).toBe(0);
    expect(easeOutCubic(3)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 200; i++) { const v = easeOutCubic(i / 200); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    // begins visibly the instant it moves — a 2% move already yields far more than 2% open...
    expect(easeOutCubic(0.02)).toBeGreaterThan(0.02);
    // ...and settles gently as it arrives at the centre.
    expect(1 - easeOutCubic(0.98)).toBeLessThan(0.01);
  });

  it("is 0 at the pickup point, 1 at the rack's centre, and eased between", () => {
    // p(x) has chip centre 0 and no grab, so the pickup ORIGIN is x=0 and the journey is 0..centre.
    const centre = 500;
    expect(openReveal(p(0), centre)).toBe(0);        // at pickup -> a chip (begins here)
    expect(openReveal(p(centre), centre)).toBe(1);   // at the centre -> a full device
    const half = openReveal(p(centre / 2), centre);  // half way along the journey
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    expect(openReveal(p(-100), centre)).toBe(0);     // dragged the wrong way -> still a chip
  });

  it("depends only on distance to the centre, so passing it starts closing again", () => {
    const centre = 500;
    // 60px short of the centre and 60px past it are the same distance -> the same reveal.
    expect(openReveal(p(centre - 60), centre)).toBeCloseTo(openReveal(p(centre + 60), centre), 10);
  });

  it("increases MONOTONICALLY along the whole journey — the transition tracks the drag 1:1", () => {
    const centre = 500;
    let prev = -1;
    for (let x = 0; x <= centre; x += 5) {           // the WHOLE way from pickup to the centre
      const r = openReveal(p(x), centre);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(openReveal(p(centre), centre)).toBe(1);   // arrives at exactly 1 at the centre
  });

  it("begins the moment it is carried — the grab offset makes reveal exactly 0 at pickup", () => {
    // origin = chip centre - grab, so on the very first frame (cursor at the grab point) reveal is 0.
    const centre = 500;
    const grabbed: PullState = { ...p(64), chip: { x: 100, y: 0 }, grab: { x: 36, y: 0 } };
    // pickup cursor x = chip.x - grab.x = 64; drive x there -> exactly 0, and it only climbs after.
    expect(openReveal(grabbed, centre)).toBe(0);
    expect(openReveal({ ...grabbed, x: 200 }, centre)).toBeGreaterThan(0);
  });

  it("stays a chip when the rack cannot be measured — never opens on a guess", () => {
    expect(openReveal(p(500), null)).toBe(0);
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
  const CENTRE = 500;
  const base: PullState = {
    typeId: "t1", label: "Switch", chip, grab: { x: 0, y: 0 }, chipSize: CHIP_BOX, x: 100, y: 100,
    phase: "pulling", snapFrom: null, snapStart: 0, snapSize: null,
    vx: 0, vy: 0, lastMoveAt: 0, flex: restingFlex(), invalid: false,
  };
  // openness is driven by cursor x along the journey from the pickup origin (chip.x=100) to CENTRE.
  const ORIGIN = 100;

  it("at the pickup point it IS the chip: its own size and radius, under the cursor", () => {
    const p: PullState = { ...base, x: ORIGIN, y: 250 };
    const g = pullGeometry(p, 1, CENTRE, 0);
    expect(g.at).toEqual({ x: p.x, y: 250 });
    expect(g.size).toEqual(CHIP_BOX);
    expect(g.radius).toBe(CHIP_R);
    expect(g.reveal).toBe(0);                   // still a chip: label shown, no face
  });

  it("REGRESSION: at the pickup point it is EXACTLY chip-sized — not 0, not already opening", () => {
    // The ease is pinned at its ends, so on the very first frame the box is precisely the chip.
    // An ease off by 1e-16 opened it from 131.99999999999983.
    const g = pullGeometry({ ...base, x: ORIGIN }, 1, CENTRE, 0);
    expect(g.size).toEqual(CHIP_BOX);
    expect(g.reveal).toBe(0);
  });

  it("at the rack's centre it is EXACTLY one RU, scaled by the canvas, fully faced and cornered", () => {
    const g = pullGeometry({ ...base, x: CENTRE }, 1, CENTRE, 0);
    expect(g.size).toEqual({ w: RACK_INTERIOR_W, h: RU_PX });
    expect(g.reveal).toBe(1);
    expect(g.radius).toBe(CORNER_R);            // at scale 1, the device's own corner
    const half = pullGeometry({ ...base, x: CENTRE }, 0.5, CENTRE, 0);
    expect(half.size).toEqual({ w: RACK_INTERIOR_W * 0.5, h: RU_PX * 0.5 });
    // REGRESSION: the corner scales with the canvas, like the rest of the device — a fixed CORNER_R
    // looked too round zoomed out, where the real device's corner is CORNER_R * scale.
    expect(half.radius).toBe(CORNER_R * 0.5);
  });

  it("the transition tracks POSITION 1:1 — no overshoot, no dip, arriving at 1 at the centre", () => {
    // The whole point of this change: everything rides one position-driven reveal, so the shape and
    // the content complete TOGETHER, exactly when the device reaches the centre, and nothing springs
    // past its target while you are still dragging toward it.
    let prev = -1, past1 = false, dipped = false;
    for (let x = ORIGIN; x <= CENTRE; x += 3) {
      const g = pullGeometry({ ...base, x }, 1, CENTRE, 0);
      if (g.reveal > 1 || g.size.w > RACK_INTERIOR_W + 1e-9) past1 = true;
      if (g.reveal < prev - 1e-9) dipped = true;
      prev = g.reveal;
    }
    expect(past1).toBe(false);
    expect(dipped).toBe(false);
    // exactly 1 at the centre, and exactly one RU
    const centred = pullGeometry({ ...base, x: CENTRE }, 1, CENTRE, 0);
    expect(centred.reveal).toBe(1);
    expect(centred.size).toEqual({ w: RACK_INTERIOR_W, h: RU_PX });
  });

  it("dragging back out reverses it — the same motion, no clock of its own", () => {
    // Position-driven, so there is nothing to un-wind: half in, half out, both give the same frame.
    const midX = (ORIGIN + CENTRE) / 2;
    const halfway = openReveal({ ...base, x: midX }, CENTRE);
    expect(halfway).toBeGreaterThan(0);
    expect(halfway).toBeLessThan(1);
    // same x, same everything -> identical geometry whether we got here opening or closing.
    const a = pullGeometry({ ...base, x: midX }, 1, CENTRE, 0);
    const b = pullGeometry({ ...base, x: midX }, 1, CENTRE, 999999);
    expect(a.size).toEqual(b.size);
    expect(a.reveal).toEqual(b.reveal);
  });

  it("the grab anchor releases as it opens — offset at a chip, centred on the cursor at the device", () => {
    // origin cursor x = chip.x(100) - grab.x(40) = 60. At the origin reveal is 0 -> full offset.
    const grabbed = { ...base, grab: { x: 40, y: -8 } };
    const chipFrame = pullGeometry({ ...grabbed, x: 60 }, 1, CENTRE, 0);
    expect(chipFrame.reveal).toBe(0);
    expect(chipFrame.at).toEqual({ x: 60 + 40, y: 100 - 8 });                     // full offset -> chip centre
    const deviceFrame = pullGeometry({ ...grabbed, x: CENTRE }, 1, CENTRE, 0);
    expect(deviceFrame.at).toEqual({ x: CENTRE, y: 100 });                        // no offset
  });

  it("snapback starts from exactly where and what the box actually was", () => {
    const snapFrom = { x: 400, y: 100 }, snapSize = { w: 300, h: 40 };
    const p: PullState = { ...base, phase: "snapback", snapFrom, snapSize, snapStart: 2000 };
    const start = pullGeometry(p, 1, CENTRE, 2000);
    expect(start.at).toEqual(snapFrom);
    expect(start.size).toEqual(snapSize);
    expect(start.opacity).toBeCloseTo(BOX_OPACITY, 5);
    expect(start.homing).toBe(0);
  });

  it("REGRESSION: it FLIES HOME and lands as the chip — it does not evaporate", () => {
    const p: PullState = { ...base, phase: "snapback", snapFrom: { x: 400, y: 100 },
      snapSize: { w: 300, h: 40 }, snapStart: 2000 };
    const end = pullGeometry(p, 1, CENTRE, 2000 + SNAP_MS * 5);
    expect(end.at).toEqual(chip);
    expect(end.size).toEqual(CHIP_BOX);
    expect(end.radius).toBe(CHIP_R);
    expect(end.opacity).toBe(1);
    expect(end.homing).toBe(1);
    expect(end.reveal).toBe(0);
    expect(end.flex).toEqual({ sx: 1, sy: 1 });
  });

  it("the flight home eases rather than running at a constant rate", () => {
    const p: PullState = { ...base, phase: "snapback", snapFrom: { x: 0, y: 0 },
      snapSize: CHIP_BOX, snapStart: 0 };
    expect(pullGeometry(p, 1, CENTRE, SNAP_MS / 2).homing).toBeGreaterThan(0.5);
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




describe("the flex belongs to the chip, not the device", () => {
  const CHIP_BOX = { w: 132, h: 34 };
  const base: PullState = {
    typeId: "t1", label: "Switch", chip: { x: 100, y: 100 }, grab: { x: 0, y: 0 }, chipSize: CHIP_BOX,
    x: 100, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, snapSize: null,
    vx: 0, vy: 0, lastMoveAt: 0, flex: { stretch: FLEX_MAX, v: 0 }, invalid: false,
  };

  it("a CHIP flexes", () => {
    // far from the rack (rack centre 5000) it is a chip, so the flex is at full strength.
    expect(pullGeometry(base, 1, 5000, 0).flex.sx).toBeGreaterThan(1);
  });

  it("REGRESSION: an OPEN device does not — it arrives crisp and still", () => {
    // A rack device is not slime. Left flexing, it jittered the device and the name riding inside it.
    const open: PullState = { ...base, x: 500, phase: "pulling", flex: { stretch: FLEX_MAX, v: 0 } };
    const g = pullGeometry(open, 1, 500, 0);   // cursor AT the rack centre -> fully open
    expect(g.reveal).toBe(1);
    expect(g.flex).toEqual({ sx: 1, sy: 1 });
  });

  it("the flex fades out as it opens rather than being switched off", () => {
    const mid: PullState = { ...base, x: 500 - 40, phase: "pulling", flex: { stretch: FLEX_MAX, v: 0 } };
    const g = pullGeometry(mid, 1, 500, 0);    // partway to the centre -> partly open
    expect(g.reveal).toBeGreaterThan(0);
    expect(g.reveal).toBeLessThan(1);
    const full = flexScale(FLEX_MAX).sx;
    expect(g.flex.sx).toBeGreaterThan(1);        // still some...
    expect(g.flex.sx).toBeLessThan(full);        // ...but less than a chip's
  });
});
