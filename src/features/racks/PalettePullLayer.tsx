"use client";

// src/features/racks/PalettePullLayer.tsx
// Picking a device chip out of the palette and carrying it to the rack. Fixed, pointer-events:none,
// above the palette and canvas.
//
// ONE element does the whole gesture. You pick up the chip; it wears the selection blue from the
// moment you touch it and keeps a little soft-body lean as you fling it around; and as it reaches
// the rack it springs open into the rack device, already selected — same blue border, blue ears.
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
import { pullGeometry, stepJiggle, jiggleTarget, VEL_DECAY, type PullState } from "./palettePull";

export type { PullPhase, PullState } from "./palettePull";

type Geo = ReturnType<typeof pullGeometry>;

export function PalettePullLayer({ pullRef, scaleOf }: {
  pullRef: MutableRefObject<PullState | null>;
  scaleOf: () => number;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const faceRef = useRef<HTMLDivElement | null>(null);

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
      // Step the soft body once per frame. This lives here, not in RackBuilder, for the same reason
      // the patch cable's rope does: the spring must keep ringing after the cursor STOPS, and
      // pointermove stops firing the moment it does — only frames keep coming.
      // The tracked velocity decays continuously, so holding still relaxes the lean away.
      const decay = Math.pow(VEL_DECAY, Math.min(dt, 1 / 30));
      p.vx *= decay; p.vy *= decay;
      p.jiggle = stepJiggle(p.jiggle, jiggleTarget(Math.hypot(p.vx, p.vy)), Math.atan2(p.vy, p.vx), dt);
      paint(pullGeometry(p, scaleOf(), now), { box: boxRef.current, label: labelRef.current, face: faceRef.current });
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
        style={{ ...boxStyle(g), borderStyle: "solid", borderWidth: 2, borderColor: RK_SELECT }}>
        {/* The chip's own label, cross-faded out as the device's face arrives. */}
        <span ref={labelRef} data-testid="pull-label"
          className="absolute inset-0 flex items-center px-3 text-sm font-medium text-neutral-900"
          style={{ opacity: labelOpacity(g) }}>{p.label}</span>
        {/* The device it becomes: the SAME renderer the rack uses, with an empty face, and the ears
            already in the selection blue — it arrives at the rack selected, exactly as it will look
            once dropped. 17.5 (never 19) — a rack-mounted frame is RACK_INTERIOR_W wide regardless,
            and 19 is an invalid body width that only works via the MAX_BODY_WIDTH_IN clamp. */}
        <div ref={faceRef} data-testid="pull-face" className="absolute inset-0" style={{ opacity: faceOpacity(g) }}>
          <svg width="100%" height="100%" viewBox={`0 0 ${RACK_INTERIOR_W} ${RU_PX}`} preserveAspectRatio="none">
            {renderFace(emptyFace(), { widthIn: 17.5, rackUnits: 1, rackMounted: true, earColor: RK_SELECT })}
          </svg>
        </div>
      </div>
    </div>
  );
}

/** openness overshoots 1 mid-spring (that IS the elastic pop), so anything used as an opacity has to
 *  clamp — a raw value would drive opacity past 1 and, worse, negative on any undershoot. */
const clamp01 = (n: number) => (n > 1 ? 1 : n > 0 ? n : 0);
const faceOpacity = (g: Geo) => clamp01(g.openness);
const labelOpacity = (g: Geo) => 1 - clamp01(g.openness);

/** translate to the cursor, lean into the direction of travel, then squash-and-stretch about that
 *  axis. The trailing -50% centres the box on the cursor AFTER the rotate/scale, so both happen
 *  about its middle rather than its top-left corner. */
function boxStyle(g: Geo) {
  return {
    width: `${g.size.w}px`,
    height: `${g.size.h}px`,
    borderRadius: `${g.radius}px`,
    opacity: String(g.opacity),
    transform: `translate(${g.at.x}px, ${g.at.y}px) rotate(${(g.jiggle.angle * 180) / Math.PI}deg)`
      + ` scale(${g.jiggle.along}, ${g.jiggle.across}) translate(-50%, -50%)`,
    transformOrigin: "0 0",
  };
}

function paint(g: Geo, el: { box: HTMLDivElement | null; label: HTMLSpanElement | null; face: HTMLDivElement | null }) {
  if (el.box) Object.assign(el.box.style, boxStyle(g));
  if (el.label) el.label.style.opacity = String(labelOpacity(g));
  if (el.face) el.face.style.opacity = String(faceOpacity(g));
}
