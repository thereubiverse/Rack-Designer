import { describe, it, expect } from "vitest";
import {
  SNAP_MS, RACK_LATCH_X, BOX_OPACITY, CHIP_R, FLEX_MAX, FLEX_SPEED_FULL,
  restingFlex, flexTarget, stepFlex, flexScale, latchGrow, pullGeometry, nearRack,
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
    typeId: "t1", label: "Switch", chip, grab: { x: 0, y: 0 }, chipSize: CHIP_BOX, x: 100, y: 100, phase: "pulling",
    snapFrom: null, snapStart: 0, snapSize: null,
    openFrom: null, closeFrom: null, closeStart: 0,
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

  it("snapback starts from exactly where and what the box actually was", () => {
    const snapFrom = { x: 400, y: 100 }, snapSize = { w: 300, h: 40 };
    const p: PullState = { ...base, phase: "snapback", snapFrom, snapSize, snapStart: 2000 };
    const start = pullGeometry(p, 1, 2000);
    expect(start.at).toEqual(snapFrom);
    expect(start.size).toEqual(snapSize);       // never jumps to an assumed size first
    expect(start.opacity).toBeCloseTo(BOX_OPACITY, 5);
    expect(start.homing).toBe(0);               // still carried, still blue
  });

  it("REGRESSION: it FLIES HOME and lands as the chip — it does not evaporate", () => {
    // The hand-off has to be invisible: when the layer unmounts, the real button reappears in that
    // exact spot. So at k=1 every property must equal the chip's — land at 0x0 or half-transparent
    // and you see it pop. This asserts the landed frame IS the chip, property by property.
    const p: PullState = { ...base, phase: "snapback", snapFrom: { x: 400, y: 100 },
      snapSize: { w: 300, h: 40 }, snapStart: 2000 };
    const end = pullGeometry(p, 1, 2000 + SNAP_MS * 5);
    expect(end.at).toEqual(chip);               // in its slot
    expect(end.size).toEqual(CHIP_BOX);         // at the chip's size, NOT nothing
    expect(end.radius).toBe(CHIP_R);
    expect(end.opacity).toBe(1);                // fully opaque, like the real button
    expect(end.homing).toBe(1);                 // and its blue has faded to the chip's own border
    expect(end.openness).toBe(0);               // showing the label, left-aligned, like a chip
    expect(end.flex).toEqual({ sx: 1, sy: 1 }); // and unflexed — see below
  });

  it("REGRESSION: the flex relaxes to nothing by the time it lands", () => {
    // The outline is still ringing when you let go. A box that touches down mid-wobble is a couple
    // of px wider than the chip it hands off to — measured 194 against 192 — and you see the pop.
    const wobbling: PullState = { ...base, phase: "snapback", snapFrom: { x: 400, y: 100 },
      snapSize: CHIP_BOX, snapStart: 2000, flex: { stretch: FLEX_MAX, v: 4 } };
    expect(pullGeometry(wobbling, 1, 2000).flex.sx).toBeGreaterThan(1);        // still wobbling
    expect(pullGeometry(wobbling, 1, 2000 + SNAP_MS * 5).flex).toEqual({ sx: 1, sy: 1 }); // landed flat
  });

  it("the flight home eases rather than running at a constant rate", () => {
    const p: PullState = { ...base, phase: "snapback", snapFrom: { x: 0, y: 0 },
      snapSize: CHIP_BOX, snapStart: 0 };
    // Half way through the CLOCK it should be well past half way HOME — that is the ease-out.
    expect(pullGeometry(p, 1, SNAP_MS / 2).homing).toBeGreaterThan(0.5);
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


describe("crossing the rack line, both ways, in one motion", () => {
  const chip = { x: 100, y: 100 };
  const CHIP_BOX = { w: 132, h: 34 };
  const base: PullState = {
    typeId: "t1", label: "Switch", chip, grab: { x: 0, y: 0 }, chipSize: CHIP_BOX, x: 100, y: 100, phase: "pulling",
    snapFrom: null, snapStart: 0, snapSize: null,
    openFrom: null, closeFrom: null, closeStart: 0,
    vx: 0, vy: 0, lastMoveAt: 0, flex: restingFlex(),
  };

  it("closes from the size it actually WAS, not by jumping straight back to a chip", () => {
    // Reverting a 300px-wide device to a 132px chip in one frame reads as a glitch.
    const wide = { w: 300, h: 40 };
    const p: PullState = { ...base, closeFrom: wide, closeStart: 1000, x: 100, y: 100 };
    const start = pullGeometry(p, 1, 1000);
    expect(start.size).toEqual(wide);         // exactly where it was
    expect(start.openness).toBe(1);           // still fully a device on frame one
  });

  it("finishes the close as an ordinary chip, and stays one", () => {
    const p: PullState = { ...base, closeFrom: { w: 300, h: 40 }, closeStart: 1000 };
    const end = pullGeometry(p, 1, 1000 + SNAP_MS);
    expect(end.size).toEqual(CHIP_BOX);
    expect(end.openness).toBe(0);
    expect(end.radius).toBe(CHIP_R);
    // It settles and stays settled — which is why closeFrom never needs clearing.
    expect(pullGeometry(p, 1, 1000 + SNAP_MS * 50).size).toEqual(CHIP_BOX);
  });

  it("REGRESSION: re-opening resumes from the size it IS, not from the chip's", () => {
    // Bring a device home and turn straight back to the rack before the close finishes. Assuming
    // the chip's size here makes the box visibly jump backwards before growing again.
    const mid = { w: 240, h: 38 };
    const p: PullState = { ...base, phase: "solid", openFrom: mid, snapStart: 1000, x: 400, y: 100 };
    expect(pullGeometry(p, 1, 1000).size).toEqual(mid);
  });

  it("without an openFrom it still opens from the chip — the ordinary first pull", () => {
    const p: PullState = { ...base, phase: "solid", openFrom: null, snapStart: 1000, x: 400, y: 100 };
    expect(pullGeometry(p, 1, 1000).size).toEqual(CHIP_BOX);
  });
});

describe("anchored to the cursor", () => {
  const chip = { x: 100, y: 100 };
  const CHIP_BOX = { w: 132, h: 34 };
  const grab = { x: 40, y: -8 };   // grabbed left of and below the chip's middle
  const base: PullState = {
    typeId: "t1", label: "Switch", chip, grab, chipSize: CHIP_BOX, x: 100, y: 100, phase: "pulling",
    snapFrom: null, snapStart: 0, snapSize: null,
    openFrom: null, closeFrom: null, closeStart: 0,
    vx: 0, vy: 0, lastMoveAt: 0, flex: restingFlex(),
  };

  it("REGRESSION: the chip keeps the grab offset — it does not teleport its middle to the cursor", () => {
    // Grab a chip near its edge and the old code snapped its centre under the cursor: the chip
    // visibly jumped the instant you touched it, which is the opposite of picking something up.
    const p: PullState = { ...base, x: 500, y: 300 };
    expect(pullGeometry(p, 1, 0).at).toEqual({ x: 500 + grab.x, y: 300 + grab.y });
  });

  it("but the OPEN device is centred on the cursor — the cursor picks the RU it lands on", () => {
    // What you see has to be what you get: the strip under the cursor decides the RU, so an
    // offset device would drop somewhere other than where it looks.
    const p: PullState = { ...base, phase: "solid", openFrom: CHIP_BOX, snapStart: 0, x: 500, y: 300 };
    const g = pullGeometry(p, 1, SNAP_MS * 5);   // fully open
    expect(g.openness).toBe(1);
    expect(g.at).toEqual({ x: 500, y: 300 });
  });

  it("the offset fades out as it opens rather than snapping away", () => {
    const mid: PullState = { ...base, phase: "solid", openFrom: CHIP_BOX, snapStart: 0, x: 500, y: 300 };
    const g = pullGeometry(mid, 1, SNAP_MS * 0.35);
    expect(g.openness).toBeGreaterThan(0);
    expect(g.openness).toBeLessThan(1);
    expect(g.at.x).toBeGreaterThan(500);          // still partly anchored...
    expect(g.at.x).toBeLessThan(500 + grab.x);    // ...but on its way to the cursor
  });
});
