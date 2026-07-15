import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { PalettePullLayer, type PullState } from "./PalettePullLayer";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { PULL_DIST } from "./palettePull";

function pull(over: Partial<PullState> = {}): PullState {
  return {
    typeId: "t1", label: "Switch", chip: { x: 100, y: 100 }, chipSize: { w: 132, h: 34 },
    x: 100, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, snapSize: null, ...over,
  };
}
const mount = (state: PullState | null) => {
  const ref = createRef<PullState | null>() as React.MutableRefObject<PullState | null>;
  ref.current = state;
  const r = render(<PalettePullLayer pullRef={ref} scaleOf={() => 1} />);
  return { ...r, ref };
};
const shown = (el: Element | null) => el !== null && (el as HTMLElement).style.display !== "none";

describe("PalettePullLayer", () => {
  it("renders nothing when there is no pull", () => {
    const { container } = mount(null);
    expect(container.querySelector('[data-testid="pull-goo"]')).toBeNull();
    expect(container.querySelector('[data-testid="pull-box"]')).toBeNull();
  });

  it("while pulling it shows the goo and hides the device", () => {
    // Both are always mounted (the rAF loop writes styles; it cannot add/remove React elements), so
    // asserting either merely EXISTS would pass even when it is the hidden one.
    const { container } = mount(pull({ x: 300, y: 100 }));
    expect(shown(container.querySelector('[data-testid="pull-goo"]'))).toBe(true);
    expect(shown(container.querySelector('[data-testid="pull-box"]'))).toBe(false);
  });

  it("chip, neck and blob all sit in BOTH filtered passes — the filter fillets their joins", () => {
    const { container } = mount(pull({ x: 300, y: 100 }));
    const filtered = [...container.querySelectorAll('[data-testid="pull-goo"] g[filter]')];
    expect(filtered).toHaveLength(2);
    for (const g of filtered) {
      expect(g.querySelector('[data-testid^="pull-chip-"]')).toBeTruthy();
      expect(g.querySelector('[data-testid^="pull-neck-"]')).toBeTruthy();
      expect(g.querySelector('[data-testid^="pull-blob-"]')).toBeTruthy();
    }
    expect(container.querySelector("filter#palette-goo feGaussianBlur")).toBeTruthy();
    expect(container.querySelector("filter#palette-goo feColorMatrix")).toBeTruthy();
  });

  it("nothing is drawn separately while the cursor is still inside the chip", () => {
    // No oval forms on click: the blob is under the cursor, inside the chip, and the neck has zero
    // length — so the union's silhouette is just the chip itself.
    const { container } = mount(pull({ x: 120, y: 104 }));   // inside the 132x34 chip
    expect(container.querySelector('[data-testid="pull-neck-1"]')!.getAttribute("d")).toBe("");
  });

  it("the chip NEVER moves — only its exit point does", () => {
    const a = mount(pull({ x: 300, y: 100 }));
    const b = mount(pull({ x: 260, y: 300 }));   // cursor somewhere else entirely
    const rect = (r: ReturnType<typeof mount>) => {
      const el = r.container.querySelector('[data-testid="pull-chip-1"]') as SVGRectElement;
      return ["x", "y", "width", "height"].map((k) => el.getAttribute(k));
    };
    expect(rect(a)).toEqual(rect(b));
  });

  it("the border pass is fatter than the fill pass — that gap IS the outline", () => {
    const { container } = mount(pull({ x: 300, y: 100 }));
    const border = container.querySelector('[data-testid="pull-blob-0"]') as SVGEllipseElement;
    const fill = container.querySelector('[data-testid="pull-blob-1"]') as SVGEllipseElement;
    expect(parseFloat(border.getAttribute("rx")!)).toBeGreaterThan(parseFloat(fill.getAttribute("rx")!));
    expect(fill.parentElement!.getAttribute("fill")).toBe("#ffffff");
    expect(border.parentElement!.getAttribute("fill")).not.toBe("#ffffff");
  });

  it("the blob is exactly under the cursor", () => {
    const { container } = mount(pull({ x: 300, y: 172 }));
    const blob = container.querySelector('[data-testid="pull-blob-1"]') as SVGEllipseElement;
    expect(parseFloat(blob.getAttribute("cx")!)).toBe(300);
    expect(parseFloat(blob.getAttribute("cy")!)).toBe(172);
  });

  it("redraws the chip's label — the goo covers the real button's text", () => {
    const { container } = mount(pull({ x: 300, y: 100 }));
    expect(container.querySelector('[data-testid="pull-label"]')!.textContent).toBe("Switch");
  });

  it("once solid it shows the blank device — ears, no ports — and hides the goo", () => {
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100 }));
    expect(shown(container.querySelector('[data-testid="pull-box"]'))).toBe(true);
    expect(shown(container.querySelector('[data-testid="pull-goo"]'))).toBe(false);
    expect(container.querySelectorAll('[data-testid="face-ear"]').length).toBe(2);
    expect(container.querySelectorAll('[data-testid="port-cell"]').length).toBe(0);
  });

  it("settles at exactly one RU once the latch spring has rung out", () => {
    // snapStart 0 against a live performance.now() puts k well past 1, i.e. fully settled.
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100, snapStart: 0 }));
    const box = container.querySelector('[data-testid="pull-box"]') as HTMLElement;
    expect(box.style.width).toBe(`${RACK_INTERIOR_W}px`);
    expect(box.style.height).toBe(`${RU_PX}px`);
  });

  it("is translucent while carried, so the rack reads through it", () => {
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100 }));
    const box = container.querySelector('[data-testid="pull-box"]') as HTMLElement;
    expect(Number(box.style.opacity)).toBeGreaterThan(0);
    expect(Number(box.style.opacity)).toBeLessThan(1);
  });

  it("never intercepts the pointer — the rack strips underneath must still get it", () => {
    const { container } = mount(pull({ x: 300, y: 100 }));
    const root = container.querySelector('[data-testid="pull-layer"]') as HTMLElement;
    expect(root.className).toContain("pointer-events-none");
  });

  it("the blob never swells anywhere near RU size while it is still goo", () => {
    const { container } = mount(pull({ x: 100 + PULL_DIST * 3, y: 100 })); // pulled way out
    const blob = container.querySelector('[data-testid="pull-blob-1"]') as SVGEllipseElement;
    expect(parseFloat(blob.getAttribute("rx")!) * 2).toBeLessThan(RACK_INTERIOR_W);
  });
});
