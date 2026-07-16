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
import { renderFace } from "@/features/device-library/faceplate/Faceplate";
import { emptyFace } from "@/domain/faceplate";
import { RACK_INTERIOR_W, RK_SELECT } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { pullGeometry, stepFlex, flexTarget, VEL_DECAY, LABEL_INSET, CHIP_BORDER, type PullState } from "./palettePull";

export type { PullPhase, PullState } from "./palettePull";

type Geo = ReturnType<typeof pullGeometry>;

export function PalettePullLayer({ pullRef, scaleOf }: {
  pullRef: MutableRefObject<PullState | null>;
  scaleOf: () => number;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const faceRef = useRef<HTMLDivElement | null>(null);
  const outlineRef = useRef<HTMLDivElement | null>(null);

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
      paint(pullGeometry(p, scaleOf(), now),
        { box: boxRef.current, label: labelRef.current, face: faceRef.current, outline: outlineRef.current });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pullRef, scaleOf]);

  if (!pullRef.current) return <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]" />;

  // First paint comes from the ref directly, via the SAME pullGeometry the rAF loop calls above —
  // so the two paths cannot disagree.
  const p = pullRef.current;
  const g = pullGeometry(p, scaleOf(), performance.now());

  return (
    <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]">
      <div ref={boxRef} data-testid="pull-box" className="absolute left-0 top-0 overflow-hidden bg-white"
        style={boxStyle(g)}>
        {/* The device it becomes: the SAME renderer the rack uses, with an empty face, and the ears
            already in the selection blue — it arrives at the rack selected, exactly as it will look
            once dropped. Drawn BEFORE the label so the name stays legible on top of it.
            17.5 (never 19) — a rack-mounted frame is RACK_INTERIOR_W wide regardless, and 19 is an
            invalid body width that only works via the MAX_BODY_WIDTH_IN clamp. */}
        <div ref={faceRef} data-testid="pull-face" className="absolute inset-0" style={{ opacity: faceOpacity(g) }}>
          <svg width="100%" height="100%" viewBox={`0 0 ${RACK_INTERIOR_W} ${RU_PX}`} preserveAspectRatio="none">
            {renderFace(emptyFace(), { widthIn: 17.5, rackUnits: 1, rackMounted: true, earColor: RK_SELECT })}
          </svg>
        </div>
        {/* The device's name. It rides the whole way: left-aligned on the chip you picked up, then
            travelling to the centre of the device as it opens. It never fades — the name is the one
            thing that identifies what you are placing. */}
        <span ref={labelRef} data-testid="pull-label"
          className="absolute whitespace-nowrap text-sm font-medium text-neutral-900"
          style={labelStyle(g)}>{p.label}</span>
        {/* The selection outline, drawn LAST and ON TOP — the same way the rack draws the box around
            a selected device. It has to overlap the device's own outline, not sit outside it: as the
            box's CSS `border` it pushed the face 2px inwards, so the device's grey outline showed as
            a second ring just inside the blue. On top, the blue simply covers it. */}
        <div ref={outlineRef} data-testid="pull-outline" className="pointer-events-none absolute inset-0"
          style={outlineStyle(g)} />
      </div>
    </div>
  );
}

/** `reveal` is monotonic 0..1 by construction, so the label and the fades cannot wobble. It is still
 *  clamp — a raw value would drive opacity past 1 and, worse, negative on any undershoot, and would
 *  fling the label past the device's centre and back. */
const clamp01 = (n: number) => (n > 1 ? 1 : n > 0 ? n : 0);
const faceOpacity = (g: Geo) => clamp01(g.reveal);

/** The name travels from the chip's left inset to the device's centre as it opens. Anchor and offset
 *  move together — `left` LABEL_INSET -> w/2 while translateX 0% -> -50% — so the text lands truly
 *  centred without anyone having to measure how wide it is. */
function labelStyle(g: Geo) {
  const k = clamp01(g.reveal);
  return {
    top: "50%",
    left: `${LABEL_INSET + (g.size.w / 2 - LABEL_INSET) * k}px`,
    transform: `translate(${-50 * k}%, -50%)`,
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
function outlineStyle(g: Geo) {
  return {
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: mixHex(RK_SELECT, CHIP_BORDER, g.homing),
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

function paint(g: Geo, el: { box: HTMLDivElement | null; label: HTMLSpanElement | null;
  face: HTMLDivElement | null; outline: HTMLDivElement | null }) {
  if (el.box) Object.assign(el.box.style, boxStyle(g));
  if (el.label) Object.assign(el.label.style, labelStyle(g));
  if (el.face) el.face.style.opacity = String(faceOpacity(g));
  if (el.outline) Object.assign(el.outline.style, outlineStyle(g));
}
