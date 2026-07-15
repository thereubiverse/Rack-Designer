// src/features/racks/palettePull.ts
// PURE maths for picking a device chip out of the palette and carrying it to the rack.
//
// You pick up the CHIP itself — it turns blue and lifts, keeping a little of the soft-body
// elasticity — and as it approaches the rack's centre line it springs open into the rack device it
// is about to become, already in its selected state. The blue outline you grabbed it by is the same
// blue the selected device wears, so the whole gesture is one continuous object.
//
// This replaced a goo/metaball tear (chip -> neck -> blob -> device). That looked good but said the
// wrong thing: it made the dragged thing a featureless lump you had to mentally map onto a device.
// Carrying the chip itself is both simpler and clearer, and it deleted the filter, the neck geometry
// and the two-pass outline outright.
//
// No React, no DOM — every number the gesture needs lives here so it can be tested directly and
// tuned in one place (same split as connectionOps/PatchLayer).
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { CORNER_R } from "@/features/device-library/faceplate/Faceplate";

/** How close the carried chip's centre must get, HORIZONTALLY, to the rack's centre line before it
 *  springs open into the device. Horizontal only, deliberately: the rack is tall, so any distance
 *  measured to its centre POINT would leave the top and bottom RUs permanently un-droppable.
 *  Viewport px. STARTING GUESS — tune in the browser. */
export const RACK_LATCH_X = 150;
/** Duration (ms) of both the open-into-a-device spring and the snap-back. STARTING GUESS. */
export const SNAP_MS = 260;
/** The palette chip's own corner radius (Tailwind `rounded-lg`). The carried chip starts here and
 *  morphs to the device's CORNER_R as it opens, so the silhouette is continuous. */
export const CHIP_R = 8;

export interface Vec { x: number; y: number }
export interface Size { w: number; h: number }

export type PullPhase = "pulling" | "solid" | "snapback";

export interface PullState {
  typeId: string;
  label: string;      // the chip's text — carried, and cross-faded out as the device appears
  chip: Vec;          // chip centre, viewport coords — where a snap-back returns to
  chipSize: Size;     // the chip's own box: the carried thing IS this size until it opens
  x: number;          // live pointer, viewport coords
  y: number;
  phase: PullPhase;
  snapFrom: Vec | null;   // where the box was when the pull was abandoned
  snapStart: number;      // performance.now() at the start of the snap-back (also the open clock)
  snapSize: Size | null;  // how big the box was when abandoned — the snap-back shrinks from THERE,
                          // whether it was still a chip or had already opened into a device
  vx: number;             // tracked cursor velocity, px/s — drives the jiggle
  vy: number;
  lastMoveAt: number;     // performance.now() of the last pointermove, to derive that velocity
  jiggle: Jiggle;         // the soft-body spring, stepped once per frame by the layer
}

/** Carried opacity — translucent so the rack and its rails read through what you are holding. */
export const BOX_OPACITY = 0.85;

const clamp01 = (t: number) => (t > 1 ? 1 : t > 0 ? t : 0);
const lerpSize = (a: Size, b: Size, k: number): Size => ({ w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

/** The spring that opens the chip into the device: 0 at k=0, overshoots 1, rings down to 1. Starting
 *  at 0 is right because it lerps FROM the chip's size — it has something to grow out of. */
export function latchGrow(k: number): number {
  const c = clamp01(k);
  if (c === 0 || c >= 1) return c === 0 ? 0 : 1;
  const period = 0.3; // ring period — STARTING GUESS, tune in the browser
  return Math.pow(2, -10 * c) * Math.sin(((c - period / 4) * (2 * Math.PI)) / period) + 1;
}

// ---- jiggle -----------------------------------------------------------------------------------
// The carried chip is a soft body: it leans into the way it is being flung and squashes across, then
// springs back and RINGS when you stop. The ring is the point, which is why this is a spring and not
// a lerp — a lerp eases to the target and stops dead, it can never overshoot.

/** Cursor speed (px/s) that produces the full lean. STARTING GUESS — tune in the browser. */
export const JIGGLE_SPEED_FULL = 1600;
/** Hardest squash-and-stretch. Deliberately gentle: this is a device chip being carried, not slime
 *  — it should feel alive, not gelatinous. (It was 0.45 when the carried thing WAS a blob.) */
export const JIGGLE_MAX = 0.16;
/** Spring constant and damping. Lower damping = looser, wobblier. STARTING GUESSES. */
export const JIGGLE_STIFF = 260;
export const JIGGLE_DAMP = 13;
/** Per-second decay of the tracked velocity when the cursor stops sending moves. Without it the chip
 *  would stay leaning forever the moment you held still. */
export const VEL_DECAY = 0.006;

export interface Jiggle {
  stretch: number;  // current squash-and-stretch, 0 = at rest
  v: number;        // the spring's velocity — what carries it past the target and back
  angle: number;    // radians; the direction the lean points, HELD when the cursor stops
}

export const restingJiggle = (): Jiggle => ({ stretch: 0, v: 0, angle: 0 });

/** How much lean the chip WANTS at a given cursor speed. Clamped: flinging it faster than
 *  JIGGLE_SPEED_FULL cannot stretch it into a needle. */
export function jiggleTarget(speed: number): number {
  return Math.min(JIGGLE_MAX, (Math.abs(speed) / JIGGLE_SPEED_FULL) * JIGGLE_MAX);
}

/** One step of the jiggle spring. `dt` in SECONDS. Pure: the caller owns the state, this only
 *  advances it (same split as the patch cable's rope).
 *  dt is clamped: a backgrounded tab hands back a huge dt on its first frame, and an unclamped
 *  spring integrates that into a violent explosion. */
export function stepJiggle(j: Jiggle, target: number, angle: number, dt: number): Jiggle {
  const d = Math.min(Math.max(dt, 0), 1 / 30);
  const a = (target - j.stretch) * JIGGLE_STIFF - j.v * JIGGLE_DAMP;
  const v = j.v + a * d;
  return { stretch: j.stretch + v * d, v, angle: target > 0.001 ? angle : j.angle };
}

/** Squash-and-stretch scales. Volume-preserving: whatever it gains along the direction of travel it
 *  gives back across it, so the chip never appears to grow or shrink as it leans. */
export function jiggleScale(stretch: number): { along: number; across: number } {
  const along = Math.max(0.05, 1 + stretch);
  return { along, across: 1 / along };
}

/** Is the carried chip close enough to the rack to open into a device? Horizontal distance only —
 *  see RACK_LATCH_X. `rackCentreX` is the rack's centre line in viewport px; null when the canvas
 *  isn't measurable, in which case never open on a guess. */
export function nearRack(boxX: number, rackCentreX: number | null): boolean {
  return rackCentreX !== null && Math.abs(boxX - rackCentreX) <= RACK_LATCH_X;
}

/** Everything needed to paint one frame. PURE: same state + same clock => same pixels. Both the
 *  first paint and the rAF loop call THIS — computing the geometry twice, in two places, is how they
 *  drifted apart once already (the box collapsed the frame after it latched).
 *  `openness` runs 0 (a chip) -> 1 (the device), and drives size, corner radius and the cross-fade
 *  between the chip's label and the device's face. It OVERSHOOTS 1 mid-spring — that is the elastic
 *  pop — so anything used as an opacity must clamp it. */
export function pullGeometry(p: PullState, scale: number, now: number): {
  at: Vec; size: Size; radius: number; opacity: number; openness: number;
  jiggle: { along: number; across: number; angle: number };
} {
  const jiggle = { ...jiggleScale(p.jiggle.stretch), angle: p.jiggle.angle };

  if (p.phase === "snapback") {
    const k = clamp01((now - p.snapStart) / SNAP_MS);
    const from = p.snapFrom ?? p.chip;
    const at = { x: from.x + (p.chip.x - from.x) * k, y: from.y + (p.chip.y - from.y) * k };
    const s = p.snapSize ?? p.chipSize;
    return { at, size: { w: s.w * (1 - k), h: s.h * (1 - k) }, radius: CHIP_R,
      opacity: (1 - k) * BOX_OPACITY, openness: 0, jiggle };
  }

  const at = { x: p.x, y: p.y };

  if (p.phase === "solid") {
    const g = latchGrow((now - p.snapStart) / SNAP_MS);
    const full = { w: RACK_INTERIOR_W * scale, h: RU_PX * scale };
    return { at, size: lerpSize(p.chipSize, full, g),
      radius: CHIP_R + (CORNER_R - CHIP_R) * clamp01(g),
      opacity: BOX_OPACITY, openness: g, jiggle };
  }

  // Still a chip: exactly the size you picked up, under the cursor.
  return { at, size: p.chipSize, radius: CHIP_R, opacity: BOX_OPACITY, openness: 0, jiggle };
}
