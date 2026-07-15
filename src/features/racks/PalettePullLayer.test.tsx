import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { PalettePullLayer, type PullState } from "./PalettePullLayer";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { PULL_DIST } from "./palettePull";

function pull(over: Partial<PullState> = {}): PullState {
  return {
    typeId: "t1", chip: { x: 100, y: 100 }, chipSize: { w: 132, h: 34 },
    x: 100, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, ...over,
  };
}
const mount = (state: PullState | null) => {
  const ref = createRef<PullState | null>() as React.MutableRefObject<PullState | null>;
  ref.current = state;
  const r = render(<PalettePullLayer pullRef={ref} scaleOf={() => 1} />);
  return { ...r, ref };
};

describe("PalettePullLayer", () => {
  it("renders nothing when there is no pull", () => {
    const { container } = mount(null);
    expect(container.querySelector('[data-testid="pull-box"]')).toBeNull();
  });

  it("draws the blank device with ears and no ports", () => {
    // The dragged thing is a blank device: the faceplate frame + ears, drawn by the SAME renderer
    // the rack uses, with an empty face. A type has no port layout, so there are no ports.
    const { container } = mount(pull({ x: 300, y: 100 }));
    expect(container.querySelector('[data-testid="pull-box"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="face-ear"]').length).toBe(2);
    expect(container.querySelectorAll('[data-testid="port-cell"]').length).toBe(0);
  });

  it("is exactly one RU when solid", () => {
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100 }));
    const box = container.querySelector('[data-testid="pull-box"]') as HTMLElement;
    expect(box.style.width).toBe(`${RACK_INTERIOR_W}px`);
    expect(box.style.height).toBe(`${RU_PX}px`);
  });

  it("shows the gooey neck while stretching and drops it once solid", () => {
    const mid = mount(pull({ x: 100 + PULL_DIST / 2, y: 100 }));
    const neck = mid.container.querySelector('[data-testid="pull-neck"]') as SVGPathElement;
    expect(neck.getAttribute("d")).not.toBe("");

    const solid = mount(pull({ phase: "solid", x: 400, y: 100 }));
    const gone = solid.container.querySelector('[data-testid="pull-neck"]');
    expect(gone === null || gone.getAttribute("d") === "").toBe(true);
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
});
