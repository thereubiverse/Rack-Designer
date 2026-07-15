"use client";

// src/features/racks/PalettePullLayer.tsx
// The palette -> rack drag visual: a lump of white slime RIPPED off a device chip like a cell
// splitting, carried as a featureless blob, and solidified into a blank rack device only once it
// nears the rack. Fixed, pointer-events:none, above the palette and canvas.
//
// The chip's OWN OUTLINE is what tears. Chip + neck + blob sit in one group behind a small blur +
// alpha-contrast filter, so the filter's only job is to fillet the neck's joins into the chip and
// the blob; the neck itself spans the distance. The chip's rectangle NEVER moves — only its exit
// point does, because that is where the neck happens to be rooted this frame.
// Two things this is deliberately NOT:
//  - not a metaball alone: a metaball fuses only within ~2x its blur, so the blob would tear free
//    the moment it cleared the chip's edge, with no thread. And a blur wide enough to bridge the
//    gap rounds the whole chip into a pill.
//  - not a centre-rooted neck: that always has length, so it drew a spike across the chip's face
//    even while the blob was still inside it (the "arrow"). Rooting at chipExit() gives zero length
//    while the cursor is inside the chip, so nothing appears until it actually leaves.
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
import { pullGeometry, stepJiggle, jiggleTarget, VEL_DECAY, type PullState } from "./palettePull";

export type { PullPhase, PullState } from "./palettePull";

type Geo = ReturnType<typeof pullGeometry>;

/** Fillet strength. The filter's ONLY job is to melt the neck's joins into the chip and the blob —
 *  the neck itself spans the distance (see neckPath). Keep it SMALL: the blur rounds every corner it
 *  touches, so a large value liquefies the whole chip into a pill instead of leaving it a crisp
 *  rectangle with one molten exit point. At 14 the entire chip visibly deformed; ~4 rounds the
 *  corners by a couple of px against their existing 8px radius, which reads as unchanged.
 *  Tuning knob: more blur = gooier joins, but a softer chip. */
const GOO_BLUR = 4;
const GOO_CONTRAST = 24;
/** The hairline: how far the border pass is fattened past the fill pass. MUST match the real chip
 *  button's own border (`border border-neutral-200` = 1px #e5e5e5) — the goo redraws the chip over
 *  the live button, so any difference shows as a doubled or mismatched edge, and the blob's outline
 *  has to read as the same line the chip is drawn with. */
const OUTLINE_PX = 1;
const BORDER = "#e5e5e5";

export function PalettePullLayer({ pullRef, scaleOf }: {
  pullRef: MutableRefObject<PullState | null>;
  scaleOf: () => number;
}) {
  const gooRef = useRef<SVGGElement | null>(null);
  const labelRef = useRef<SVGTextElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // [border pass, fill pass] for each of the two shapes — the loop writes all four.
  const chipRef = useRef<(SVGRectElement | null)[]>([null, null]);
  const neckRef = useRef<(SVGPathElement | null)[]>([null, null]);
  const blobRef = useRef<(SVGRectElement | null)[]>([null, null]);

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
      // The tracked velocity decays continuously, so holding still relaxes the square back to rest.
      const decay = Math.pow(VEL_DECAY, Math.min(dt, 1 / 30));
      p.vx *= decay; p.vy *= decay;
      const speed = Math.hypot(p.vx, p.vy);
      p.jiggle = stepJiggle(p.jiggle, jiggleTarget(speed), Math.atan2(p.vy, p.vx), dt);
      paint(p, pullGeometry(p, scaleOf(), now),
        { goo: gooRef.current, label: labelRef.current, box: boxRef.current, neck: neckRef.current, blob: blobRef.current });
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
              {/* The molten thread out of the chip's edge. Stroked, not just filled, so the border
                  pass fattens it exactly like the other two shapes. */}
              <path ref={(el) => { neckRef.current[i] = el; }} data-testid={`pull-neck-${i}`}
                d={g.neck} stroke={pass.fill} strokeWidth={pass.grow * 2} strokeLinejoin="round" />
              {/* A rounded SQUARE, drawn about its own centre so the transform below can rotate it
                  into the direction of travel and squash-and-stretch it about that axis. */}
              <rect ref={(el) => { blobRef.current[i] = el; }} data-testid={`pull-blob-${i}`}
                x={-(g.size.w / 2 + pass.grow)} y={-(g.size.h / 2 + pass.grow)}
                width={g.size.w + pass.grow * 2} height={g.size.h + pass.grow * 2}
                rx={g.size.h * 0.28 + pass.grow} ry={g.size.h * 0.28 + pass.grow}
                transform={blobTransform(g)} />
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

/** translate to the cursor, rotate into the direction of travel, then squash-and-stretch about that
 *  axis. One transform, so the rect can stay a plain centred square. */
function blobTransform(g: Geo): string {
  const deg = (g.jiggle.angle * 180) / Math.PI;
  return `translate(${g.at.x} ${g.at.y}) rotate(${deg}) scale(${g.jiggle.along} ${g.jiggle.across})`;
}

function paint(p: PullState, g: Geo, el: {
  goo: SVGGElement | null; label: SVGTextElement | null; box: HTMLDivElement | null;
  neck: (SVGPathElement | null)[]; blob: (SVGRectElement | null)[];
}) {
  if (el.goo) { el.goo.style.display = g.solid ? "none" : "block"; el.goo.setAttribute("opacity", String(g.opacity)); }
  if (el.label) el.label.style.display = g.solid ? "none" : "block";
  for (const i of [0, 1]) {
    const grow = i === 0 ? OUTLINE_PX : 0;
    el.neck[i]?.setAttribute("d", g.neck);
    const blob = el.blob[i];
    if (blob) {
      const w = Math.max(0, g.size.w + grow * 2), h = Math.max(0, g.size.h + grow * 2);
      blob.setAttribute("x", String(-w / 2));
      blob.setAttribute("y", String(-h / 2));
      blob.setAttribute("width", String(w));
      blob.setAttribute("height", String(h));
      blob.setAttribute("rx", String(g.size.h * 0.28 + grow));
      blob.setAttribute("ry", String(g.size.h * 0.28 + grow));
      blob.setAttribute("transform", blobTransform(g));
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
