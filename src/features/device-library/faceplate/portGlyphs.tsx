import type { ReactNode } from "react";
import type { Media } from "@/domain/faceplate";
import { GLYPH_W } from "@/domain/faceplate-geometry";

export interface GlyphSpec {
  viewBox: string;
  height: number; // rendered px height at GLYPH_W width
  body: ReactNode;
}

// Fixed slot height for palette chips so every chip lands the same height and
// matches the Elements chips. Matches the 18px Elements icons; the one glyph that
// is taller (ps2 = 20) overflows ~1px into the chip padding, which is harmless.
export const GLYPH_SLOT_H = 18;

// Our own original, connector-accurate glyphs. Each is authored so that at
// width=GLYPH_W it reads unmistakably as its connector while every glyph keeps
// the same rendered width. currentColor drives the fill.
export const PORT_GLYPHS: Record<Media, GlyphSpec> = {
  copper: {
    viewBox: "3 4.5 18 15",
    height: 17,
    body: (
      <path
        d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-5v2a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"
        fill="currentColor"
      />
    ),
  },
  fiber: {
    viewBox: "2 6 20 12",
    height: 12,
    body: (
      <>
        <rect x="2.5" y="6.5" width="19" height="11" rx="2" fill="currentColor" />
        <rect x="5" y="9" width="6" height="6" rx="1" fill="#fff" />
        <rect x="13" y="9" width="6" height="6" rx="1" fill="#fff" />
        <circle cx="8" cy="12" r="1.4" fill="currentColor" />
        <circle cx="16" cy="12" r="1.4" fill="currentColor" />
      </>
    ),
  },
  sfp: {
    viewBox: "4 6 16 12",
    height: 15,
    body: <rect x="4" y="6" width="16" height="12" rx="2.5" fill="currentColor" />,
  },
  usb_a: {
    viewBox: "3.5 7 17 10",
    height: 12,
    body: (
      <>
        <rect x="3.5" y="7" width="17" height="10" rx="1.5" fill="currentColor" />
        <rect x="6" y="11.4" width="12" height="3.2" rx=".6" fill="#fff" />
        <rect x="7.5" y="12.3" width="3.2" height="1.4" fill="currentColor" />
        <rect x="13.3" y="12.3" width="3.2" height="1.4" fill="currentColor" />
      </>
    ),
  },
  usb_c: {
    viewBox: "2.5 8 19 8",
    height: 9,
    body: (
      <>
        <rect x="2.5" y="8" width="19" height="8" rx="4" fill="currentColor" />
        <rect x="6.5" y="10.4" width="11" height="3.2" rx="1.6" fill="#fff" />
      </>
    ),
  },
  hdmi: {
    viewBox: "3.5 7 17 9.5",
    height: 11,
    body: (
      <>
        <path
          d="M4 7.5h16v3.2l-2.4 4.8a1 1 0 0 1-.9.6H7.3a1 1 0 0 1-.9-.6L4 10.7z"
          fill="currentColor"
        />
        <rect x="7" y="9.3" width="10" height="1.8" rx=".7" fill="#fff" />
      </>
    ),
  },
  dp: {
    viewBox: "3.5 7 17 10",
    height: 12,
    body: (
      <>
        <path
          d="M4 7.5h11.5l4.5 3.4V15.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"
          fill="currentColor"
        />
        <rect x="6.5" y="9.4" width="9.5" height="1.8" rx=".7" fill="#fff" />
      </>
    ),
  },
  vga: {
    viewBox: "2 6 24 12",
    height: 10,
    body: (
      <>
        <path d="M3 6.5h22l-1.7 11H4.7L3 6.5z" fill="currentColor" />
        <g fill="#fff">
          <circle cx="7" cy="9" r=".9" />
          <circle cx="10.5" cy="9" r=".9" />
          <circle cx="14" cy="9" r=".9" />
          <circle cx="17.5" cy="9" r=".9" />
          <circle cx="21" cy="9" r=".9" />
          <circle cx="9" cy="15" r=".9" />
          <circle cx="12.2" cy="15" r=".9" />
          <circle cx="15.4" cy="15" r=".9" />
          <circle cx="18.6" cy="15" r=".9" />
        </g>
      </>
    ),
  },
  ps2: {
    viewBox: "3.5 3.5 17 17",
    height: 20,
    body: (
      <>
        <circle cx="12" cy="12" r="8.5" fill="currentColor" />
        <rect x="10.7" y="4.5" width="2.6" height="3" rx="1" fill="#fff" />
        <g fill="#fff">
          <circle cx="8.3" cy="10.3" r="1.05" />
          <circle cx="15.7" cy="10.3" r="1.05" />
          <circle cx="12" cy="11.4" r="1.05" />
        </g>
      </>
    ),
  },
  audio: {
    viewBox: "3.5 4 17 16",
    height: 18,
    body: (
      <>
        <circle cx="12" cy="12" r="8" fill="currentColor" />
        <circle cx="12" cy="12" r="4.6" fill="#fff" />
        <circle cx="12" cy="12" r="1.9" fill="currentColor" />
      </>
    ),
  },
};

/**
 * Standalone glyph at normalized width, centered in a fixed-height slot so every
 * palette chip is the same size regardless of the glyph's natural height.
 */
export function PortGlyph({ media }: { media: Media }) {
  const spec = PORT_GLYPHS[media];
  return (
    <span style={{ display: "flex", width: GLYPH_W, height: GLYPH_SLOT_H, alignItems: "center", justifyContent: "center" }}>
      <svg width={GLYPH_W} height={spec.height} viewBox={spec.viewBox} style={{ display: "block" }}>
        {spec.body}
      </svg>
    </span>
  );
}
