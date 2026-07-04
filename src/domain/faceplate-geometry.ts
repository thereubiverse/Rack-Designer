// Pure rack-mount geometry for the SVG faceplate renderer. No React, no I/O.
// Reused unchanged by the Phase 2b rack view.

export const RAIL_WIDTH_IN = 19;   // EIA 19" rack rail-to-rail width
export const U_HEIGHT_IN = 1.75;   // one rack unit
export const PX_PER_IN = 48;       // rendering scale (19" -> 912px, 1U -> 84px)
export const CELL_W = 24;          // uniform port cell width (px)
export const ROW_H = 24;           // uniform port cell height (px)
export const GLYPH_W = 20;         // normalized glyph width (px)

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
  const bodyWidthIn = rackMounted ? Math.min(widthIn, RAIL_WIDTH_IN) : widthIn;
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
 * regardless of body width. 2 holes per U per ear (top & bottom third of each
 * U). Returns [] when there are no ears.
 */
export function screwHoles(dims: FrameDims, rackUnits: number): ScrewHole[] {
  if (dims.earWidthPx <= 0) return [];
  const leftX = dims.earWidthPx / 2;
  const rightX = dims.frameWidthPx - dims.earWidthPx / 2;
  const uPx = U_HEIGHT_IN * PX_PER_IN;
  const holes: ScrewHole[] = [];
  for (const cx of [leftX, rightX]) {
    for (let u = 0; u < rackUnits; u++) {
      const top = u * uPx;
      holes.push({ cx, cy: top + uPx * 0.28 });
      holes.push({ cx, cy: top + uPx * 0.72 });
    }
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
  flipped: boolean;
  media: Media;
  connectorType: string;
}

export interface LaidOutGroup {
  id: string;
  cells: LaidOutPort[];
  width: number;
  height: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function layoutPortGroup(group: PortGroup): LaidOutGroup {
  const seq = portSequence(group.rows, group.cols, group.countingDirection);
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
      y: group.gridY + row * (ROW_H + group.rowSpacing),
      number,
      label,
      flipped: override?.flipped ?? false,
      media: group.media,
      connectorType: group.connectorType,
    });
  }
  const width = group.cols * CELL_W + Math.max(0, group.cols - 1) * group.colSpacing;
  const height = group.rows * ROW_H + Math.max(0, group.rows - 1) * group.rowSpacing;
  return { id: group.id, cells, width, height };
}
