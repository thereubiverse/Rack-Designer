// src/features/racks/palettePull.ts
// PURE maths for the palette -> rack "goo pull": pressing a device chip rips a lump of white slime
// off it, like splitting a cell. The lump stays a featureless blob while you carry it, and only
// solidifies into a blank rack device once it nears the rack's centre line — the device forms where
// it is about to live, not in your palette.
//
// There is NO hand-rolled neck here any more. The chip and the blob are drawn as one gooey mass
// (an SVG metaball filter — see PalettePullLayer), so the stretching, the pinching waist and the
// snap all fall out of the filter for free. The old neckPath drew a tapered spike from the chip's
// CENTRE, which read as a stray arrow whenever the blob still lagged inside the chip's own bounds.
// No React, no DOM — every number the gesture needs lives here so it can be tested directly and
// tuned in one place (same split as connectionOps/PatchLayer).
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";

/** Pointer distance from the chip over which the blob swells to its full lump. Also how far you
 *  must drag for the goo to stretch thin and let go.
 *  STARTING GUESS — tune in the browser with the user, like the patch cable's rope constants. */
export const PULL_DIST = 140;
/** How close the blob's centre must get, HORIZONTALLY, to the rack's centre line before it
 *  solidifies into a blank device. Horizontal only, deliberately: the rack is tall, so any distance
 *  measured to its centre POINT would leave the top and bottom RUs permanently un-droppable.
 *  Viewport px. Tuned against the live layout: the palette chips sit only ~290px from the rack's
 *  centre, so anything much larger solidifies the blob almost the moment it comes free and there is
 *  no carry phase to see. 150 is roughly the rack's own edge at fit zoom (RACK_INTERIOR_W * ~0.355
 *  / 2 ≈ 162), so the lump becomes a device just as it arrives at the rack — which is the point.
 *  Still a tuning knob; it is a fixed viewport distance and does not track zoom. */
export const RACK_LATCH_X = 150;
/** Snap-back duration (ms) when a pull is abandoned. STARTING GUESS — tune in the browser. */
export const SNAP_MS = 260;

export interface Vec { x: number; y: number }
export interface Size { w: number; h: number }

export type PullPhase = "pulling" | "solid" | "snapback";

export interface PullState {
  typeId: string;
  label: string;      // the chip's text — the overlay owns the chip's look while pulling, so it has
                      // to redraw the label on top of the goo or the chip appears to go blank
  chip: Vec;          // chip centre, viewport coords
  chipSize: Size;     // the chip's own box — the blob is proportioned off it, and the goo mass
                      // redraws the chip at this size
  x: number;          // live pointer, viewport coords
  y: number;
  phase: PullPhase;
  snapFrom: Vec | null;   // where the box was when the pull was abandoned
  snapStart: number;      // performance.now() at the start of the snap-back (also the latch clock)
  snapSize: Size | null;  // how big the box was when abandoned — the snap-back shrinks from THERE,
                          // whether it was still a blob or had already grown into a device
}

/** Carried box opacity — translucent so the rack and its rails read through it. */
export const BOX_OPACITY = 0.75;

const clamp01 = (t: number) => (t > 1 ? 1 : t > 0 ? t : 0);
const lerpSize = (a: Size, b: Size, k: number): Size => ({ w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

/** Raw pull progress 0..1 from the pointer's distance to the chip. Drives the blob swelling. */
export function pullProgress(dist: number): number {
  return clamp01(dist / PULL_DIST);
}

/** Growth easing: the blob swells fast then settles. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** Grow-and-spring for the latch: 0 at k=0, overshoots 1, rings down to 1. Used to lerp the BLOB's
 *  size up to one RU. Starting at 0 is correct HERE precisely because the box is still blob-sized
 *  when it solidifies — it has something to grow from. (An earlier version applied this shape to a
 *  box that was already full size, which collapsed it to nothing and popped it back. The curve was
 *  never the bug; applying it to the wrong starting size was.) */
export function latchGrow(k: number): number {
  const c = clamp01(k);
  if (c === 0 || c >= 1) return c === 0 ? 0 : 1;
  const period = 0.3; // ring period — STARTING GUESS, tune in the browser
  return Math.pow(2, -10 * c) * Math.sin(((c - period / 4) * (2 * Math.PI)) / period) + 1;
}

/** The blob at full swell: a featureless lump, proportioned off the chip so it scales with it.
 *  Deliberately nowhere near RU size — the blob must never look like the device it will become. */
export function blobTarget(chip: Size): Size {
  return { w: chip.h * 1.6, h: chip.h };
}

/** The blob's size at pull progress `t`: a nub inside the chip that swells into a lump as you pull.
 *  It NEVER reaches RU size — only solidifying at the rack does that. */
export function blobSize(t: number, chip: Size): Size {
  const target = blobTarget(chip);
  const nub = { w: target.w * 0.35, h: target.h * 0.35 };
  return lerpSize(nub, target, easeOutCubic(t));
}

/** Pull progress for a live pull. `solid` LATCHES at 1 — dragging back toward the chip after it has
 *  broken off never re-attaches it. */
export function pullT(p: PullState): number {
  return p.phase === "solid" ? 1 : pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y));
}

/** The blob's travel curve, chip -> cursor. Ease-IN on purpose, and NOT the ease-OUT the size uses:
 *  the lump resists near the chip and only whips to the cursor as it tears free, which is what makes
 *  the pull read as sticky. With easeOutCubic here the box was 99% caught up at 77% of the pull — a
 *  ~1px lag, i.e. no visible lag at all. The exponent is a tuning knob: higher = gooier. */
export function easeInLag(t: number): number {
  const c = clamp01(t);
  return c * c;
}

/** Where the box's centre sits. At t=0 it is ON the chip — the blob is still part of the slime, not
 *  under your finger — and it travels to the pointer as you pull, arriving as it tears free.
 *  Not valid for `snapback` (that lerps snapFrom -> chip instead); callers must not use it there. */
export function pullAt(p: PullState): Vec {
  const e = easeInLag(pullT(p));
  return { x: p.chip.x + (p.x - p.chip.x) * e, y: p.chip.y + (p.y - p.chip.y) * e };
}

/** Is the blob close enough to the rack to solidify? Horizontal distance only — see RACK_LATCH_X.
 *  `rackCentreX` is the rack's centre line in viewport px; null when the canvas isn't measurable. */
export function nearRack(boxX: number, rackCentreX: number | null): boolean {
  return rackCentreX !== null && Math.abs(boxX - rackCentreX) <= RACK_LATCH_X;
}

/** Everything needed to paint one frame of a pull. PURE: same state + same clock => same pixels.
 *  Both the first paint and the rAF loop call THIS — computing the geometry twice, in two places,
 *  is how they drifted apart (the box collapsed to nothing the frame after it latched solid).
 *  `solid` tells the painter WHICH shape to draw: a gooey blob, or the blank device. The blob needs
 *  no "am I still over the chip?" flag — the goo filter merges the two into a single outlined mass
 *  while they overlap, so there is never a stray outline inside the chip to suppress. */
export function pullGeometry(p: PullState, scale: number, now: number): {
  at: Vec; size: Size; opacity: number; solid: boolean;
} {
  if (p.phase === "snapback") {
    // Melts back into slime on the way home: whatever it was, it retreats as a blob and is sucked
    // in. That is why there is no "was it solid?" flag to carry — reverting to goo IS the answer.
    const k = clamp01((now - p.snapStart) / SNAP_MS);
    const from = p.snapFrom ?? p.chip;
    const at = { x: from.x + (p.chip.x - from.x) * k, y: from.y + (p.chip.y - from.y) * k };
    const s = p.snapSize ?? blobTarget(p.chipSize);
    return { at, size: { w: s.w * (1 - k), h: s.h * (1 - k) }, opacity: (1 - k) * BOX_OPACITY, solid: false };
  }

  const at = pullAt(p);

  if (p.phase === "solid") {
    // Reached the rack: grow the lump into a full RU, springing past it and ringing back. It starts
    // at the blob's size, so latchGrow's 0-at-k=0 is exactly right here.
    const k = (now - p.snapStart) / SNAP_MS;
    const full = { w: RACK_INTERIOR_W * scale, h: RU_PX * scale };
    return { at, size: lerpSize(blobTarget(p.chipSize), full, latchGrow(k)), opacity: BOX_OPACITY, solid: true };
  }

  return { at, size: blobSize(pullT(p), p.chipSize), opacity: BOX_OPACITY, solid: false };
}
