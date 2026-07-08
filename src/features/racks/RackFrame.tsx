// src/features/racks/RackFrame.tsx
// PURE rack renderer: enclosure, 19" rails with per-RU holes, bottom-up RU numbers, free-slot
// markers, and each placement's faceplate via the existing pure renderFace. No interactivity —
// RackCanvas overlays that (same split as Faceplate/EditorCanvas).
import { renderFace } from "@/features/device-library/faceplate/Faceplate";
import { RU_PX, PX_PER_IN, RAIL_WIDTH_IN } from "@/domain/faceplate-geometry";
import type { Face } from "@/domain/faceplate";

export const RACK_INTERIOR_W = RAIL_WIDTH_IN * PX_PER_IN; // 912
export const RACK_GUTTER_L = 30; // RU numbers live left of the enclosure
export const RACK_PAD = 10;      // enclosure wall thickness

export interface RackPlacementRender {
  id: string;
  startU: number;
  template: { rackUnits: number; widthIn: number; rackMounted: boolean; frontFace: Face; backFace: Face };
}

export function rackSvgSize(heightU: number): { width: number; height: number } {
  return {
    width: RACK_GUTTER_L + RACK_PAD * 2 + RACK_INTERIOR_W,
    height: RACK_PAD * 2 + heightU * RU_PX,
  };
}

/** svg-y of the TOP edge of a span starting at startU (bottom-up numbering). */
export function ruTopY(startU: number, rackUnits: number, heightU: number): number {
  const topU = startU + rackUnits - 1;
  return RACK_PAD + (heightU - topU) * RU_PX;
}

const HOLE_R = 3.5;

export function RackFrame({ heightU, placements, side }: {
  heightU: number; placements: RackPlacementRender[]; side: "FRONT" | "BACK";
}) {
  const { width, height } = rackSvgSize(heightU);
  const x0 = RACK_GUTTER_L;                 // enclosure left
  const ix = x0 + RACK_PAD;                 // interior left (rail outer edge)
  const occupied = new Set<number>();
  for (const p of placements) {
    for (let u = p.startU; u < p.startU + p.template.rackUnits; u++) occupied.add(u);
  }
  const units = Array.from({ length: heightU }, (_, i) => i + 1);

  return (
    <g data-testid="rack-frame">
      {/* enclosure */}
      <rect x={x0} y={0} width={width - x0} height={height} rx={8} fill="#f5f5f5" stroke="#d4d4d4" />
      <rect x={ix} y={RACK_PAD} width={RACK_INTERIOR_W} height={heightU * RU_PX} fill="#ffffff" stroke="#e5e5e5" />
      {units.map((u) => {
        const y = ruTopY(u, 1, heightU);
        return (
          <g key={u}>
            {/* RU number + boundary line + rail holes */}
            <text x={RACK_GUTTER_L - 6} y={y + RU_PX / 2 + 3} textAnchor="end" fontSize={10} fill="#a3a3a3">{u}</text>
            <line x1={ix} x2={ix + RACK_INTERIOR_W} y1={y} y2={y} stroke="#f0f0f0" />
            <circle cx={ix + 9} cy={y + RU_PX / 2} r={HOLE_R} fill="none" stroke="#c4c4c4" />
            <circle cx={ix + RACK_INTERIOR_W - 9} cy={y + RU_PX / 2} r={HOLE_R} fill="none" stroke="#c4c4c4" />
            {!occupied.has(u) && (
              <circle data-testid="rack-slot" cx={ix + RACK_INTERIOR_W / 2} cy={y + RU_PX / 2} r={7}
                fill="none" stroke="#bfdbfe" strokeWidth={1.5} />
            )}
          </g>
        );
      })}
      {placements.map((p) => {
        const y = ruTopY(p.startU, p.template.rackUnits, heightU);
        const face = side === "FRONT" ? p.template.frontFace : p.template.backFace;
        const opts = { widthIn: p.template.widthIn, rackUnits: p.template.rackUnits, rackMounted: p.template.rackMounted };
        return (
          <g key={p.id} data-testid={`rack-device-${p.id}`} transform={`translate(${ix}, ${y})`}>
            {renderFace(face, opts)}
          </g>
        );
      })}
    </g>
  );
}
