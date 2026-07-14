import type { Face } from "@/domain/faceplate";
import {
  frameDims,
  screwHoles,
  layoutPortGroup,
  CELL_W,
  ROW_H,
  GLYPH_W,
  LABEL_H,
  type LaidOutPort,
} from "@/domain/faceplate-geometry";
import { PORT_GLYPHS } from "./portGlyphs";
import { FaceIcon } from "./FaceIcon";
import { FaceText } from "./FaceText";
import { FaceShape } from "./FaceShape";
import { FaceLine } from "./FaceLine";

export interface FaceplateOptions {
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
}

// The FRONT/BACK label sits inside the frame (on the right ear, or just inside the body's
// right edge when there are no ears) — no external gutter. LABEL_INSET_PX is how far the
// label's center sits from the right edge when there are no ears.
const LABEL_INSET_PX = 18;
const CORNER_R = 6; // frame corner radius

// Ear paths round only their OUTER corners (to sit flush inside the frame's
// rounded corners); the inner edge against the body stays square so there is
// no notch or corner poking past the frame at the ear/body seam.
function leftEarPath(w: number, h: number): string {
  const r = CORNER_R;
  return `M ${r},0 L ${w},0 L ${w},${h} L ${r},${h} A ${r},${r} 0 0 1 0,${h - r} L 0,${r} A ${r},${r} 0 0 1 ${r},0 Z`;
}
function rightEarPath(x0: number, w: number, h: number): string {
  const r = CORNER_R;
  const x1 = x0 + w;
  return `M ${x0},0 L ${x1 - r},0 A ${r},${r} 0 0 1 ${x1},${r} L ${x1},${h - r} A ${r},${r} 0 0 1 ${x1 - r},${h} L ${x0},${h} Z`;
}

export interface HighlightPort {
  groupId: string;
  portIndex: number;
  color?: string; // glyph + label colour when highlighted; defaults to blue (#2d5bff)
}

// Live drag hint: shift one group's glyphs + labels horizontally by offsetX so they
// track the selection box while it's being moved (editor only; 0/undefined otherwise).
export interface MovePreview {
  groupId: string;
  offsetX: number;
  offsetY?: number;
}

function PortCell({ cell, color }: { cell: LaidOutPort; color?: string }) {
  const spec = PORT_GLYPHS[cell.media];
  const gx = cell.x + CELL_W / 2; // glyph horizontal center
  const gy = cell.y + ROW_H / 2; // glyph vertical center
  const glyphColor = color ?? "#111418";
  const labelFill = color ?? "#4b5563";
  const labelY = cell.labelPos === "top" ? cell.y - 3 : cell.y + ROW_H + LABEL_H - 3;
  return (
    <g data-testid="port-cell" data-highlighted={color ? "true" : "false"}>
      <text
        x={cell.x + CELL_W / 2}
        y={labelY}
        textAnchor="middle"
        fontSize={8}
        fontFamily="Inter, system-ui, sans-serif"
        style={{ fontVariantNumeric: "tabular-nums" }}
        fill={labelFill}
      >
        {cell.label}
      </text>
      <g
        transform={`${cell.rotation ? `rotate(${cell.rotation}, ${gx}, ${gy}) ` : ""}translate(${gx - GLYPH_W / 2}, ${gy - spec.height / 2})${
          cell.flipped ? ` translate(0, ${spec.height}) scale(1, -1)` : ""
        }`}
        color={glyphColor}
      >
        <svg width={GLYPH_W} height={spec.height} viewBox={spec.viewBox} overflow="visible">
          {spec.body}
        </svg>
      </g>
    </g>
  );
}

export function renderFace(face: Face, opts: FaceplateOptions, highlight?: HighlightPort | HighlightPort[] | null, movePreview?: MovePreview | MovePreview[] | null) {
  const highlights = highlight ? (Array.isArray(highlight) ? highlight : [highlight]) : [];
  const previews = movePreview ? (Array.isArray(movePreview) ? movePreview : [movePreview]) : [];
  const dims = frameDims(opts);
  const holes = screwHoles(dims, opts.rackUnits);
  const groups = face.portGroups.map((g) => layoutPortGroup(g, dims.heightPx));
  const svgWidth = dims.frameWidthPx;
  const svgHeight = dims.heightPx;

  return (
    <>
      {/* frame body (white). Fills carry no stroke — a single outer outline is drawn last
          so its weight stays even and the ear corners render crisply (a per-shape stroke on
          the outer edges gets clipped to ~half by the viewBox boundary). */}
      <rect x={0} y={0} width={svgWidth} height={svgHeight} rx={CORNER_R} fill="#ffffff" />
      {/* ears — fills only; outer corners rounded to match the frame */}
      {dims.earWidthPx > 0 && (
        <>
          <path d={leftEarPath(dims.earWidthPx, svgHeight)} fill="#d4d4d4" />
          <path d={rightEarPath(svgWidth - dims.earWidthPx, dims.earWidthPx, svgHeight)} fill="#d4d4d4" />
          {/* seam lines where the ears meet the body */}
          <line x1={dims.earWidthPx} y1={0} x2={dims.earWidthPx} y2={svgHeight} stroke="#d4d4d4" />
          <line x1={svgWidth - dims.earWidthPx} y1={0} x2={svgWidth - dims.earWidthPx} y2={svgHeight} stroke="#d4d4d4" />
        </>
      )}
      {/* screw holes */}
      {holes.map((h, i) => (
        <circle
          key={i}
          data-testid="screw-hole"
          cx={h.cx}
          cy={h.cy}
          r={4}
          fill="#a3a3a3"
          stroke="#a3a3a3"
        />
      ))}
      {/* single outer outline, inset half a stroke so the whole 1px shows (the viewBox
          would otherwise clip the outer edges) and reads at the same weight as the seams */}
      <rect x={0.5} y={0.5} width={svgWidth - 1} height={svgHeight - 1} rx={CORNER_R - 0.5} fill="none" stroke="#d4d4d4" />
      {/* body / grid (centered by the ear offset) */}
      <g data-testid="faceplate-body" transform={`translate(${dims.earWidthPx}, 0)`}>
        {groups.map((g) => {
          const mp = previews.find((p) => p.groupId === g.id);
          const dx = mp ? mp.offsetX : 0;
          const dy = mp ? (mp.offsetY ?? 0) : 0;
          const cells = g.cells.map((cell) => {
            const hl = highlights.find((h) => h.groupId === g.id && h.portIndex === cell.index);
            return (
              <PortCell
                key={`${g.id}-${cell.index}`}
                cell={cell}
                color={hl ? (hl.color ?? "#2d5bff") : undefined}
              />
            );
          });
          return (
            <g key={g.id} transform={dx || dy ? `translate(${dx}, ${dy})` : undefined}>{cells}</g>
          );
        })}
        {/* free-floating elements (icons, later text/shapes) positioned in body coords */}
        {face.elements.map((el) =>
          el.kind === "icon" ? <FaceIcon key={el.id} el={el} />
          : el.kind === "text" ? <FaceText key={el.id} el={el} />
          : el.kind === "shape" ? <FaceShape key={el.id} el={el} />
          : el.kind === "line" ? <FaceLine key={el.id} el={el} />
          : null,
        )}
      </g>
    </>
  );
}

export function Faceplate({
  face,
  side,
  highlight,
  movePreview,
  ...opts
}: { face: Face; side?: "FRONT" | "BACK"; highlight?: HighlightPort | HighlightPort[] | null; movePreview?: MovePreview | MovePreview[] | null } & FaceplateOptions) {
  const dims = frameDims(opts);
  const width = dims.frameWidthPx; // label lives inside the frame now — no extra gutter
  const height = dims.heightPx;
  // Label x: centered on the right ear when rack-mounted, else just inside the body's right
  // edge. y is the vertical center — i.e. halfway between the top & bottom screw holes.
  const labelX = dims.earWidthPx > 0 ? dims.frameWidthPx - dims.earWidthPx / 2 : dims.frameWidthPx - LABEL_INSET_PX;
  return (
    <svg
      data-testid="faceplate-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {renderFace(face, opts, highlight, movePreview)}
      {side && (
        <text
          x={labelX}
          y={height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          transform={`rotate(90, ${labelX}, ${height / 2})`}
          fontSize={11}
          fontWeight={600}
          fontFamily="Inter, system-ui, sans-serif"
          fill="#9aa1ab"
        >
          {side}
        </text>
      )}
    </svg>
  );
}
