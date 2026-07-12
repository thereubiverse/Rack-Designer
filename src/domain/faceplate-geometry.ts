// Pure rack-mount geometry for the SVG faceplate renderer. No React, no I/O.
// Reused unchanged by the Phase 2b rack view.
import { MAX_BODY_WIDTH_IN } from "./faceplate";

export const RAIL_WIDTH_IN = 19;   // EIA 19" rack rail-to-rail width
export const U_HEIGHT_IN = 1.75;   // one rack unit
export const PX_PER_IN = 48;       // rendering scale (19" -> 912px, 1U -> 84px)
export const RU_PX = U_HEIGHT_IN * PX_PER_IN; // one rack unit in px (84)
export const CELL_W = 24;          // uniform port cell width (px)
export const ROW_H = 24;           // uniform port cell height (px)
export const GLYPH_W = 20;         // normalized glyph width (px)
export const LABEL_H = 12;         // vertical strip for a port's number label
export const SCREW_EDGE_INSET_PX = 18; // screw-hole centre distance from the outer rail edge
export const GRID_IN = 0.25;       // snap-to-grid step (inches)
export const GRID_PX = PX_PER_IN * GRID_IN; // 12px — and CELL_W/ROW_H (24) & 1U (84) are multiples

/** Ear width (inches) on ONE side: half the gap between body and the rails. */
export function earWidthIn(bodyWidthIn: number, rackMounted: boolean): number {
  if (!rackMounted) return 0;
  return Math.max(0, (RAIL_WIDTH_IN - bodyWidthIn) / 2);
}

export interface FrameDims {
  frameWidthIn: number;
  bodyWidthIn: number;
  earWidthIn: number;
  heightIn: number;
  frameWidthPx: number;
  bodyWidthPx: number;
  earWidthPx: number;
  heightPx: number;
}

export function frameDims(opts: {
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
}): FrameDims {
  const { widthIn, rackUnits, rackMounted } = opts;
  const bodyWidthIn = Math.min(widthIn, MAX_BODY_WIDTH_IN);
  const ear = earWidthIn(bodyWidthIn, rackMounted);
  const frameWidthIn = rackMounted ? RAIL_WIDTH_IN : bodyWidthIn;
  const heightIn = U_HEIGHT_IN * rackUnits;
  return {
    frameWidthIn,
    bodyWidthIn,
    earWidthIn: ear,
    heightIn,
    frameWidthPx: frameWidthIn * PX_PER_IN,
    bodyWidthPx: bodyWidthIn * PX_PER_IN,
    earWidthPx: ear * PX_PER_IN,
    heightPx: heightIn * PX_PER_IN,
  };
}

export interface ScrewHole {
  cx: number;
  cy: number;
}

/**
 * Screw holes pinned near the outer rail edges so they line up on the rack
 * regardless of body width. 2 holes per ear — near the top & bottom corners of
 * the whole faceplate (not repeated per U). Returns [] when there are no ears.
 */
export function screwHoles(dims: FrameDims, _rackUnits: number): ScrewHole[] {
  if (dims.earWidthPx <= 0) return [];
  // Fixed distance from the outer rail edge regardless of body width, clamped so a
  // thin ear (wide body) still keeps the hole centred inside it.
  const inset = Math.min(SCREW_EDGE_INSET_PX, dims.earWidthPx / 2);
  const leftX = inset;
  const rightX = dims.frameWidthPx - inset;
  // Inset from each edge so the screw circle lands dead-centre on the rack's square
  // mounting point: those sit 7 ref-units (4px offset + 3px half-height on a 50px RU)
  // below the RU top, i.e. RU_PX*7/50 = 11.76px.
  const edge = (RU_PX * 7) / 50;
  const holes: ScrewHole[] = [];
  for (const cx of [leftX, rightX]) {
    holes.push({ cx, cy: edge });
    holes.push({ cx, cy: dims.heightPx - edge });
  }
  return holes;
}

import type { PortGroup, Media, CountingDirection } from "./faceplate";

/** 1-based sequence number per row-major index for a counting direction. */
export function portSequence(
  rows: number,
  cols: number,
  direction: CountingDirection,
): number[] {
  const seq: number[] = [];
  for (let index = 0; index < rows * cols; index++) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    let n: number;
    switch (direction) {
      case "ltr":
        n = row * cols + col + 1;
        break;
      case "rtl":
        n = row * cols + (cols - 1 - col) + 1;
        break;
      case "ttb":
        n = col * rows + row + 1;
        break;
      case "btt":
        n = col * rows + (rows - 1 - row) + 1;
        break;
    }
    seq.push(n);
  }
  return seq;
}

export interface LaidOutPort {
  index: number;
  row: number;
  col: number;
  x: number;
  y: number;
  number: number;
  label: string;
  labelPos: "top" | "bottom";
  flipped: boolean;
  rotation: number;
  media: Media;
  connectorType: string;
}

export interface LaidOutGroup {
  id: string;
  cells: LaidOutPort[];
  width: number;
  height: number;
  top: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function layoutPortGroup(group: PortGroup, heightPx?: number): LaidOutGroup {
  const seq = portSequence(group.rows, group.cols, group.countingDirection);

  // Resolve each cell's label side up front — the inter-row gaps depend on which labels face
  // inward (a label is drawn LABEL_H tall in the gap next to its cell).
  const labelPosFor = (index: number): "top" | "bottom" => {
    const row = Math.floor(index / group.cols);
    // Default label side: a 2-row group keeps the common top/bottom split; a dense (3+ row)
    // group puts every label on the bottom so they don't collide. A single row labels on top.
    const defaultLabelPos: "top" | "bottom" =
      group.rows >= 3 ? "bottom" : group.rows === 2 && row === group.rows - 1 ? "bottom" : "top";
    return group.portOverrides[index]?.labelPos ?? defaultLabelPos;
  };

  // Per row: does any port's label face up / down? (Ports in a row can be toggled individually.)
  const rowHasTop: boolean[] = Array.from({ length: group.rows }, () => false);
  const rowHasBottom: boolean[] = Array.from({ length: group.rows }, () => false);
  for (let index = 0; index < group.rows * group.cols; index++) {
    const row = Math.floor(index / group.cols);
    if (labelPosFor(index) === "top") rowHasTop[row] = true;
    else rowHasBottom[row] = true;
  }

  // Gap above row r (r >= 1): reserve a label's height for every label that lands in that gap —
  // the row above's bottom label and this row's top label — so an inward-facing label never
  // overlaps the neighbouring glyph. Never smaller than the group's own rowSpacing.
  const gapAbove = (r: number): number =>
    Math.max(group.rowSpacing, (rowHasBottom[r - 1] ? LABEL_H : 0) + (rowHasTop[r] ? LABEL_H : 0));

  // Cumulative y-offset of each row from the top of the stack.
  const rowY: number[] = [0];
  for (let r = 1; r < group.rows; r++) rowY[r] = rowY[r - 1] + ROW_H + gapAbove(r);
  const height = (rowY[group.rows - 1] ?? 0) + ROW_H;

  // Vertical origin: centered in the device (when heightPx is provided) plus an optional
  // yOffset for groups dragged up/down on 2RU+ devices, clamped so the stack stays inside
  // the device. Falls back to legacy gridY when no device height is given.
  let top: number;
  if (heightPx !== undefined) {
    const center = (heightPx - height) / 2;
    top = Math.max(0, Math.min(center + (group.yOffset ?? 0), Math.max(0, heightPx - height)));
  } else {
    top = group.gridY;
  }
  const cells: LaidOutPort[] = [];
  for (let index = 0; index < group.rows * group.cols; index++) {
    const row = Math.floor(index / group.cols);
    const col = index % group.cols;
    const override = group.portOverrides[index];
    const number = seq[index];
    const label = override?.name ?? `${group.idPrefix}${pad2(number)}`;
    cells.push({
      index,
      row,
      col,
      x: group.gridX + col * (CELL_W + group.colSpacing),
      y: top + rowY[row],
      number,
      label,
      labelPos: labelPosFor(index),
      flipped: override?.flipped ?? false,
      rotation: override?.rotation ?? 0,
      media: override?.media ?? group.media,
      connectorType: override?.connectorType ?? group.connectorType,
    });
  }
  const width = group.cols * CELL_W + Math.max(0, group.cols - 1) * group.colSpacing;
  return { id: group.id, cells, width, height, top };
}
