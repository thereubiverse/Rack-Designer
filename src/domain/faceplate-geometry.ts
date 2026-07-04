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
