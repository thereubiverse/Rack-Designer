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
  vx: number;             // tracked cursor velocity, px/s — drives the jiggle
  vy: number;
  lastMoveAt: number;     // performance.now() of the last pointermove, to derive that velocity
  jiggle: Jiggle;         // the soft-body spring, stepped once per frame by the layer
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

/** The blob at full swell: a featureless SQUARE lump, sized off the chip's height so it scales with
 *  it. Deliberately nowhere near RU size — the blob must never look like the device it becomes. */
export function blobTarget(chip: Size): Size {
  return { w: chip.h, h: chip.h };
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

/** How far the blob must get from the chip's edge before the neck has thinned to nothing and let go.
 *  STARTING GUESS — tune in the browser. */
export const NECK_SNAP = 90;

/** The point on the chip's OUTLINE the goo tears from: the closest point on the chip's box to the
 *  blob. Clamping to the box means that while the cursor is still inside the chip this returns the
 *  blob's own centre — length zero, so no neck is drawn at all and nothing appears. That is the
 *  whole trick, and it is why the neck must never be rooted at the chip's CENTRE: a centre-rooted
 *  neck always has length, so it drew a spike across the chip's own face (the "arrow"). */
export function chipExit(p: PullState, at: Vec): Vec {
  const hw = p.chipSize.w / 2, hh = p.chipSize.h / 2;
  return {
    x: Math.max(p.chip.x - hw, Math.min(p.chip.x + hw, at.x)),
    y: Math.max(p.chip.y - hh, Math.min(p.chip.y + hh, at.y)),
  };
}

/** Half-width of the neck where it leaves the chip's edge. Thins to nothing as the blob pulls away,
 *  which is what pinches the waist and finally snaps it. */
export function neckRootW(chipH: number, gap: number): number {
  return (chipH * 0.42) * (1 - clamp01(gap / NECK_SNAP));
}

/** The molten thread between the chip's exit point and the blob: a closed ribbon, pinched at the
 *  waist. Empty once the root has thinned away, or while the blob is still inside the chip (where
 *  exit === at, so there is nothing to span).
 *  The goo filter alone cannot do this: a metaball only fuses within ~2x its blur, so at any usable
 *  blur the blob would tear free the instant it cleared the chip's edge, with no thread at all. The
 *  filter's job is only to fillet this ribbon's joins into the chip and the blob. */
export function neckPath(exit: Vec, at: Vec, rootW: number, tipW: number): string {
  const dx = at.x - exit.x, dy = at.y - exit.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5 || rootW <= 0) return "";
  const nx = -dy / len, ny = dx / len;
  const mx = (exit.x + at.x) / 2, my = (exit.y + at.y) / 2;
  const waist = Math.min(rootW, tipW) * 0.45;
  return [
    `M ${exit.x + nx * rootW} ${exit.y + ny * rootW}`,
    `Q ${mx + nx * waist} ${my + ny * waist} ${at.x + nx * tipW} ${at.y + ny * tipW}`,
    `L ${at.x - nx * tipW} ${at.y - ny * tipW}`,
    `Q ${mx - nx * waist} ${my - ny * waist} ${exit.x - nx * rootW} ${exit.y - ny * rootW}`,
    "Z",
  ].join(" ");
}

// ---- jiggle -----------------------------------------------------------------------------------
// The blob is a soft body: it stretches along the way it is being flung and squashes across, then
// springs back and RINGS when you stop. The ring is the whole point, which is why this is a spring
// and not a lerp — a lerp eases to the target and stops dead, it can never overshoot.

/** Cursor speed (px/s) that produces the full stretch. STARTING GUESS — tune in the browser. */
export const JIGGLE_SPEED_FULL = 1600;
/** Hardest squash-and-stretch, as a fraction. 0.45 = up to 145% along, ~69% across. */
export const JIGGLE_MAX = 0.45;
/** Spring constant and damping. Lower damping = looser, wobblier, more rings before it settles.
 *  STARTING GUESSES — tune in the browser. */
export const JIGGLE_STIFF = 260;
export const JIGGLE_DAMP = 13;
/** Per-second decay applied to the tracked velocity when the cursor stops sending moves. Without
 *  this the blob would stay stretched forever the moment you held still. */
export const VEL_DECAY = 0.006;

export interface Jiggle {
  stretch: number;  // current squash-and-stretch, 0 = a resting square
  v: number;        // the spring's velocity — this is what carries it past the target and back
  angle: number;    // radians; the direction the stretch points, held when the cursor stops
}

export const restingJiggle = (): Jiggle => ({ stretch: 0, v: 0, angle: 0 });

/** How stretched the blob WANTS to be at a given cursor speed. Clamped: flinging it faster than
 *  JIGGLE_SPEED_FULL cannot tear it into a needle. */
export function jiggleTarget(speed: number): number {
  return Math.min(JIGGLE_MAX, (Math.abs(speed) / JIGGLE_SPEED_FULL) * JIGGLE_MAX);
}

/** One step of the jiggle spring. `dt` in SECONDS. Pure: same input, same output — the caller owns
 *  the state, this only advances it (same split as the patch cable's rope).
 *  dt is clamped: a backgrounded tab hands back a huge dt on its first frame, and an unclamped
 *  spring integrates that into a violent explosion. */
export function stepJiggle(j: Jiggle, target: number, angle: number, dt: number): Jiggle {
  const d = Math.min(Math.max(dt, 0), 1 / 30);
  const a = (target - j.stretch) * JIGGLE_STIFF - j.v * JIGGLE_DAMP;
  const v = j.v + a * d;
  return { stretch: j.stretch + v * d, v, angle: target > 0.001 ? angle : j.angle };
}

/** Squash-and-stretch scales. Volume-preserving: whatever it gains along the direction of travel it
 *  gives back across it, so the lump never appears to grow or shrink as it jiggles. */
export function jiggleScale(stretch: number): { along: number; across: number } {
  const along = Math.max(0.05, 1 + stretch);
  return { along, across: 1 / along };
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
 *  no "am I still over the chip?" flag — while it is inside the chip the neck has zero length and the
 *  union's silhouette is just the chip, so nothing appears on its own. */
export function pullGeometry(p: PullState, scale: number, now: number): {
  at: Vec; size: Size; opacity: number; solid: boolean; neck: string;
  jiggle: { along: number; across: number; angle: number };
} {
  if (p.phase === "snapback") {
    // Melts back into slime on the way home: whatever it was, it retreats as a blob and is sucked
    // in. That is why there is no "was it solid?" flag to carry — reverting to goo IS the answer.
    const k = clamp01((now - p.snapStart) / SNAP_MS);
    const from = p.snapFrom ?? p.chip;
    const at = { x: from.x + (p.chip.x - from.x) * k, y: from.y + (p.chip.y - from.y) * k };
    const s = p.snapSize ?? blobTarget(p.chipSize);
    const size = { w: s.w * (1 - k), h: s.h * (1 - k) };
    const exit = chipExit(p, at);
    const gap = Math.hypot(at.x - exit.x, at.y - exit.y);
    return { at, size, opacity: (1 - k) * BOX_OPACITY, solid: false,
      neck: neckPath(exit, at, neckRootW(p.chipSize.h, gap), size.h / 2),
      jiggle: { ...jiggleScale(p.jiggle.stretch), angle: p.jiggle.angle } };
  }

  // The blob is exactly under the cursor. No lag curve: the thing you are dragging is where you
  // point. (An earlier version eased its travel out of the chip, which read as the blob sliding
  // around under your finger.)
  const at = { x: p.x, y: p.y };

  if (p.phase === "solid") {
    // Reached the rack: grow the lump into a full RU, springing past it and ringing back. It starts
    // at the blob's size, so latchGrow's 0-at-k=0 is exactly right here.
    const k = (now - p.snapStart) / SNAP_MS;
    const full = { w: RACK_INTERIOR_W * scale, h: RU_PX * scale };
    // A solid device does not jiggle — it is a rack device now, not slime.
    return { at, size: lerpSize(blobTarget(p.chipSize), full, latchGrow(k)), opacity: BOX_OPACITY,
      solid: true, neck: "", jiggle: { along: 1, across: 1, angle: 0 } };
  }

  const size = blobSize(pullT(p), p.chipSize);
  const exit = chipExit(p, at);
  const gap = Math.hypot(at.x - exit.x, at.y - exit.y);
  return { at, size, opacity: BOX_OPACITY, solid: false,
    neck: neckPath(exit, at, neckRootW(p.chipSize.h, gap), size.h / 2),
    jiggle: { ...jiggleScale(p.jiggle.stretch), angle: p.jiggle.angle } };
}
