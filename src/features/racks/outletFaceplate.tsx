"use client";
// Realistic single-gang keystone wall plate — the visualisation for a data-outlet (TO) endpoint.
// Rack devices are drawn by renderFace; a wall outlet is a different physical object (portrait,
// two screws, keystone cut-outs), so it gets its own small renderer rather than being forced
// through the rack faceplate geometry.
//
// Geometry follows a standard US plate at UNITS_PER_IN: body 2.75" x 4.5", keystone opening
// 0.58" x 0.76", screws on the vertical centreline. Every count uses ONE uniform grid rule —
// columns and rows are evenly pitched about the plate centre — so the family looks consistent:
//   0 = blank   1 = 1x1   2 = 1x2   3 = 1x3   4 = 2x2   6 = 2x3
// Ports are numbered left-to-right, top-to-bottom.
//
// Each port draws the shared PORT_GLYPHS jack (the same one the rack faceplate uses) rather than a
// plain box, and the run's landing port is drawn blue with its endpoint label above it — matching
// the label-above-glyph convention of Faceplate's PortCell.

import { useId } from "react";
import { PORT_GLYPHS } from "@/features/device-library/faceplate/portGlyphs";
import { GLYPH_W } from "@/domain/faceplate-geometry";
import type { OutletPortCount } from "./endpointOps";

/** Telecommunications Outlet — the described type drawn as a wall plate. */
export const OUTLET_TYPE_CODE = "TO";

const UNITS_PER_IN = 40;
export const PLATE_W = 2.75 * UNITS_PER_IN; // 110
export const PLATE_H = 4.5 * UNITS_PER_IN; // 180
const PORT_W = 0.58 * UNITS_PER_IN; // 23.2 — keystone opening
const PORT_H = 0.76 * UNITS_PER_IN; // 30.4
const COL_PITCH = 36;
const ROW_PITCH = 40;
const SCREW_R = 2.6;
const SCREW_INSET = 24; // from top / bottom edge, on the centreline

/** Grid shape per port count (from the reference plate family). */
const GRID: Record<OutletPortCount, { cols: number; rows: number }> = {
  0: { cols: 0, rows: 0 },
  1: { cols: 1, rows: 1 },
  2: { cols: 1, rows: 2 },
  3: { cols: 1, rows: 3 },
  4: { cols: 2, rows: 2 },
  6: { cols: 2, rows: 3 },
};

/** n evenly-pitched centres about `mid`. */
const centres = (n: number, mid: number, pitch: number): number[] =>
  Array.from({ length: n }, (_, i) => mid + (i - (n - 1) / 2) * pitch);

export interface PortRect { x: number; y: number; w: number; h: number }

/** The plate's keystone openings, in port-number order (left-to-right, top-to-bottom). */
export function outletPortRects(portCount: OutletPortCount): PortRect[] {
  const { cols, rows } = GRID[portCount];
  const xs = centres(cols, PLATE_W / 2, COL_PITCH);
  const ys = centres(rows, PLATE_H / 2, ROW_PITCH);
  const out: PortRect[] = [];
  for (const cy of ys) for (const cx of xs) {
    out.push({ x: cx - PORT_W / 2, y: cy - PORT_H / 2, w: PORT_W, h: PORT_H });
  }
  return out;
}

const BLUE = "#1a55d8";
const INK = "#111418"; // an unused port's jack, matching Faceplate's PortCell default

// A data outlet is a copper RJ45 keystone. Draw the shared glyph at the real opening width, so a
// port on the plate reads as the same jack the rack faceplate draws.
const GLYPH = PORT_GLYPHS.copper;
const GLYPH_H = (PORT_W / GLYPH_W) * GLYPH.height;

// The plate is only PLATE_W wide, so a long label would run off it. Clip it for the drawing only —
// the full value always remains in the endpoint's label field.
const LABEL_MAX = 10;
const clipLabel = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

/** The plate. `landingPortIndex` (if the run terminates at one) is drawn blue, labelled above. */
export function OutletFaceplate({ portCount, landingPortIndex, landingPortLabel = "", height = 190 }: {
  portCount: OutletPortCount;
  landingPortIndex?: number;
  landingPortLabel?: string;
  height?: number;
}) {
  const rects = outletPortRects(portCount);
  const scale = height / PLATE_H;
  // useId keeps the defs unique when several plates render at once.
  const uid = useId().replace(/:/g, "");
  const faceG = `${uid}-face`, shadow = `${uid}-shadow`;
  const cx = PLATE_W / 2;
  return (
    <svg data-testid="endpoint-face" data-port-count={portCount}
      viewBox={`-3 -3 ${PLATE_W + 6} ${PLATE_H + 6}`} width={(PLATE_W + 6) * scale} height={(PLATE_H + 6) * scale}
      className="mx-auto block" role="img"
      aria-label={portCount === 0 ? "Blank wall plate" : `${portCount}-port wall plate`}>
      <defs>
        {/* the plate is slightly domed: brightest just below the top edge, greying toward the base */}
        <linearGradient id={faceG} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2f3f5" />
          <stop offset="0.06" stopColor="#ffffff" />
          <stop offset="0.75" stopColor="#fbfbfc" />
          <stop offset="1" stopColor="#e9ebee" />
        </linearGradient>
        <filter id={shadow} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="1.2" stdDeviation="1.6" floodColor="#6b7280" floodOpacity="0.45" />
        </filter>
      </defs>

      {/* plate body, lifted off the wall */}
      <g filter={`url(#${shadow})`}>
        <rect x={0} y={0} width={PLATE_W} height={PLATE_H} rx={7.5} fill={`url(#${faceG})`}
          stroke="#b9bec6" strokeWidth={0.9} />
      </g>
      {/* the moulded lip: a bright highlight inside the edge, with a soft shade under it */}
      <rect x={2.2} y={2.2} width={PLATE_W - 4.4} height={PLATE_H - 4.4} rx={5.6}
        fill="none" stroke="#ffffff" strokeWidth={1.4} opacity={0.9} />
      <rect x={3.6} y={3.6} width={PLATE_W - 7.2} height={PLATE_H - 7.2} rx={4.6}
        fill="none" stroke="#dfe2e7" strokeWidth={0.8} />

      {/* screws, countersunk on the vertical centreline */}
      {[SCREW_INSET, PLATE_H - SCREW_INSET].map((cy) => (
        <g key={cy}>
          <circle cx={cx} cy={cy} r={SCREW_R} fill="#9ba1a9" />
          <circle cx={cx} cy={cy - 0.3} r={SCREW_R - 0.7} fill="#c2c7ce" />
          <line x1={cx - 1.5} y1={cy} x2={cx + 1.5} y2={cy} stroke="#7c838c" strokeWidth={0.7} strokeLinecap="round" />
        </g>
      ))}

      {/* the jacks — the landing port is the one this run terminates at, drawn blue and labelled */}
      {rects.map((r, i) => {
        const landing = i === landingPortIndex;
        const px = r.x + r.w / 2, py = r.y + r.h / 2; // port centre
        return (
          <g key={i} data-testid={`outlet-port-${i}`} data-landing={landing ? "true" : "false"}>
            {landing && landingPortLabel !== "" && (
              <text data-testid={`outlet-port-label-${i}`} x={px} y={py - GLYPH_H / 2 - 2.5}
                textAnchor="middle" fontSize={8} fontWeight={600}
                fontFamily="Inter, system-ui, sans-serif" fill={BLUE}>{clipLabel(landingPortLabel)}</text>
            )}
            <g transform={`translate(${px - PORT_W / 2}, ${py - GLYPH_H / 2})`} color={landing ? BLUE : INK}>
              <svg width={PORT_W} height={GLYPH_H} viewBox={GLYPH.viewBox} overflow="visible">{GLYPH.body}</svg>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
