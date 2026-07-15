"use client";

// src/features/racks/PalettePullLayer.tsx
// The palette -> rack drag visual: a lump of white slime pulled out of a chip, carried as a
// featureless BLOB, and solidified into a blank rack device only once it nears the rack. Fixed,
// pointer-events:none, above the palette and canvas.
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
import { pullGeometry, type PullState } from "./palettePull";

export type { PullPhase, PullState } from "./palettePull";

type Geo = ReturnType<typeof pullGeometry>;

export function PalettePullLayer({ pullRef, scaleOf }: {
  pullRef: MutableRefObject<PullState | null>;
  scaleOf: () => number;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const neckRef = useRef<SVGPathElement | null>(null);
  const blobRef = useRef<HTMLDivElement | null>(null);
  const faceRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = pullRef.current;
      if (!p || !boxRef.current) return;
      paint(boxRef.current, neckRef.current, blobRef.current, faceRef.current,
        pullGeometry(p, scaleOf(), performance.now()));
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pullRef, scaleOf]);

  if (!pullRef.current) return <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]" />;

  // First paint comes from the ref directly, via the SAME pullGeometry the rAF loop calls above —
  // so the two paths cannot disagree.
  const g = pullGeometry(pullRef.current, scaleOf(), performance.now());

  return (
    <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <path ref={neckRef} data-testid="pull-neck" d={g.neck} fill="#ffffff" fillOpacity={0.9} stroke="#d4d4d4" />
      </svg>
      <div ref={boxRef} data-testid="pull-box" className="absolute"
        style={{ left: 0, top: 0, width: g.size.w, height: g.size.h, opacity: g.opacity,
          transform: `translate(${g.at.x - g.size.w / 2}px, ${g.at.y - g.size.h / 2}px)` }}>
        {/* Both shapes are always mounted and the loop toggles which one shows: it writes styles and
            cannot add or remove React elements. Exactly one is visible at any time. */}
        {/* The blob: a featureless lump of slime. No frame, no ears — it must not look like the
            device it is going to become. */}
        <div ref={blobRef} data-testid="pull-blob" className="h-full w-full"
          style={{ display: g.solid ? "none" : "block", background: "#ffffff",
            border: "1px solid #d4d4d4", borderRadius: "50%" }} />
        {/* The device: the SAME renderer the rack uses, with an empty face — frame + ears, no ports.
            17.5 (never 19) — a rack-mounted frame is RACK_INTERIOR_W wide regardless, and 19 is an
            invalid body width that only works via the MAX_BODY_WIDTH_IN clamp. */}
        <svg ref={faceRef} data-testid="pull-face" width="100%" height="100%"
          viewBox={`0 0 ${RACK_INTERIOR_W} ${RU_PX}`} preserveAspectRatio="none"
          style={{ display: g.solid ? "block" : "none" }}>
          {renderFace(emptyFace(), { widthIn: 17.5, rackUnits: 1, rackMounted: true })}
        </svg>
      </div>
    </div>
  );
}

function paint(box: HTMLDivElement, neck: SVGPathElement | null, blob: HTMLDivElement | null,
  face: SVGSVGElement | null, g: Geo) {
  box.style.width = `${g.size.w}px`;
  box.style.height = `${g.size.h}px`;
  box.style.opacity = String(g.opacity);
  box.style.transform = `translate(${g.at.x - g.size.w / 2}px, ${g.at.y - g.size.h / 2}px)`;
  if (neck) neck.setAttribute("d", g.neck);
  if (blob) blob.style.display = g.solid ? "none" : "block";
  if (face) face.style.display = g.solid ? "block" : "none";
}
