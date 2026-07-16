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
  left: boolean;          // has the cursor LEFT the chip's box yet? Latched once true. Bringing the
                          // carried thing home only cancels after you have actually taken it away —
                          // without this the gesture would cancel on the press itself, since the
                          // cursor starts on the chip.
  vx: number;             // tracked cursor velocity, px/s — drives the flex
  vy: number;
  lastMoveAt: number;     // performance.now() of the last pointermove, to derive that velocity
  flex: Flex;             // the outline's elastic spring, stepped once per frame by the layer
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

// ---- flex -------------------------------------------------------------------------------------
// The carried chip's outline is a little elastic: it flexes with how you move and how fast, then
// springs back and RINGS when you stop. The ring is the point, which is why this is a spring and not
// a lerp — a lerp eases to its target and stops dead, it can never overshoot.
//
// AXIS-ALIGNED, never rotated. An earlier version rotated the chip into its direction of travel,
// which sent it spinning around as you dragged; a device chip must stay upright and read as itself.
// So the flex is a single SIGNED number instead of an angled axis: + is wide-and-short, - is
// narrow-and-tall, and there is no angle to track at all.

/** Cursor speed (px/s), per axis, that produces the full flex. STARTING GUESS — tune in the browser. */
export const FLEX_SPEED_FULL = 1600;
/** Hardest flex, as a fraction. Deliberately gentle: this is a device chip being carried, not slime
 *  — its outline should give a little, not wobble like jelly. */
export const FLEX_MAX = 0.16;
/** Spring constant and damping. Lower damping = looser, wobblier. STARTING GUESSES. */
export const FLEX_STIFF = 260;
export const FLEX_DAMP = 13;
/** Per-second decay of the tracked velocity when the cursor stops sending moves. Without it the chip
 *  would stay flexed forever the moment you held still. */
export const VEL_DECAY = 0.006;

export interface Flex {
  stretch: number;  // SIGNED: >0 wide-and-short, <0 narrow-and-tall, 0 = the chip's true shape
  v: number;        // the spring's velocity — what carries it past the target and back
}

export const restingFlex = (): Flex => ({ stretch: 0, v: 0 });

const axisFlex = (v: number) => Math.min(FLEX_MAX, (Math.abs(v) / FLEX_SPEED_FULL) * FLEX_MAX);

/** How the chip WANTS to be flexed for a given velocity. Moving sideways stretches it wide and
 *  squashes it short; moving up or down does the reverse; a perfect diagonal cancels to no flex,
 *  which is the honest answer when the shape cannot rotate. */
export function flexTarget(vx: number, vy: number): number {
  return axisFlex(vx) - axisFlex(vy);
}

/** One step of the flex spring. `dt` in SECONDS. Pure: the caller owns the state, this only advances
 *  it (same split as the patch cable's rope).
 *  dt is clamped: a backgrounded tab hands back a huge dt on its first frame, and an unclamped
 *  spring integrates that into a violent explosion. */
export function stepFlex(f: Flex, target: number, dt: number): Flex {
  const d = Math.min(Math.max(dt, 0), 1 / 30);
  const a = (target - f.stretch) * FLEX_STIFF - f.v * FLEX_DAMP;
  const v = f.v + a * d;
  return { stretch: f.stretch + v * d, v };
}

/** Per-axis scale. Volume-preserving: what it gains across it gives back down, so the chip never
 *  appears to grow or shrink as it flexes. Clamped so an overshoot can never invert it. */
export function flexScale(stretch: number): { sx: number; sy: number } {
  const sx = Math.max(0.2, 1 + stretch);
  return { sx, sy: 1 / sx };
}

/** Is the cursor over the chip's own box? Used two ways: to latch `left` once you have taken the
 *  chip away, and after that to cancel the placement when you bring it home. The chip's own box is
 *  the bound rather than an invented radius — "back where it came from" is exactly that. */
export function overChip(at: Vec, p: PullState): boolean {
  return Math.abs(at.x - p.chip.x) <= p.chipSize.w / 2 && Math.abs(at.y - p.chip.y) <= p.chipSize.h / 2;
}

/** Should this pull be cancelled? True once the carried thing — chip or opened device — has been
 *  taken off the chip and then brought back onto it. Bringing it home puts it back and adds nothing. */
export function cancelledHome(p: PullState): boolean {
  return p.left && overChip({ x: p.x, y: p.y }, p);
}

/** Is the carried chip close enough to the rack to open into a device? Horizontal distance only —
 *  see RACK_LATCH_X. `rackCentreX` is the rack's centre line in viewport px; null when the canvas
 *  isn't measurable, in which case never open on a guess. */
export function nearRack(boxX: number, rackCentreX: number | null): boolean {
  return rackCentreX !== null && Math.abs(boxX - rackCentreX) <= RACK_LATCH_X;
}

/** The chip's label inset (Tailwind `px-3`). Where the name starts before it travels to the centre. */
export const LABEL_INSET = 12;

/** Everything needed to paint one frame. PURE: same state + same clock => same pixels. Both the
 *  first paint and the rAF loop call THIS — computing the geometry twice, in two places, is how they
 *  drifted apart once already (the box collapsed the frame after it latched).
 *  `openness` runs 0 (a chip) -> 1 (the device), and drives size, corner radius and the cross-fade
 *  between the chip's label and the device's face. It OVERSHOOTS 1 mid-spring — that is the elastic
 *  pop — so anything used as an opacity must clamp it. */
export function pullGeometry(p: PullState, scale: number, now: number): {
  at: Vec; size: Size; radius: number; opacity: number; openness: number;
  flex: { sx: number; sy: number };
} {
  const flex = flexScale(p.flex.stretch);

  if (p.phase === "snapback") {
    const k = clamp01((now - p.snapStart) / SNAP_MS);
    const from = p.snapFrom ?? p.chip;
    const at = { x: from.x + (p.chip.x - from.x) * k, y: from.y + (p.chip.y - from.y) * k };
    const s = p.snapSize ?? p.chipSize;
    return { at, size: { w: s.w * (1 - k), h: s.h * (1 - k) }, radius: CHIP_R,
      opacity: (1 - k) * BOX_OPACITY, openness: 0, flex };
  }

  const at = { x: p.x, y: p.y };

  if (p.phase === "solid") {
    const g = latchGrow((now - p.snapStart) / SNAP_MS);
    const full = { w: RACK_INTERIOR_W * scale, h: RU_PX * scale };
    return { at, size: lerpSize(p.chipSize, full, g),
      radius: CHIP_R + (CORNER_R - CHIP_R) * clamp01(g),
      opacity: BOX_OPACITY, openness: g, flex };
  }

  // Still a chip: exactly the size you picked up, under the cursor.
  return { at, size: p.chipSize, radius: CHIP_R, opacity: BOX_OPACITY, openness: 0, flex };
}
