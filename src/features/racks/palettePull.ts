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
/** Duration (ms) of the snap-back home. STARTING GUESS. */
export const SNAP_MS = 260;
/** The palette chip's own corner radius (Tailwind `rounded-lg`). The carried chip starts here and
 *  morphs to the device's CORNER_R as it opens, so the silhouette is continuous. */
export const CHIP_R = 8;

export interface Vec { x: number; y: number }
export interface Size { w: number; h: number }

export type PullPhase = "pulling" | "snapback";

export interface PullState {
  typeId: string;
  label: string;      // the chip's text — carried, and cross-faded out as the device appears
  chip: Vec;          // chip centre, viewport coords — where a snap-back returns to
  grab: Vec;          // chip centre MINUS the cursor at pickup. Held so the chip stays exactly where
                      // you grabbed it instead of teleporting its middle under your cursor.
  chipSize: Size;     // the chip's own box: the carried thing IS this size until it opens
  x: number;          // live pointer, viewport coords
  y: number;
  phase: PullPhase;
  snapFrom: Vec | null;   // where the box was when the pull was abandoned
  snapStart: number;      // performance.now() at the start of the snap-back (also the open clock)
  snapSize: Size | null;  // how big the box was when abandoned — the snap-back shrinks from THERE,
                          // whether it was still a chip or had already opened into a device
  vx: number;             // tracked cursor velocity, px/s — drives the flex
  vy: number;
  lastMoveAt: number;     // performance.now() of the last pointermove, to derive that velocity
  flex: Flex;             // the outline's elastic spring, stepped once per frame by the layer
}

/** Carried opacity — translucent so the rack and its rails read through what you are holding. It
 *  returns to a solid 1 as it lands back home, so the hand-off to the real chip is invisible. */
export const BOX_OPACITY = 0.85;
/** The palette button's own border (`border-neutral-200`). What the carried chip's blue fades back to
 *  as it lands, so the swap to the real button underneath cannot be seen. */
export const CHIP_BORDER = "#e5e5e5";

const clamp01 = (t: number) => (t > 1 ? 1 : t > 0 ? t : 0);
const lerpSize = (a: Size, b: Size, k: number): Size => ({ w: a.w + (b.w - a.w) * k, h: a.h + (b.h - a.h) * k });

/** Position-driven open, 0 (a chip) -> 1 (the device). It spans the WHOLE journey: 0 where the chip
 *  was picked up, 1 exactly at the rack's centre, every point between mapping 1:1 to how far you have
 *  dragged. So the transition begins the moment you start carrying it and ends precisely when the
 *  device reaches the centre — there is no clock, and dragging back out runs it in reverse.
 *  The origin is the cursor's position AT PICKUP (chip centre minus the grab offset), so reveal is
 *  exactly 0 on the first frame. Horizontal only, and cursor x not the box's — the box centres on
 *  the cursor as it opens, so using the box would be circular. Null rack => a chip. */
export function openReveal(p: PullState, rackCentreX: number | null): number {
  if (rackCentreX === null) return 0;
  const originX = p.chip.x - p.grab.x;              // where the cursor was when you picked it up
  const d0 = Math.abs(originX - rackCentreX);       // the full distance from there to the centre
  if (d0 < 1) return 1;                             // picked up on the rack itself (unreachable) => open
  // easeOUT, not ease-in-out: it must BEGIN visibly the instant you start carrying it, not crawl for
  // the first third. Fast off the mark, gently settling as it arrives at the centre.
  return easeOutCubic(1 - Math.abs(p.x - rackCentreX) / d0);
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

/** Is the carried thing close enough to the rack to be a device? Horizontal distance only — see
 *  RACK_LATCH_X. `rackCentreX` is the rack's centre line in viewport px; null when the canvas isn't
 *  measurable, in which case never open on a guess.
 *  This is the ONLY rule: near the rack it is a device, away from it a chip, and crossing the line
 *  either way flips it. Carrying it home to the palette needs no rule of its own — the palette is
 *  far from the rack, so coming home IS leaving the rack, and releasing there adds nothing because
 *  any release off a free RU already snaps back. */
export function nearRack(boxX: number, rackCentreX: number | null): boolean {
  return rackCentreX !== null && Math.abs(boxX - rackCentreX) <= RACK_LATCH_X;
}

/** The chip's label inset (Tailwind `px-3`). Where the name starts before it travels to the centre. */
export const LABEL_INSET = 12;

/** Ease for the flight home: fast away, gently settling. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** Everything needed to paint one frame. PURE: same state + same clock => same pixels. Both the
 *  first paint and the rAF loop call THIS — computing the geometry twice, in two places, is how they
 *  drifted apart once already (the box collapsed the frame after it latched).
 *  `openness` runs 0 (a chip) -> 1 (the device), and drives size, corner radius and the cross-fade
 *  between the chip's label and the device's face. It OVERSHOOTS 1 mid-spring — that is the elastic
 *  pop — so anything used as an opacity must clamp it. */
export function pullGeometry(p: PullState, scale: number, rackCentreX: number | null, now: number): {
  at: Vec; size: Size; radius: number; opacity: number; reveal: number; homing: number;
  flex: { sx: number; sy: number };
} {
  const flex = flexScale(p.flex.stretch);

  if (p.phase === "snapback") {
    // It FLIES HOME and lands in its slot — it does not evaporate. By k=1 every property equals the
    // real chip's exactly (its position, its size, its radius, its border, fully opaque), so when
    // the layer unmounts and the real button reappears there is nothing to see.
    const k = easeOutCubic((now - p.snapStart) / SNAP_MS);
    const from = p.snapFrom ?? p.chip;
    const s = p.snapSize ?? p.chipSize;
    return {
      at: { x: from.x + (p.chip.x - from.x) * k, y: from.y + (p.chip.y - from.y) * k },
      size: lerpSize(s, p.chipSize, k),
      radius: CHIP_R,
      opacity: BOX_OPACITY + (1 - BOX_OPACITY) * k,
      reveal: 0,
      homing: k,           // 0 = still carried and blue, 1 = landed and indistinguishable
      // The flex relaxes to nothing as it lands. It is still ringing when you let go, and a box that
      // touches down mid-wobble is a couple of px wider than the chip it is handing off to — enough
      // to see. Forcing it to rest by k=1 is what makes the last frame EXACTLY the chip.
      flex: { sx: 1 + (flex.sx - 1) * (1 - k), sy: 1 + (flex.sy - 1) * (1 - k) },
    };
  }

  // Position-driven open: how far the DEVICE has formed is exactly how far the cursor has been
  // dragged toward the rack's centre. There is no clock — `reveal` reverses the instant you drag
  // back out, so opening and closing are the same motion run forwards and backwards. Everything
  // below rides this one value, so the shape, the radius and the name's travel all complete
  // together, precisely when the device reaches the centre.
  const reveal = openReveal(p, rackCentreX);
  // Anchored to where you grabbed it — the chip does not jump its middle under the cursor on pickup.
  // The offset fades out as it opens, so the device ends up centred on the cursor, which is what
  // decides the RU it drops on: what you see is what you get.
  const at = { x: p.x + p.grab.x * (1 - reveal), y: p.y + p.grab.y * (1 - reveal) };
  // The elastic outline belongs to the CHIP. A rack device is not slime — it should read crisp and
  // still — so the flex fades out as it opens.
  const easedFlex = { sx: 1 + (flex.sx - 1) * (1 - reveal), sy: 1 + (flex.sy - 1) * (1 - reveal) };
  const full = { w: RACK_INTERIOR_W * scale, h: RU_PX * scale };
  return {
    at,
    size: lerpSize(p.chipSize, full, reveal),
    radius: CHIP_R + (CORNER_R - CHIP_R) * reveal,
    opacity: BOX_OPACITY,
    reveal,
    homing: 0,
    flex: easedFlex,
  };
}

