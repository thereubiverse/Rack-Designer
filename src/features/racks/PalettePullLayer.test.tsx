import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { PalettePullLayer, type PullState } from "./PalettePullLayer";
import { RACK_INTERIOR_W, RK_SELECT } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { restingJiggle, JIGGLE_MAX, jiggleScale, SNAP_MS } from "./palettePull";

const CHIP = { w: 132, h: 34 };

function pull(over: Partial<PullState> = {}): PullState {
  return {
    typeId: "t1", label: "Switch", chip: { x: 100, y: 100 }, chipSize: CHIP,
    x: 100, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, snapSize: null,
    vx: 0, vy: 0, lastMoveAt: 0, jiggle: restingJiggle(), ...over,
  };
}
const mount = (state: PullState | null) => {
  const ref = createRef<PullState | null>() as React.MutableRefObject<PullState | null>;
  ref.current = state;
  const r = render(<PalettePullLayer pullRef={ref} scaleOf={() => 1} />);
  return { ...r, ref };
};
const box = (c: HTMLElement) => c.querySelector('[data-testid="pull-box"]') as HTMLElement;
const rgbOf = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; // the DOM normalises hexes
};

describe("PalettePullLayer", () => {
  it("renders nothing when there is no pull", () => {
    const { container } = mount(null);
    expect(container.querySelector('[data-testid="pull-box"]')).toBeNull();
  });

  it("what you pick up is the CHIP — its size, wearing the selection blue", () => {
    const { container } = mount(pull({ x: 300, y: 200 }));
    const b = box(container);
    expect(b.style.width).toBe(`${CHIP.w}px`);
    expect(b.style.height).toBe(`${CHIP.h}px`);
    // The same blue the selected device wears, so the gesture is one continuous object.
    expect(b.style.borderColor).toBe(rgbOf(RK_SELECT));
  });

  it("it is centred on the cursor, not hung off its corner", () => {
    const { container } = mount(pull({ x: 300, y: 200 }));
    const t = box(container).style.transform;
    expect(t).toContain("translate(300px, 200px)");
    expect(t).toContain("translate(-50%, -50%)");   // after the rotate/scale, so both act about the middle
  });

  it("carries the chip's label and no device face until it opens", () => {
    const { container } = mount(pull({ x: 300, y: 200 }));
    expect(container.querySelector('[data-testid="pull-label"]')!.textContent).toBe("Switch");
    expect(Number((container.querySelector('[data-testid="pull-label"]') as HTMLElement).style.opacity)).toBe(1);
    expect(Number((container.querySelector('[data-testid="pull-face"]') as HTMLElement).style.opacity)).toBe(0);
  });

  it("once open it IS the rack device, selected — blue ears, no ports, label gone", () => {
    // snapStart 0 against a live performance.now() puts the spring well past its ring-out.
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100, snapStart: 0 }));
    const ears = [...container.querySelectorAll('[data-testid="face-ear"]')];
    expect(ears).toHaveLength(2);
    expect(ears.every((e) => e.getAttribute("fill") === RK_SELECT)).toBe(true);  // arrives SELECTED
    expect(container.querySelectorAll('[data-testid="port-cell"]')).toHaveLength(0);
    expect(Number((container.querySelector('[data-testid="pull-face"]') as HTMLElement).style.opacity)).toBe(1);
    expect(Number((container.querySelector('[data-testid="pull-label"]') as HTMLElement).style.opacity)).toBe(0);
  });

  it("settles at exactly one RU", () => {
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100, snapStart: 0 }));
    expect(box(container).style.width).toBe(`${RACK_INTERIOR_W}px`);
    expect(box(container).style.height).toBe(`${RU_PX}px`);
  });

  it("the cross-fade opacities stay in 0..1 even while the spring overshoots", () => {
    // latchGrow sails past 1 mid-spring — that IS the pop — so a raw openness would drive opacity
    // above 1, and negative on any undershoot. Sample across the whole spring, not just its ends.
    const now = performance.now();
    for (let dt = 0; dt <= SNAP_MS * 1.5; dt += SNAP_MS / 30) {
      const { container, unmount } = mount(pull({ phase: "solid", x: 400, y: 100, snapStart: now - dt }));
      for (const id of ["pull-face", "pull-label"]) {
        const o = Number((container.querySelector(`[data-testid="${id}"]`) as HTMLElement).style.opacity);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(1);
      }
      unmount();
    }
  });

  it("leans into the direction of travel and squashes across it", () => {
    const { container } = mount(pull({ x: 300, y: 100, jiggle: { stretch: JIGGLE_MAX, v: 0, angle: Math.PI / 2 } }));
    const { along, across } = jiggleScale(JIGGLE_MAX);
    const t = box(container).style.transform;
    expect(t).toContain("rotate(90deg)");
    expect(t).toContain(`scale(${along}, ${across})`);
  });

  it("is an undeformed chip at rest", () => {
    expect(box(mount(pull({ x: 300, y: 100 })).container).style.transform).toContain("scale(1, 1)");
  });

  it("is translucent, so the rack reads through what you are holding", () => {
    const o = Number(box(mount(pull({ x: 300, y: 100 })).container).style.opacity);
    expect(o).toBeGreaterThan(0);
    expect(o).toBeLessThan(1);
  });

  it("never intercepts the pointer — the rack strips underneath must still get it", () => {
    const { container } = mount(pull({ x: 300, y: 100 }));
    expect((container.querySelector('[data-testid="pull-layer"]') as HTMLElement).className).toContain("pointer-events-none");
  });
});
