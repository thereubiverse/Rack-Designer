import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { PalettePullLayer, type PullState } from "./PalettePullLayer";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { PULL_DIST } from "./palettePull";

function pull(over: Partial<PullState> = {}): PullState {
  return {
    typeId: "t1", chip: { x: 100, y: 100 }, chipSize: { w: 132, h: 34 },
    x: 100, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, snapSize: null, ...over,
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

  it("while pulling it shows the BLOB and hides the device", () => {
    // Both shapes are always mounted (the rAF loop writes styles; it cannot add/remove elements), so
    // asserting the device's ears merely EXIST would pass even when the device is the hidden one.
    // Assert what is actually displayed.
    const { container } = mount(pull({ x: 300, y: 100 }));
    const blob = container.querySelector('[data-testid="pull-blob"]') as HTMLElement;
    const face = container.querySelector('[data-testid="pull-face"]') as SVGElement;
    expect(blob.style.display).not.toBe("none");
    expect((face as unknown as HTMLElement).style.display).toBe("none");
  });

  it("the blob is featureless — it must not look like the device it will become", () => {
    const { container } = mount(pull({ x: 300, y: 100 }));
    const blob = container.querySelector('[data-testid="pull-blob"]') as HTMLElement;
    expect(blob.style.borderRadius).toBe("50%");   // a lump, not a rack device's rounded rectangle
    const box = container.querySelector('[data-testid="pull-box"]') as HTMLElement;
    expect(parseFloat(box.style.width)).toBeLessThan(RACK_INTERIOR_W); // nowhere near RU size
  });

  it("once solid it shows the blank device — ears, no ports — and hides the blob", () => {
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100 }));
    const blob = container.querySelector('[data-testid="pull-blob"]') as HTMLElement;
    const face = container.querySelector('[data-testid="pull-face"]') as unknown as HTMLElement;
    expect(face.style.display).not.toBe("none");
    expect(blob.style.display).toBe("none");
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
