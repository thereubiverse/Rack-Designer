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

/** Spring for the latch — overshoots 1 and rings down. Pinned to 0 and 1 at the ends. */
export function easeOutElastic(t: number): number {
  const c = clamp01(t);
  if (c === 0 || c === 1) return c;
  const p = 0.3;
  return Math.pow(2, -10 * c) * Math.sin(((c - p / 4) * (2 * Math.PI)) / p) + 1;
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
