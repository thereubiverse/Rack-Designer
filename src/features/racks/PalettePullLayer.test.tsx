import { describe, it, expect } from "vitest";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { PalettePullLayer, type PullState } from "./PalettePullLayer";
import { RACK_INTERIOR_W, RK_SELECT } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { restingFlex, FLEX_MAX, flexScale, LABEL_INSET } from "./palettePull";

const CHIP = { w: 132, h: 34 };

// The rack's centre line the layer opens the device at. A pull whose cursor x === RACK_CENTRE is
// fully open; far from it, a chip.
const RACK_CENTRE = 500;
function pull(over: Partial<PullState> = {}): PullState {
  return {
    typeId: "t1", label: "Switch", chip: { x: 100, y: 100 }, grab: { x: 0, y: 0 }, chipSize: CHIP,
    x: 100, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, snapSize: null,
    vx: 0, vy: 0, lastMoveAt: 0, flex: restingFlex(), ...over,
  };
}
/** A fully-OPEN pull: cursor parked at the rack's centre. */
const open = (over: Partial<PullState> = {}) => pull({ x: RACK_CENTRE, y: 100, ...over });
const mount = (state: PullState | null) => {
  const ref = createRef<PullState | null>() as React.MutableRefObject<PullState | null>;
  ref.current = state;
  const r = render(<PalettePullLayer pullRef={ref} scaleOf={() => 1} rackCentreXOf={() => RACK_CENTRE} />);
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
    const { container } = mount(pull({ x: 100, y: 200 }));   // cursor at the pickup origin -> a chip
    const b = box(container);
    expect(b.style.width).toBe(`${CHIP.w}px`);
    expect(b.style.height).toBe(`${CHIP.h}px`);
    // The same blue the selected device wears, so the gesture is one continuous object.
    const outline = container.querySelector('[data-testid="pull-outline"]') as HTMLElement;
    expect(outline.style.borderColor).toBe(rgbOf(RK_SELECT));
  });

  it("the blue box OVERLAPS the device outline — it is drawn last, on top", () => {
    // As the box's own CSS border it pushed the face 2px inwards, so the device's grey outline
    // showed as a second ring just inside the blue. Drawn on top it simply covers it — the same way
    // the rack draws the box around a selected device.
    const { container } = mount(open());
    const b = box(container);
    expect(b.style.borderWidth).toBe("");                    // the box itself has NO border...
    const kids = [...b.children].map((c) => c.getAttribute("data-testid"));
    expect(kids.indexOf("pull-face")).toBeLessThan(kids.indexOf("pull-outline"));  // ...it is on top
    const face = container.querySelector('[data-testid="pull-face"]') as HTMLElement;
    const outline = container.querySelector('[data-testid="pull-outline"]') as HTMLElement;
    expect(face.className).toContain("inset-0");              // and both span the SAME rect,
    expect(outline.className).toContain("inset-0");           // so the blue lands on the outline
    expect(outline.style.borderRadius).toBe(face.parentElement!.style.borderRadius);
  });

  it("it is centred on the cursor, not hung off its corner", () => {
    const { container } = mount(pull({ x: 300, y: 200 }));
    const t = box(container).style.transform;
    expect(t).toContain("translate(300px, 200px)");
    expect(t).toContain("translate(-50%, -50%)");   // after the rotate/scale, so both act about the middle
  });

  it("at pickup it is a plain chip — label left-aligned, ears fully curtained (not yet extended)", () => {
    const { container } = mount(pull({ x: 100, y: 200 }));   // cursor at the pickup origin (chip.x)
    const label = container.querySelector('[data-testid="pull-label"]') as HTMLElement;
    expect(label.textContent).toBe("Switch");
    expect(label.style.left).toBe(`${LABEL_INSET}px`);          // exactly where the chip's px-3 puts it
    expect(label.style.transform).toBe("translate(0%, -50%)");   // anchored by its left edge
    // both ears hidden: each curtain sits flush at the outline (left/right 0%) and covers the full ear.
    const cl = container.querySelector('[data-testid="pull-ear-curtain-l"]') as HTMLElement;
    const cr = container.querySelector('[data-testid="pull-ear-curtain-r"]') as HTMLElement;
    expect(cl.style.left).toBe("0%");
    expect(cr.style.right).toBe("0%");
    expect(parseFloat(cl.style.width)).toBeGreaterThan(0);       // covering the ear
    expect(parseFloat(cl.style.width)).toEqual(parseFloat(cr.style.width));
  });

  it("the name travels to the CENTRE of the device as it opens, and never fades", () => {
    const { container } = mount(open());
    const label = container.querySelector('[data-testid="pull-label"]') as HTMLElement;
    const w = parseFloat(box(container).style.width);
    // Anchor and offset move together, so the text lands truly centred without measuring its width.
    expect(label.style.left).toBe(`${w / 2}px`);
    expect(label.style.transform).toBe("translate(-50%, -50%)");
    expect(label.textContent).toBe("Switch");
  });

  it("the ears EXTEND INWARD from the outline as it opens — curtains retract to width 0", () => {
    // The refinement the user asked for: ears are not faded in, they grow from the blue edge inward.
    // Part-open, the curtains still cover part of each ear; fully open, they are gone.
    const partOpen = mount(pull({ x: (100 + RACK_CENTRE) / 2, y: 100 }));  // halfway along the journey
    const pcl = partOpen.container.querySelector('[data-testid="pull-ear-curtain-l"]') as HTMLElement;
    expect(parseFloat(pcl.style.left)).toBeGreaterThan(0);        // the ear has extended partway in...
    expect(parseFloat(pcl.style.width)).toBeGreaterThan(0);       // ...but the curtain still covers the rest

    const full = mount(open());
    const fcl = full.container.querySelector('[data-testid="pull-ear-curtain-l"]') as HTMLElement;
    const fcr = full.container.querySelector('[data-testid="pull-ear-curtain-r"]') as HTMLElement;
    expect(parseFloat(fcl.style.width)).toBeCloseTo(0, 6);        // ear fully extended, nothing left to cover
    expect(parseFloat(fcr.style.width)).toBeCloseTo(0, 6);
  });

  it("the label is drawn OVER the device face, so the name stays legible on the ghost", () => {
    const { container } = mount(open());
    const kids = [...box(container).children].map((c) => c.getAttribute("data-testid"));
    expect(kids.indexOf("pull-face")).toBeLessThan(kids.indexOf("pull-label"));
  });

  it("the label sits between the chip's inset and the device's centre at every point in the open", () => {
    // The name rides `reveal`, which is position-driven and monotonic — it climbs from the chip's
    // left inset to the device's centre and never past it, whatever fraction open the box is.
    for (let x = 100; x <= RACK_CENTRE; x += 10) {
      const { container, unmount } = mount(pull({ x, y: 100 }));
      const label = container.querySelector('[data-testid="pull-label"]') as HTMLElement;
      const w = parseFloat(box(container).style.width);
      const left = parseFloat(label.style.left);
      expect(left).toBeGreaterThanOrEqual(LABEL_INSET - 0.001);
      expect(left).toBeLessThanOrEqual(w / 2 + 0.001);
      unmount();
    }
  });

  it("once open it IS the rack device, selected — blue ears, no ports", () => {
    // snapStart 0 against a live performance.now() puts the spring well past its ring-out.
    const { container } = mount(open());
    const ears = [...container.querySelectorAll('[data-testid="face-ear"]')];
    expect(ears).toHaveLength(2);
    expect(ears.every((e) => e.getAttribute("fill") === RK_SELECT)).toBe(true);  // arrives SELECTED
    expect(container.querySelectorAll('[data-testid="port-cell"]')).toHaveLength(0);
  });

  it("settles at exactly one RU", () => {
    const { container } = mount(open());
    expect(box(container).style.width).toBe(`${RACK_INTERIOR_W}px`);
    expect(box(container).style.height).toBe(`${RU_PX}px`);
  });

  it("the ear curtains stay within [0, full] and shrink monotonically across the open", () => {
    let prev = Infinity;
    for (let x = 100; x <= RACK_CENTRE; x += 10) {
      const { container, unmount } = mount(pull({ x, y: 100 }));
      const w = parseFloat((container.querySelector('[data-testid="pull-ear-curtain-l"]') as HTMLElement).style.width);
      expect(w).toBeGreaterThanOrEqual(-1e-9);
      expect(w).toBeLessThanOrEqual(prev + 1e-9);   // never grows back — no wobble
      prev = w;
      unmount();
    }
    expect(prev).toBeCloseTo(0, 6);                  // fully retracted at the centre
  });

  it("flexes on the X/Y axes and NEVER rotates — the chip stays upright", () => {
    // Rotating it into its direction of travel sent it spinning around as you dragged. It must read
    // as the same device chip the whole way, just with a slightly elastic outline.
    // At the pickup origin (cursor at chip.x=100, far from RACK_CENTRE) the box is a full chip, so
    // the flex is at full strength — it fades out only as the device opens.
    const { container } = mount(pull({ x: 100, y: 100, flex: { stretch: FLEX_MAX, v: 0 } }));
    const { sx, sy } = flexScale(FLEX_MAX);
    const t = box(container).style.transform;
    expect(t).toContain(`scale(${sx}, ${sy})`);
    expect(t).not.toContain("rotate");
  });

  it("is an undeformed chip at rest", () => {
    const t = box(mount(pull({ x: 100, y: 100 })).container).style.transform;
    expect(t).toContain("scale(1, 1)");
    expect(t).not.toContain("rotate");
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
