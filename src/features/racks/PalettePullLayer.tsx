"use client";

// src/features/racks/PalettePullLayer.tsx
// The palette -> rack drag visual: a blank device pulled out of a chip like gooey slime, growing to
// the size of one RU and snapping solid. Fixed, pointer-events:none, above the palette and canvas.
//
// Reads its state from a REF, not props, and writes the DOM inside its own rAF loop — the box has to
// track the pointer 1:1, and a React render per frame would add latency. Same idiom as the grip drag
// in RackCanvas. React state here changes only when the layer mounts/unmounts.
// It owns NO state transitions: RackBuilder decides when the pull latches solid and when the
// snap-back ends. This layer only draws whatever pullRef.current currently says. Latching in here
// would make the drop depend on a frame having fired — untestable, and the wrong home for the
// machine anyway.
import { useEffect, useRef, type MutableRefObject } from "react";
import { renderFace } from "@/features/device-library/faceplate/Faceplate";
import { emptyFace } from "@/domain/faceplate";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { SNAP_MS, boxSize, easeOutElastic, neckPath, pullProgress, type Size, type Vec } from "./palettePull";

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
const BOX_OPACITY = 0.75;

export function PalettePullLayer({ pullRef, scaleOf }: {
  pullRef: MutableRefObject<PullState | null>;
  scaleOf: () => number;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const neckRef = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = pullRef.current;
      const box = boxRef.current, neck = neckRef.current;
      if (!p || !box) return;
      const scale = scaleOf();

      if (p.phase === "snapback") {
        // Shrink back into the chip. RackBuilder unmounts us on its own SNAP_MS timer.
        const k = Math.min(1, (performance.now() - p.snapStart) / SNAP_MS);
        const from = p.snapFrom ?? p.chip;
        const cx = from.x + (p.chip.x - from.x) * k;
        const cy = from.y + (p.chip.y - from.y) * k;
        paint(box, neck, { x: cx, y: cy }, boxSize(1 - k, scale, p.chipSize), "", (1 - k) * BOX_OPACITY);
        return;
      }

      // `solid` is latched by RackBuilder, so t is 1 forever after — dragging back toward the chip
      // never re-attaches it.
      const t = p.phase === "solid" ? 1 : pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y));
      let s = boxSize(t, scale, p.chipSize);
      if (p.phase === "solid") {
        // Spring on the moment it went solid: overshoot, then ring down to exactly one RU.
        const k = Math.min(1, (performance.now() - p.snapStart) / SNAP_MS);
        const e = k >= 1 ? 1 : easeOutElastic(k);
        s = { w: RACK_INTERIOR_W * scale * e, h: RU_PX * scale * e };
      }
      paint(box, neck, { x: p.x, y: p.y }, s, neckPath(p.chip, { x: p.x, y: p.y }, t, p.chipSize.h), BOX_OPACITY);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pullRef, scaleOf]);

  if (!pullRef.current) return <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]" />;

  // First paint comes from the ref directly, so the very first frame is already correct.
  const p = pullRef.current;
  const scale = scaleOf();
  const t = p.phase === "solid" ? 1 : pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y));
  const s = boxSize(t, scale, p.chipSize);
  const d = neckPath(p.chip, { x: p.x, y: p.y }, t, p.chipSize.h);

  return (
    <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <path ref={neckRef} data-testid="pull-neck" d={d} fill="#ffffff" fillOpacity={0.9} stroke="#d4d4d4" />
      </svg>
      <div ref={boxRef} data-testid="pull-box" className="absolute"
        style={{ left: 0, top: 0, width: s.w, height: s.h, opacity: BOX_OPACITY,
          transform: `translate(${p.x - s.w / 2}px, ${p.y - s.h / 2}px)` }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${RACK_INTERIOR_W} ${RU_PX}`} preserveAspectRatio="none">
          {/* The SAME renderer the rack uses, with an empty face: frame + ears, no ports.
              17.5 (never 19) — a rack-mounted frame is RACK_INTERIOR_W wide regardless, and 19 is an
              invalid body width that only works via the MAX_BODY_WIDTH_IN clamp. */}
          {renderFace(emptyFace(), { widthIn: 17.5, rackUnits: 1, rackMounted: true })}
        </svg>
      </div>
    </div>
  );
}

function paint(box: HTMLDivElement, neck: SVGPathElement | null, at: Vec, s: Size, d: string, opacity: number) {
  box.style.width = `${s.w}px`;
  box.style.height = `${s.h}px`;
  box.style.opacity = String(opacity);
  box.style.transform = `translate(${at.x - s.w / 2}px, ${at.y - s.h / 2}px)`;
  if (neck) neck.setAttribute("d", d);
}
