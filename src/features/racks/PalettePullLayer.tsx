"use client";

// src/features/racks/PalettePullLayer.tsx
// Picking a device chip out of the palette and carrying it to the rack. Fixed, pointer-events:none,
// above the palette and canvas.
//
// ONE element does the whole gesture. You pick up the chip; it wears the selection blue from the
// moment you touch it and its outline flexes a little with how you move it; and as it reaches the
// rack it springs open into the rack device, already selected — same blue border, blue ears.
// Because it is one element that only changes size, radius and what is inside it, there is no
// hand-off, no swap, and nothing to keep in sync.
//
// This replaced a metaball tear (chip -> gooey neck -> blob -> device). The filter, the neck
// geometry and the two-pass outline are all gone with it.
//
// Reads its state from a REF, not props, and writes the DOM inside its own rAF loop — the carried
// chip has to track the pointer 1:1, and a React render per frame would add latency. Same idiom as
// the grip drag in RackCanvas. It owns NO state transitions except stepping the jiggle spring:
// RackBuilder decides when the chip opens and when the snap-back ends.
import { useEffect, useRef, type MutableRefObject } from "react";
import { RK_SELECT, RK_INVALID } from "./RackFrame";
import { frameDims } from "@/domain/faceplate-geometry";
import { pullGeometry, stepFlex, flexTarget, VEL_DECAY, LABEL_INSET, CHIP_BORDER, type PullState } from "./palettePull";

export type { PullPhase, PullState } from "./palettePull";

type Geo = ReturnType<typeof pullGeometry>;

// The palette chip's own text size (Tailwind text-sm = 14px). The label keeps this size relative to
// the CHIP's height, so it scales up with the box: when zoomed in the device is much taller than the
// chip, and a fixed 14px label looked tiny against it.
const BASE_LABEL_PX = 14;

// The ears' share of the device's width, as a % (0.75" ears on a 19" rack ~= 3.95% each end). Each
// ear is a blue bar that EXTENDS INWARD from the blue outline as the device opens — its width is
// EAR_PCT * reveal, anchored at the edge. No device face is drawn on the carried ghost at all: the
// full renderFace, stretched into the box, dragged in stray blue seam lines, grey screw holes, and a
// fixed-radius frame outline whose corners fought the box's own transitioning radius. The ghost is
// just a white box + these two ears + the blue outline + the label.
const _dims = frameDims({ widthIn: 17.5, rackUnits: 1, rackMounted: true });
const EAR_PCT = (_dims.earWidthPx / _dims.frameWidthPx) * 100;

export function PalettePullLayer({ pullRef, scaleOf, rackCentreXOf }: {
  pullRef: MutableRefObject<PullState | null>;
  scaleOf: () => number;
  rackCentreXOf: () => number | null;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const earLRef = useRef<HTMLDivElement | null>(null);
  const earRRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<HTMLDivElement | null>(null);
  const washRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = pullRef.current;
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      if (!p) return;
      // Step the outline's spring once per frame. This lives here, not in RackBuilder, for the same
      // reason the patch cable's rope does: the spring must keep ringing after the cursor STOPS, and
      // pointermove stops firing the moment it does — only frames keep coming.
      // The tracked velocity decays continuously, so holding still relaxes the flex away.
      const decay = Math.pow(VEL_DECAY, Math.min(dt, 1 / 30));
      p.vx *= decay; p.vy *= decay;
      p.flex = stepFlex(p.flex, flexTarget(p.vx, p.vy), dt);
      paint(pullGeometry(p, scaleOf(), rackCentreXOf(), now), p.chipSize.h, p.invalid,
        { box: boxRef.current, label: labelRef.current, outline: outlineRef.current,
          earL: earLRef.current, earR: earRRef.current, wash: washRef.current });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pullRef, scaleOf, rackCentreXOf]);

  if (!pullRef.current) return <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]" />;

  // First paint comes from the ref directly, via the SAME pullGeometry the rAF loop calls above —
  // so the two paths cannot disagree.
  const p = pullRef.current;
  const g = pullGeometry(p, scaleOf(), rackCentreXOf(), performance.now());

  return (
    <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]">
      <div ref={boxRef} data-testid="pull-box" className="absolute left-0 top-0 overflow-hidden bg-white"
        style={boxStyle(g)}>
        {/* Each ear: a blue bar extending inward from the outline as the device opens. No face, so
            no screw holes or seams while carrying — those belong on the DROPPED device only. */}
        <div ref={earLRef} data-testid="pull-ear-l" className="absolute" style={earStyle(g, "left", p.invalid)} />
        <div ref={earRRef} data-testid="pull-ear-r" className="absolute" style={earStyle(g, "right", p.invalid)} />
        {/* Red wash over the whole box when the slot is invalid (occupied / off the rack). A release
            while this shows cancels the placement (no free-RU strip catches it). */}
        <div ref={washRef} data-testid="pull-invalid-wash" className="pointer-events-none absolute inset-0"
          style={washStyle(p.invalid)} />
        {/* The device's name. It rides the whole way: left-aligned on the chip you picked up, then
            travelling to the centre of the device as it opens. It never fades — the name is the one
            thing that identifies what you are placing. */}
        <span ref={labelRef} data-testid="pull-label"
          className="absolute whitespace-nowrap font-medium text-neutral-900"
          style={labelStyle(g, p.chipSize.h)}>{p.label}</span>
        {/* The selection outline, drawn LAST and ON TOP — the same way the rack draws the box around
            a selected device. It has to overlap the device's own outline, not sit outside it: as the
            box's CSS `border` it pushed the face 2px inwards, so the device's grey outline showed as
            a second ring just inside the blue. On top, the blue simply covers it. */}
        <div ref={outlineRef} data-testid="pull-outline" className="pointer-events-none absolute inset-0"
          style={outlineStyle(g, p.invalid)} />
      </div>
    </div>
  );
}

/** `reveal` is monotonic 0..1 by construction, so the label and the ears cannot wobble. Clamp anyway
 *  — a stray value would drive the curtain width negative or the label past the centre. */
const clamp01 = (n: number) => (n > 1 ? 1 : n > 0 ? n : 0);

/** One ear: a blue bar anchored at the outline, extending inward to EAR_PCT * reveal of the box
 *  width. 0 at a chip (no ear), full at the device. Clipped to the box's rounded corners (the box is
 *  overflow-hidden), so the ear's outer corner follows the box radius as it transitions. */
function earStyle(g: Geo, side: "left" | "right", invalid: boolean) {
  return { top: 0, bottom: 0, [side]: 0, width: `${EAR_PCT * clamp01(g.reveal)}%`,
    background: invalid ? RK_INVALID : RK_SELECT };
}

/** The invalid red wash: a translucent red fill over the whole box, off when the slot is valid. */
function washStyle(invalid: boolean) {
  return { background: RK_INVALID, opacity: invalid ? 0.18 : 0 };
}

/** The name travels from the chip's left inset to the device's centre as it opens. Anchor and offset
 *  move together — `left` LABEL_INSET -> w/2 while translateX 0% -> -50% — so the text lands truly
 *  centred without anyone having to measure how wide it is. */
function labelStyle(g: Geo, chipH: number) {
  const k = clamp01(g.reveal);
  return {
    top: "50%",
    left: `${LABEL_INSET + (g.size.w / 2 - LABEL_INSET) * k}px`,
    transform: `translate(${-50 * k}%, -50%)`,
    // Locked to the box height: BASE at the chip, growing in proportion as the box opens and as the
    // rack zooms in, so the text never reads tiny against a big device.
    fontSize: `${BASE_LABEL_PX * (g.size.h / chipH)}px`,
    lineHeight: "1",
  };
}

/** translate to the cursor, then flex on the X/Y axes. NO rotation: the chip stays upright and reads
 *  as itself — rotating it into its direction of travel sent it spinning as you dragged.
 *  The trailing -50% centres the box on the cursor AFTER the scale, so the flex happens about its
 *  middle rather than its top-left corner. */
/** Lerp two #rrggbb colours. The carried chip's blue fades back to the palette button's own border
 *  as it lands, so the moment the layer unmounts and the real button reappears is invisible. */
function mixHex(a: string, b: string, k: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const m = (i: number) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k);
  return `rgb(${m(0)}, ${m(1)}, ${m(2)})`;
}

/** The blue box itself: its own element on top, so it OVERLAPS the device's outline rather than
 *  pushing it inwards. Its blue fades to the palette button's own border as it lands home, which is
 *  what makes the hand-off to the real chip invisible. */
function outlineStyle(g: Geo, invalid: boolean) {
  return {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: invalid ? RK_INVALID : mixHex(RK_SELECT, CHIP_BORDER, g.homing),
    borderRadius: `${g.radius}px`,
  };
}

function boxStyle(g: Geo) {
  return {
    width: `${g.size.w}px`,
    height: `${g.size.h}px`,
    borderRadius: `${g.radius}px`,
    opacity: String(g.opacity),
    transform: `translate(${g.at.x}px, ${g.at.y}px) scale(${g.flex.sx}, ${g.flex.sy})`
      + ` translate(-50%, -50%)`,
    transformOrigin: "0 0",
  };
}

function paint(g: Geo, chipH: number, invalid: boolean, el: { box: HTMLDivElement | null; label: HTMLSpanElement | null;
  outline: HTMLDivElement | null; earL: HTMLDivElement | null; earR: HTMLDivElement | null; wash: HTMLDivElement | null }) {
  if (el.box) Object.assign(el.box.style, boxStyle(g));
  if (el.label) Object.assign(el.label.style, labelStyle(g, chipH));
  if (el.earL) Object.assign(el.earL.style, earStyle(g, "left", invalid));
  if (el.earR) Object.assign(el.earR.style, earStyle(g, "right", invalid));
  if (el.outline) Object.assign(el.outline.style, outlineStyle(g, invalid));
  if (el.wash) Object.assign(el.wash.style, washStyle(invalid));
}
