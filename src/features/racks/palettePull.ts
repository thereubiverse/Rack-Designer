// src/features/racks/palettePull.ts
// PURE maths for the palette -> rack "goo pull": pressing a device chip pulls a blank device out of
// it like a piece of gooey slime, which grows to the size of one RU and then snaps solid.
// No React, no DOM — every number and shape the gesture needs lives here so it can be tested
// directly and tuned in one place (same split as connectionOps/PatchLayer).
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";

/** Pointer distance from the chip at which the box reaches full RU size and latches solid.
 *  STARTING GUESS — tune in the browser with the user, like the patch cable's rope constants. */
export const PULL_DIST = 140;
/** Snap-back duration (ms) when a pull is abandoned. STARTING GUESS — tune in the browser. */
export const SNAP_MS = 260;

export interface Vec { x: number; y: number }
export interface Size { w: number; h: number }

export type PullPhase = "pulling" | "solid" | "snapback";

export interface PullState {
  typeId: string;
  chip: Vec;          // chip centre, viewport coords
  chipSize: Size;     // the chip's own box — where the blob starts
  x: number;          // live pointer, viewport coords
  y: number;
  phase: PullPhase;
  snapFrom: Vec | null; // where the box was when the pull was abandoned
  snapStart: number;    // performance.now() at the start of the snap-back
}

/** Carried box opacity — translucent so the rack and its rails read through it. */
export const BOX_OPACITY = 0.75;

const clamp01 = (t: number) => (t > 1 ? 1 : t > 0 ? t : 0);

/** Raw pull progress 0..1 from the pointer's distance to the chip. */
export function pullProgress(dist: number): number {
  return clamp01(dist / PULL_DIST);
}

/** Growth easing: the blob swells fast then settles as it approaches full size. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** Latch spring: 1 at k=0 — the box is ALREADY full size when it goes solid — then overshoots and
 *  rings down to 1. NOT easeOutElastic, which starts at 0 and would collapse the box to nothing at
 *  the exact moment it solidifies and pop it back. Amplitude/period are STARTING GUESSES to tune. */
export function latchScale(k: number): number {
  const c = clamp01(k);
  if (c >= 1) return 1;
  const A = 0.12;   // overshoot amplitude — STARTING GUESS, tuned in the browser later
  const period = 0.35; // ring period — STARTING GUESS
  return 1 + A * Math.pow(2, -9 * c) * Math.sin((2 * Math.PI * c) / period);
}

/** The carried box's size at progress `t`, in CSS px, for a rack canvas at `scale`.
 *  At t=1 it is EXACTLY one RU of rack — the space it will occupy once dropped. */
export function boxSize(t: number, scale: number, chip: Size): Size {
  const e = easeOutCubic(t);
  const fullW = RACK_INTERIOR_W * scale;
  const fullH = RU_PX * scale;
  return { w: chip.w + (fullW - chip.w) * e, h: chip.h + (fullH - chip.h) * e };
}

/** Half-width of the gooey neck where it leaves the chip. Thins to nothing as the pull stretches. */
export function neckHalfWidth(chipH: number, t: number): number {
  return (chipH / 2) * (1 - clamp01(t));
}

/** The gooey neck: a closed ribbon from the chip to the box, pinched at the waist like slime being
 *  pulled apart. Viewport coordinates. Returns "" once t reaches 1 — the neck has snapped. */
export function neckPath(chip: Vec, box: Vec, t: number, chipH: number): string {
  if (t >= 1) return "";
  const w = neckHalfWidth(chipH, t);
  const dx = box.x - chip.x, dy = box.y - chip.y;
  const len = Math.hypot(dx, dy) || 1; // || 1 guards the zero-length pull (pointer still on the chip)
  const nx = -dy / len, ny = dx / len; // unit normal to the pull direction
  const mx = (chip.x + box.x) / 2, my = (chip.y + box.y) / 2;
  const waist = w * 0.35;              // the neck pinches in the middle
  return [
    `M ${chip.x + nx * w} ${chip.y + ny * w}`,
    `Q ${mx + nx * waist} ${my + ny * waist} ${box.x} ${box.y}`,
    `Q ${mx - nx * waist} ${my - ny * waist} ${chip.x - nx * w} ${chip.y - ny * w}`,
    "Z",
  ].join(" ");
}

/** Everything needed to paint one frame of a pull. PURE: same state + same clock => same pixels.
 *  Both the first paint and the rAF loop call THIS — computing the geometry twice, in two places,
 *  is how they drifted apart (the box collapsed to nothing the frame after it latched solid). */
export function pullGeometry(p: PullState, scale: number, now: number): {
  at: Vec; size: Size; neck: string; opacity: number;
} {
  if (p.phase === "snapback") {
    const k = clamp01((now - p.snapStart) / SNAP_MS);
    const from = p.snapFrom ?? p.chip;
    const at = { x: from.x + (p.chip.x - from.x) * k, y: from.y + (p.chip.y - from.y) * k };
    return { at, size: boxSize(1 - k, scale, p.chipSize), neck: "", opacity: (1 - k) * BOX_OPACITY };
  }

  const t = p.phase === "solid" ? 1 : pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y));
  const at = { x: p.x, y: p.y };
  let size = boxSize(t, scale, p.chipSize);
  if (p.phase === "solid") {
    // Spring on the moment it went solid: the box is ALREADY full size, so it overshoots and rings
    // down to exactly one RU — never collapses.
    const k = (now - p.snapStart) / SNAP_MS;
    const latch = latchScale(k);
    size = { w: RACK_INTERIOR_W * scale * latch, h: RU_PX * scale * latch };
  }
  return { at, size, neck: neckPath(p.chip, at, t, p.chipSize.h), opacity: BOX_OPACITY };
}
