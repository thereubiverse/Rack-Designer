import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PORT_GLYPHS, PortGlyph } from "./portGlyphs";
import { GLYPH_W } from "@/domain/faceplate-geometry";
import { MEDIA } from "@/domain/faceplate";

describe("port glyphs", () => {
  it("defines a glyph for every media type", () => {
    for (const m of MEDIA) {
      expect(PORT_GLYPHS[m]).toBeDefined();
      expect(PORT_GLYPHS[m].viewBox).toMatch(/^[\d.\s-]+$/);
    }
  });

  it("renders every glyph at the normalized width", () => {
    for (const m of MEDIA) {
      const { container, unmount } = render(<PortGlyph media={m} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe(String(GLYPH_W));
      unmount();
    }
  });

  it("drives fill from currentColor (themable)", () => {
    const { container } = render(<PortGlyph media="copper" />);
    expect(container.innerHTML).toContain("currentColor");
  });
});
