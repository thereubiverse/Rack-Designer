import type { Face } from "@/domain/faceplate";
import {
  frameDims,
  screwHoles,
  layoutPortGroup,
  CELL_W,
  ROW_H,
  GLYPH_W,
  type LaidOutPort,
} from "@/domain/faceplate-geometry";
import { PORT_GLYPHS } from "./portGlyphs";

export interface FaceplateOptions {
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
}

const LABEL_GUTTER = 22; // room for the vertical FRONT/BACK label on the right

function PortCell({ cell }: { cell: LaidOutPort }) {
  const spec = PORT_GLYPHS[cell.media];
  const gx = cell.x + CELL_W / 2; // glyph horizontal center
  const gy = cell.y + ROW_H / 2; // glyph vertical center
  return (
    <g data-testid="port-cell">
      <text
        x={cell.x + CELL_W / 2}
        y={cell.y - 3}
        textAnchor="middle"
        fontSize={8}
        fontFamily="Inter, system-ui, sans-serif"
        style={{ fontVariantNumeric: "tabular-nums" }}
        fill="#4b5563"
      >
        {cell.label}
      </text>
      <g
        transform={`translate(${gx - GLYPH_W / 2}, ${gy - spec.height / 2})${
          cell.flipped ? ` translate(0, ${spec.height}) scale(1, -1)` : ""
        }`}
        color="#111418"
      >
        <svg width={GLYPH_W} height={spec.height} viewBox={spec.viewBox} overflow="visible">
          {spec.body}
        </svg>
      </g>
    </g>
  );
}

export function renderFace(face: Face, opts: FaceplateOptions) {
  const dims = frameDims(opts);
  const holes = screwHoles(dims, opts.rackUnits);
  const groups = face.portGroups.map(layoutPortGroup);
  const svgWidth = dims.frameWidthPx;
  const svgHeight = dims.heightPx;

  return (
    <>
      {/* frame */}
      <rect
        x={0}
        y={0}
        width={svgWidth}
        height={svgHeight}
        rx={6}
        fill="#f7f8fa"
        stroke="#cfd3da"
      />
      {/* ears */}
      {dims.earWidthPx > 0 && (
        <>
          <rect x={0} y={0} width={dims.earWidthPx} height={svgHeight} rx={6} fill="#e6e9ee" stroke="#cfd3da" />
          <rect
            x={svgWidth - dims.earWidthPx}
            y={0}
            width={dims.earWidthPx}
            height={svgHeight}
            rx={6}
            fill="#e6e9ee"
            stroke="#cfd3da"
          />
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
          fill="#c3c8d0"
          stroke="#9aa1ab"
        />
      ))}
      {/* body / grid (centered by the ear offset) */}
      <g data-testid="faceplate-body" transform={`translate(${dims.earWidthPx}, 0)`}>
        {groups.flatMap((g) => g.cells.map((cell) => <PortCell key={`${g.id}-${cell.index}`} cell={cell} />))}
      </g>
    </>
  );
}

export function Faceplate({
  face,
  side,
  ...opts
}: { face: Face; side?: "FRONT" | "BACK" } & FaceplateOptions) {
  const dims = frameDims(opts);
  const width = dims.frameWidthPx + (side ? LABEL_GUTTER : 0);
  const height = dims.heightPx;
  return (
    <svg
      data-testid="faceplate-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {renderFace(face, opts)}
      {side && (
        <text
          x={dims.frameWidthPx + LABEL_GUTTER / 2}
          y={height / 2}
          textAnchor="middle"
          transform={`rotate(90, ${dims.frameWidthPx + LABEL_GUTTER / 2}, ${height / 2})`}
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
