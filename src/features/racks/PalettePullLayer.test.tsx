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

  it("the blue outline is its own element, drawn LAST and on top, spanning the whole box", () => {
    // It overlaps the ears rather than being the box's own CSS border (which would push content in).
    const { container } = mount(open());
    const b = box(container);
    expect(b.style.borderWidth).toBe("");                    // the box itself has NO border...
    const kids = [...b.children].map((c) => c.getAttribute("data-testid"));
    expect(kids.indexOf("pull-outline")).toBe(kids.length - 1);   // ...the outline is the last child
    const outline = container.querySelector('[data-testid="pull-outline"]') as HTMLElement;
    expect(outline.className).toContain("inset-0");          // spans the whole box
    expect(outline.style.borderRadius).toBe(b.style.borderRadius);  // and shares the box's radius
  });

  it("it is centred on the cursor, not hung off its corner", () => {
    const { container } = mount(pull({ x: 300, y: 200 }));
    const t = box(container).style.transform;
    expect(t).toContain("translate(300px, 200px)");
    expect(t).toContain("translate(-50%, -50%)");   // after the rotate/scale, so both act about the middle
  });

  it("at pickup it is a plain chip — label left-aligned, no ears, no screw holes, no seams", () => {
    const { container } = mount(pull({ x: 100, y: 200 }));   // cursor at the pickup origin (chip.x)
    const label = container.querySelector('[data-testid="pull-label"]') as HTMLElement;
    expect(label.textContent).toBe("Switch");
    expect(label.style.left).toBe(`${LABEL_INSET}px`);          // exactly where the chip's px-3 puts it
    expect(label.style.transform).toBe("translate(0%, -50%)");   // anchored by its left edge
    // both ears are zero-width -> a plain white box. And no device face at all, so none of the
    // stray blue seam lines / grey screw holes that used to show on the chip.
    expect(parseFloat((container.querySelector('[data-testid="pull-ear-l"]') as HTMLElement).style.width)).toBe(0);
    expect(parseFloat((container.querySelector('[data-testid="pull-ear-r"]') as HTMLElement).style.width)).toBe(0);
    expect(container.querySelector('[data-testid="screw-hole"]')).toBeNull();
    expect(container.querySelector("svg")).toBeNull();           // the ghost draws no SVG face
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

  it("the ears EXTEND INWARD from the outline as it opens — blue bars growing to full width", () => {
    // Not faded in — they grow from the blue edge inward. Part-open they are partway; fully open,
    // full width, and always the selection blue.
    const partOpen = mount(pull({ x: (100 + RACK_CENTRE) / 2, y: 100 }));  // halfway
    const pl = partOpen.container.querySelector('[data-testid="pull-ear-l"]') as HTMLElement;
    const partW = parseFloat(pl.style.width);
    expect(partW).toBeGreaterThan(0);
    expect(pl.style.left).toBe("0px");                             // anchored at the outline
    expect(pl.style.background).toBe(rgbOf(RK_SELECT));            // blue

    const full = mount(open());
    const fl = full.container.querySelector('[data-testid="pull-ear-l"]') as HTMLElement;
    const fr = full.container.querySelector('[data-testid="pull-ear-r"]') as HTMLElement;
    expect(parseFloat(fl.style.width)).toBeGreaterThan(partW);     // wider when fully open
    expect(parseFloat(fr.style.width)).toEqual(parseFloat(fl.style.width));
  });

  it("the label is drawn OVER the ears, so the name stays legible on the ghost", () => {
    const { container } = mount(open());
    const kids = [...box(container).children].map((c) => c.getAttribute("data-testid"));
    expect(kids.indexOf("pull-ear-l")).toBeLessThan(kids.indexOf("pull-label"));
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

  it("once open it shows two full blue ears and no ports/holes — selected, and clean", () => {
    const { container } = mount(open());
    const ears = [container.querySelector('[data-testid="pull-ear-l"]'), container.querySelector('[data-testid="pull-ear-r"]')];
    expect(ears.every((e) => e && (e as HTMLElement).style.background === rgbOf(RK_SELECT))).toBe(true);
    expect(parseFloat((ears[0] as HTMLElement).style.width)).toBeGreaterThan(0);
    expect(container.querySelector('[data-testid="port-cell"]')).toBeNull();
    expect(container.querySelector('[data-testid="screw-hole"]')).toBeNull();     // no holes while carrying
  });

  it("settles at exactly one RU", () => {
    const { container } = mount(open());
    expect(box(container).style.width).toBe(`${RACK_INTERIOR_W}px`);
    expect(box(container).style.height).toBe(`${RU_PX}px`);
  });

  it("the ears grow monotonically from 0 across the open — no wobble", () => {
    let prev = -Infinity;
    for (let x = 100; x <= RACK_CENTRE; x += 10) {
      const { container, unmount } = mount(pull({ x, y: 100 }));
      const w = parseFloat((container.querySelector('[data-testid="pull-ear-l"]') as HTMLElement).style.width);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-9);   // never shrinks back
      prev = w;
      unmount();
    }
    expect(prev).toBeGreaterThan(0);                   // ears present at the centre
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
