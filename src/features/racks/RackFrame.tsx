// src/features/racks/RackFrame.tsx
// PURE rack renderer — reproduces the reference rack-planner geometry EXACTLY. The reference uses
// RU = 50, a 540-wide mount (device body 500 + two 20px ears) and its frame/cap/pedestal laid out
// in that coordinate space; we keep our RU_PX (84) / 19" mount (912) so faceplates still fit, and
// scale the reference's horizontal proportions by hx() (ref half-mount 270 → our MOUNT_HW 456) and
// its vertical offsets by Ky (ref RU 50 → RU_PX). Line-art body (thin dark outline, gap to the
// mounting ears), gray ears with 3 white holes/RU, dashed RU separators, big ⊕ markers, a bracket
// cap on top and a ventilation-slat plinth + feet on the bottom.
// No interactivity — RackCanvas overlays that (same split as Faceplate/EditorCanvas).
import { memo } from "react";
import { renderFace, CORNER_R, type HighlightPort } from "@/features/device-library/faceplate/Faceplate";
import { RU_PX, PX_PER_IN, RAIL_WIDTH_IN } from "@/domain/faceplate-geometry";
import { type Face } from "@/domain/faceplate";

export const RACK_INTERIOR_W = RAIL_WIDTH_IN * PX_PER_IN; // 912 — device mount width (rail-to-rail, 19")
const MOUNT_HW = RACK_INTERIOR_W / 2;                     // 456 — half mount (ref 270)
const hx = (r: number) => (r / 270) * MOUNT_HW;           // reference x (from centre) → our px
const Ky = RU_PX / 50;                                    // reference RU 50 → our RU_PX (vertical scale)
const LINE_W = hx(1);                                     // ref stroke-width 1, scaled (~1.69)

// Palette (ref classes): foreground/80 outline, light-gray ears, white holes/interior, blue ⊕.
const RK_LINE = "#3f3f46";  // frame outline, ruler, ventilation slats
const RK_EAR = "#a3a3a3";   // mounting ears — matches the device screw-hole gray
const RK_SEP = "#e4e4e7";   // dashed RU separators (lighter)
const RK_HOLE = "#ffffff";  // ear holes + device interior
/** The one selection blue: free-slot ⊕, drag ghost, the selection box, and a selected device's
 *  mounting ears. Everything that marks "selected" MUST take it from here.
 *  NOT Tailwind's `blue-500` class: under Tailwind v4 that resolves through oklch to rgb(43,127,255),
 *  which is visibly a different blue from this hex's rgb(59,130,246) — mixing the two makes a
 *  selected device read as two mismatched pieces. */
export const RK_SELECT = "#3b82f6";
const RK_PLUS = RK_SELECT;  // free-slot ⊕ marker

// Frame half-widths (ref units from centre). The mounting ears stay at the mount edge (270); the
// cabinet is pulled IN so the white gap between the inner wall and the ear equals the ear width.
const EAR_OUT = 270;                // ear outer edge (= mount half-width) — fixed
const EAR_W = 0.75 * PX_PER_IN;     // 36px — mounting-ear width; matches the faceplate's 0.75" device ear
const MOAT = 60;                    // white gap inner-wall → ear — widened to give patch cables room
                                    // to breathe next to the rack (PatchDocs proportion: ~70 ref units)
const IW = EAR_OUT + MOAT;          // 330 — inner wall
const OW = IW + 10;                 // 340 — outer wall (matches PatchDocs' cabinet outline at ±340)
const RULER_V = OW + 50;            // 350 — ruler line/ticks (ref: outer+50)
const RULER_N = OW + 60;            // 360 — ruler numbers (ref: outer+60)
const LIP = OW - 5;                 // 295 — cap/base lip (ref: outer-5)
const VENT = OW - 45;               // 255 — ventilation plinth (ref: outer-45)
const FOOT_OUT = OW - 55.5;         // 244.5 — foot outer edge (ref: outer-55.5)
const VENT_MARGIN = 39.5, BAR_PITCH = 11.5, BAR_W = 5; // ventilation slats (ref proportions)

// Rack centre x: leave room left of the RU numbers.
const CX = hx(RULER_N) + 46;
const TOP = 58 * Ky;                        // interior top edge (cap sits 58 ref-units above it)
export const RACK_GUTTER_L = CX - MOUNT_HW; // device-mount left edge (= RackCanvas ix)
export const RACK_PAD = 0;
// x of the shared patch-cable trunk (the "meeting point" cables converge on) — seated in the gutter
// to the LEFT of the devices (~65% of the way across the moat toward the cabinet wall), like PatchDocs.
export const RACK_CABLE_LANE_X = RACK_GUTTER_L - hx(MOAT) * 0.65;

export interface RackPlacementRender {
  id: string;
  startU: number;
  code?: string; // vertical tag at the device's left edge (SW01 …)
  template: { rackUnits: number; widthIn: number; rackMounted: boolean; frontFace: Face; backFace: Face };
}

export function rackSvgSize(heightU: number): { width: number; height: number } {
  return {
    width: CX + hx(OW) + 12,
    height: heightU * RU_PX + 145 * Ky, // cap(58) above TOP + units + pedestal/feet(87) below
  };
}

/** svg-y of the TOP edge of a span starting at startU (bottom-up numbering). */
export function ruTopY(startU: number, rackUnits: number, heightU: number): number {
  const topU = startU + rackUnits - 1;
  return TOP + (heightU - topU) * RU_PX;
}

// Static rack chrome — depends only on heightU + occupancy, so it's a memo() child (see the grip-
// drag note: this keeps a drag re-render cheap). RackFrame itself stays hook-free / callable.
const RackChrome = memo(function RackChrome({ heightU, placements }: {
  heightU: number; placements: RackPlacementRender[];
}) {
  const unitsBottom = TOP + heightU * RU_PX;
  const occupied = new Set<number>();
  for (const p of placements) {
    for (let u = p.startU; u < p.startU + p.template.rackUnits; u++) occupied.add(u);
  }
  const units = Array.from({ length: heightU }, (_, i) => i + 1);
  const boundaries = Array.from({ length: heightU + 1 }, (_, i) => TOP + i * RU_PX);
  const line = { fill: "none", stroke: RK_LINE, strokeWidth: LINE_W } as const;

  return (
    <>
      {/* top: cap + lip + bracketed enclosure top (nested outlines) */}
      <rect x={CX - hx(OW)} y={TOP - 58 * Ky} width={hx(2 * OW)} height={31 * Ky} {...line} />
      <rect x={CX - hx(LIP)} y={TOP - 27 * Ky} width={hx(2 * LIP)} height={7 * Ky} {...line} />

      {/* double-wall enclosure — line-art, transparent fill. Outer at ±OW, inner at ±IW (10 gap);
          the white moat from the inner wall to the ear is MOAT wide, matching the mounting ear. */}
      <rect x={CX - hx(OW)} y={TOP - 20 * Ky} width={hx(2 * OW)} height={heightU * RU_PX + 40 * Ky} {...line} />
      <rect x={CX - hx(IW)} y={TOP - 10 * Ky} width={hx(2 * IW)} height={heightU * RU_PX + 20 * Ky} {...line} />

      {/* device interior (white) + gray mounting ears, inset from the walls */}
      <rect x={CX - hx(250)} y={TOP} width={hx(500)} height={heightU * RU_PX} fill={RK_HOLE} />
      <rect x={CX - hx(EAR_OUT)} y={TOP} width={EAR_W} height={heightU * RU_PX} fill={RK_EAR} />
      <rect x={CX + hx(EAR_OUT) - EAR_W} y={TOP} width={EAR_W} height={heightU * RU_PX} fill={RK_EAR} />

      {/* ear holes — 3 white square holes per ear on every RU (the installed device's opaque ear
          draws over the ones it covers). Offsets 4/22/40 from RU top. */}
      {units.map((u) => {
        const uTop = ruTopY(u, 1, heightU);
        return [4, 22, 40].map((dy) => (
          <g key={`${u}-${dy}`}>
            <rect x={CX - hx(EAR_OUT) + EAR_W / 2 - hx(3)} y={uTop + dy * Ky} width={hx(6)} height={6 * Ky} fill={RK_HOLE} />
            <rect x={CX + hx(EAR_OUT) - EAR_W / 2 - hx(3)} y={uTop + dy * Ky} width={hx(6)} height={6 * Ky} fill={RK_HOLE} />
          </g>
        ));
      })}

      {/* dashed RU separators (across the interior at every boundary) */}
      {boundaries.map((y, i) => (
        <line key={`sep${i}`} x1={CX - hx(250)} x2={CX + hx(250)} y1={y} y2={y}
          stroke={RK_SEP} strokeWidth={LINE_W} strokeDasharray={`${4 * Ky}`} />
      ))}

      {/* external RU ruler: vertical line + per-boundary ticks + centred numerals (bottom-up) */}
      <line x1={CX - hx(RULER_V)} x2={CX - hx(RULER_V)} y1={TOP} y2={unitsBottom} {...line} />
      {boundaries.map((y, i) => (
        <line key={`tick${i}`} x1={CX - hx(RULER_V)} x2={CX - hx(RULER_V - 5)} y1={y} y2={y} {...line} />
      ))}
      {units.map((u) => (
        <text key={`num${u}`} x={CX - hx(RULER_N)} y={ruTopY(u, 1, heightU) + RU_PX / 2}
          textAnchor="end" dominantBaseline="middle" fontSize={16 * Ky} fontWeight={500} fill={RK_LINE}>{u}</text>
      ))}

      {/* free-slot ⊕ markers (Tabler circle-plus: r 9, plus ±3 — scaled) */}
      {units.filter((u) => !occupied.has(u)).map((u) => {
        const cy = ruTopY(u, 1, heightU) + RU_PX / 2;
        return (
          <g key={`slot${u}`} stroke={RK_PLUS} strokeWidth={2 * Ky} strokeLinecap="round" fill="none" data-testid="rack-slot">
            <circle cx={CX} cy={cy} r={9 * Ky} />
            <path d={`M ${CX - 3 * Ky} ${cy} h ${6 * Ky} M ${CX} ${cy - 3 * Ky} v ${6 * Ky}`} />
          </g>
        );
      })}

      {/* bottom: bracketed enclosure bottom + lip + ventilation plinth (dark slats) + feet */}
      <rect x={CX - hx(LIP)} y={unitsBottom + 20 * Ky} width={hx(2 * LIP)} height={6 * Ky} {...line} />
      <rect data-testid="rack-brush" x={CX - hx(VENT)} y={unitsBottom + 26 * Ky} width={hx(2 * VENT)} height={52 * Ky} {...line} />
      {(() => {
        const span = VENT - VENT_MARGIN; // slats fill the plinth with the reference edge margin
        const n = Math.floor((2 * span - BAR_W) / BAR_PITCH) + 1;
        return Array.from({ length: n }, (_, i) => (
          <rect key={i} x={CX + hx(-span + i * BAR_PITCH)} y={unitsBottom + 34.5 * Ky}
            width={hx(BAR_W)} height={35 * Ky} fill={RK_LINE} />
        ));
      })()}
      <rect data-testid="rack-foot" x={CX - hx(FOOT_OUT)} y={unitsBottom + 78 * Ky} width={hx(103)} height={9 * Ky} {...line} />
      <rect data-testid="rack-foot" x={CX + hx(FOOT_OUT - 103)} y={unitsBottom + 78 * Ky} width={hx(103)} height={9 * Ky} {...line} />
    </>
  );
});

export function RackFrame({ heightU, placements, side, dragId = null, highlight = null, selectedId = null }: {
  heightU: number; placements: RackPlacementRender[]; side: "FRONT" | "BACK";
  dragId?: string | null;  // id of the device being grip-dragged (its faceplate + this ghost move imperatively)
  highlight?: HighlightPort[] | null; // ports to colour (glyph + label); matched per-device by groupId + color
  selectedId?: string | null; // selected device — its mounting ears take the selection blue
}) {
  const ix = RACK_GUTTER_L + RACK_PAD; // device-mount left edge (faceplate origin)
  return (
    <g data-testid="rack-frame">
      <RackChrome heightU={heightU} placements={placements} />

      {/* ghost slot: where a grip-dragged device will snap on release — mounted at the device's
          current RU, then repositioned imperatively during the drag (see RackCanvas). */}
      {dragId != null && (() => {
        const dp = placements.find((p) => p.id === dragId);
        if (!dp) return null;
        // Sits exactly on the device's footprint, so it takes the device's own corner radius.
        return <rect data-testid="rack-ghost" x={ix} y={ruTopY(dp.startU, dp.template.rackUnits, heightU)}
          width={RACK_INTERIOR_W} height={dp.template.rackUnits * RU_PX} rx={CORNER_R}
          fill="#3b82f6" fillOpacity={0.08} stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="7 5" />;
      })()}

      {/* placements: faceplate + vertical code tag at the left edge */}
      {placements.map((p) => {
        const dragging = p.id === dragId; // its transform is driven imperatively during the drag
        const y = ruTopY(p.startU, p.template.rackUnits, heightU);
        const face = side === "FRONT" ? p.template.frontFace : p.template.backFace;
        const opts = {
          widthIn: p.template.widthIn, rackUnits: p.template.rackUnits, rackMounted: p.template.rackMounted,
          // A selected device paints its ears the same blue as the selection box around it.
          earColor: p.id === selectedId ? RK_SELECT : undefined,
        };
        return (
          <g key={p.id} data-testid={`rack-device-${p.id}`} transform={`translate(${ix}, ${y})`}
            opacity={dragging ? 0.95 : 1} style={dragging ? { filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.25))" } : undefined}>
            {renderFace(face, opts, highlight ?? undefined)}
            {p.code && (() => {
              const midY = (p.template.rackUnits * RU_PX) / 2;
              return <text x={18} y={midY} fontSize={16} fontWeight={600} fill="#6b7280"
                textAnchor="middle" dominantBaseline="central"
                transform={`rotate(-90 18 ${midY})`}>{p.code}</text>;
            })()}
          </g>
        );
      })}
    </g>
  );
}
