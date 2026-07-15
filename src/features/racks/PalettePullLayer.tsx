"use client";

// src/features/racks/PalettePullLayer.tsx
// The palette -> rack drag visual: a lump of white slime RIPPED off a device chip like a cell
// splitting, carried as a featureless blob, and solidified into a blank rack device only once it
// nears the rack. Fixed, pointer-events:none, above the palette and canvas.
//
// The liquid is a METABALL, not hand-drawn geometry. The chip and the blob are two ordinary shapes
// in one group; a blur + alpha-contrast filter fuses anything close into a single mass, so the
// bulge, the stretching waist, the pinch and the snap all emerge from the filter as they separate.
// That is why there is no neck path here: the old one drew a tapered spike from the chip's CENTRE,
// which showed as a stray arrow while the blob still lagged inside the chip's own bounds — and it
// could never have produced a real pinch.
//
// The outline is the standard two-pass trick: draw the same shapes fused and fattened in the border
// colour, then again fused and white on top. What's left showing is a hairline that follows the
// fused silhouette — including across the waist, which is why the blob needs no outline logic of its
// own while it overlaps the chip.
//
// Reads its state from a REF, not props, and writes the DOM inside its own rAF loop — the box has to
// track the pointer 1:1, and a React render per frame would add latency. Same idiom as the grip drag
// in RackCanvas. It owns NO state transitions: RackBuilder decides when the pull latches solid and
// when the snap-back ends.
import { useEffect, useRef, type MutableRefObject } from "react";
import { renderFace } from "@/features/device-library/faceplate/Faceplate";
import { emptyFace } from "@/domain/faceplate";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { pullGeometry, type PullState } from "./palettePull";

export type { PullPhase, PullState } from "./palettePull";

type Geo = ReturnType<typeof pullGeometry>;

/** Fusion strength. stdDeviation sets how far apart two shapes still merge — i.e. how long the waist
 *  stretches before it snaps; the alpha contrast re-hardens the blurred edge back to a crisp one.
 *  Both are tuning knobs: more blur = gooier and stringier. */
const GOO_BLUR = 14;
const GOO_CONTRAST = 22;
/** How far the border pass is fattened past the fill pass — the visible hairline. */
const OUTLINE_PX = 1.25;
const BORDER = "#d4d4d4";

export function PalettePullLayer({ pullRef, scaleOf }: {
  pullRef: MutableRefObject<PullState | null>;
  scaleOf: () => number;
}) {
  const gooRef = useRef<SVGGElement | null>(null);
  const labelRef = useRef<SVGTextElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // [border pass, fill pass] for each of the two shapes — the loop writes all four.
  const chipRef = useRef<(SVGRectElement | null)[]>([null, null]);
  const blobRef = useRef<(SVGEllipseElement | null)[]>([null, null]);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = pullRef.current;
      if (!p) return;
      paint(p, pullGeometry(p, scaleOf(), performance.now()),
        { goo: gooRef.current, label: labelRef.current, box: boxRef.current, chip: chipRef.current, blob: blobRef.current });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pullRef, scaleOf]);

  if (!pullRef.current) return <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]" />;

  // First paint comes from the ref directly, via the SAME pullGeometry the rAF loop calls above —
  // so the two paths cannot disagree.
  const p = pullRef.current;
  const g = pullGeometry(p, scaleOf(), performance.now());
  // Pass 0 is the fattened border, pass 1 the white fill on top.
  const passes = [{ grow: OUTLINE_PX, fill: BORDER }, { grow: 0, fill: "#ffffff" }];

  return (
    <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <filter id="palette-goo">
            {/* Blur everything together, then slam the alpha back to a hard edge: shapes within
                ~GOO_BLUR of each other fuse, and the join between them is a smooth waist. */}
            <feGaussianBlur in="SourceGraphic" stdDeviation={GOO_BLUR} result="blur" />
            <feColorMatrix in="blur" mode="matrix"
              values={`1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${GOO_CONTRAST} -${GOO_CONTRAST / 2}`} />
          </filter>
        </defs>
        <g ref={gooRef} data-testid="pull-goo" style={{ display: g.solid ? "none" : "block" }} opacity={g.opacity}>
          {passes.map((pass, i) => (
            <g key={i} filter="url(#palette-goo)" fill={pass.fill}>
              {/* The chip, redrawn so its outline can deform — a CSS border cannot fuse with a blob.
                  The real button still sits underneath at the same size, so this is seamless. */}
              <rect ref={(el) => { chipRef.current[i] = el; }} data-testid={`pull-chip-${i}`}
                rx={8 + pass.grow} ry={8 + pass.grow}
                x={p.chip.x - p.chipSize.w / 2 - pass.grow} y={p.chip.y - p.chipSize.h / 2 - pass.grow}
                width={p.chipSize.w + pass.grow * 2} height={p.chipSize.h + pass.grow * 2} />
              <ellipse ref={(el) => { blobRef.current[i] = el; }} data-testid={`pull-blob-${i}`}
                cx={g.at.x} cy={g.at.y} rx={g.size.w / 2 + pass.grow} ry={g.size.h / 2 + pass.grow} />
            </g>
          ))}
        </g>
        {/* The chip's label, redrawn over the goo — the mass covers the real button's text. */}
        <text ref={labelRef} data-testid="pull-label" x={p.chip.x - p.chipSize.w / 2 + 12} y={p.chip.y}
          dominantBaseline="central" fontSize={14} fontWeight={500} fontFamily="Inter, system-ui, sans-serif"
          fill="#171717" style={{ display: g.solid ? "none" : "block" }}>{p.label}</text>
      </svg>
      {/* The device, once solid. Crisp — the goo has done its job by then. */}
      <div ref={boxRef} data-testid="pull-box" className="absolute"
        style={{ left: 0, top: 0, width: g.size.w, height: g.size.h, opacity: g.opacity,
          display: g.solid ? "block" : "none",
          transform: `translate(${g.at.x - g.size.w / 2}px, ${g.at.y - g.size.h / 2}px)` }}>
        {/* The SAME renderer the rack uses, with an empty face: frame + ears, no ports.
            17.5 (never 19) — a rack-mounted frame is RACK_INTERIOR_W wide regardless, and 19 is an
            invalid body width that only works via the MAX_BODY_WIDTH_IN clamp. */}
        <svg width="100%" height="100%" viewBox={`0 0 ${RACK_INTERIOR_W} ${RU_PX}`} preserveAspectRatio="none">
          {renderFace(emptyFace(), { widthIn: 17.5, rackUnits: 1, rackMounted: true })}
        </svg>
      </div>
    </div>
  );
}

function paint(p: PullState, g: Geo, el: {
  goo: SVGGElement | null; label: SVGTextElement | null; box: HTMLDivElement | null;
  chip: (SVGRectElement | null)[]; blob: (SVGEllipseElement | null)[];
}) {
  if (el.goo) { el.goo.style.display = g.solid ? "none" : "block"; el.goo.setAttribute("opacity", String(g.opacity)); }
  if (el.label) el.label.style.display = g.solid ? "none" : "block";
  for (const i of [0, 1]) {
    const grow = i === 0 ? OUTLINE_PX : 0;
    const blob = el.blob[i];
    if (blob) {
      blob.setAttribute("cx", String(g.at.x));
      blob.setAttribute("cy", String(g.at.y));
      blob.setAttribute("rx", String(Math.max(0, g.size.w / 2 + grow)));
      blob.setAttribute("ry", String(Math.max(0, g.size.h / 2 + grow)));
    }
  }
  const box = el.box;
  if (box) {
    box.style.display = g.solid ? "block" : "none";
    box.style.width = `${g.size.w}px`;
    box.style.height = `${g.size.h}px`;
    box.style.opacity = String(g.opacity);
    box.style.transform = `translate(${g.at.x - g.size.w / 2}px, ${g.at.y - g.size.h / 2}px)`;
  }
}
