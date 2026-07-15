import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { RackCanvas, type RackCanvasHandle } from "./RackCanvas";
import { ruTopY, RACK_GUTTER_L, RK_SELECT, RK_PLUS, RK_GHOST } from "./RackFrame";
import { EAR_GREY, CORNER_R } from "@/features/device-library/faceplate/Faceplate";
import { emptyFace } from "@/domain/faceplate";
import { RU_PX } from "@/domain/faceplate-geometry";
import type { PortRef } from "./connectionOps";

const scaleOf = (el: HTMLElement) => parseFloat(el.style.transform.match(/scale\(([-0-9.]+)\)/)![1]);

const tpl = { rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: emptyFace(), backFace: emptyFace() };
const placements = [{ id: "d1", startU: 2, template: tpl }];
const base = {
  heightU: 4, placements, side: "FRONT" as const, onSelect: vi.fn(), onAddAt: vi.fn(), onMove: vi.fn(), onDelete: vi.fn(),
  connections: [], selectedConnectionId: null, onPatch: vi.fn(), onSelectConnection: vi.fn(),
  onDisconnect: vi.fn(), onReplace: vi.fn(), portLabel: (p: PortRef) => `${p.rackDeviceId}/${p.portIndex + 1}`,
};

describe("RackCanvas", () => {
  it("clicking a free RU strip fires onAddAt with that U", () => {
    const onAddAt = vi.fn();
    render(<RackCanvas {...base} selectedId={null} onAddAt={onAddAt} />);
    fireEvent.click(screen.getByTestId("ru-hit-4"));
    expect(onAddAt).toHaveBeenCalledWith(4);
  });
  const rgbOf = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`; // the DOM normalises hexes
  };

  it("the ears, grip and box of a selected device are all the SAME blue", () => {
    const { rerender, container } = render(<RackCanvas {...base} selectedId={null} />);
    const earFills = () => [...container.querySelectorAll('[data-testid="face-ear"]')]
      .map((e) => e.getAttribute("fill"));
    // unselected: unpainted grey, no grip, no box
    expect(earFills().length).toBeGreaterThan(0);
    expect(earFills().every((f) => f === EAR_GREY)).toBe(true);
    expect(container.querySelector('[data-testid="rack-grip-d1"]')).toBeNull();
    expect(container.querySelector('[data-testid="rack-select-box-d1"]')).toBeNull();

    rerender(<RackCanvas {...base} selectedId="d1" />);
    // The point of the test: all three must be the SAME value, not blues that merely look close.
    // Tailwind v4 resolves blue-600 to rgb(21,93,252) — NOT v3's #2563eb/rgb(37,99,235) — and
    // blue-500 to rgb(43,127,255), NOT #3b82f6/rgb(59,130,246). Sourcing any one of these from a
    // class instead of RK_SELECT is exactly how they drifted apart before.
    const grip = container.querySelector('[data-testid="rack-grip-d1"]') as HTMLElement;
    const box = container.querySelector('[data-testid="rack-select-box-d1"]') as HTMLElement;
    expect(grip).toBeTruthy();
    expect(box).toBeTruthy();
    expect(earFills().every((f) => f === RK_SELECT)).toBe(true);
    expect(grip.style.backgroundColor).toBe(rgbOf(RK_SELECT));
    expect(box.style.borderColor).toBe(rgbOf(RK_SELECT));
  });

  it("the selection box sits ON the device outline, not floating outside it", () => {
    const { container } = render(<RackCanvas {...base} selectedId="d1" />);
    const box = container.querySelector('[data-testid="rack-select-box-d1"]') as HTMLElement;
    // Spans the exact device footprint. A negative inset would float the box off the outline,
    // and would also need a grown radius to still hug the curve (offsetting a rounded rect
    // outward grows its radius by the offset) — the two used to drift apart independently.
    expect(box.className).toContain("inset-0");
    expect(box.style.borderRadius).toBe(`${CORNER_R}px`);
  });

  it("the rack's three blues stay distinct from each other", () => {
    // Each answers to a different job: an idle ⊕ on every empty RU, a mid-drag ghost, and the
    // selected/hovered chrome. Collapsing any pair to one value loses a distinction the UI makes.
    expect(new Set([RK_PLUS, RK_GHOST, RK_SELECT]).size).toBe(3);
  });

  it("the grip sits inside the right ear rather than poking out past the device edge", () => {
    render(<RackCanvas {...base} selectedId="d1" />);
    const grip = screen.getByTestId("rack-grip-d1");
    // Ear is 36px wide, grip 16px → centred at 10px in, so its outer edge stops 10px short of
    // the device's right edge. A negative offset (the old `-right-1`) would hang it outside.
    const right = parseFloat(grip.style.right as string);
    expect(right).toBe((36 - 16) / 2);
    expect(right).toBeGreaterThan(0);
  });

  it("the code tag flips to white when its ear turns blue underneath it", () => {
    const withCode = [{ ...placements[0], code: "SW01" }];
    const { rerender, container } = render(<RackCanvas {...base} placements={withCode} selectedId={null} />);
    const code = () => container.querySelector('[data-testid="rack-code-d1"]')!;
    expect(code().getAttribute("fill")).toBe("#6b7280");
    rerender(<RackCanvas {...base} placements={withCode} selectedId="d1" />);
    expect(code().getAttribute("fill")).toBe("#ffffff");
  });

  it("hovering a free RU lights that RU's rails the dark selection blue, only while hovered", () => {
    const { container } = render(<RackCanvas {...base} selectedId={null} />);
    const rails = () => container.querySelectorAll('[data-testid="rail-hover"] rect');
    expect(rails()).toHaveLength(0);

    fireEvent.mouseEnter(screen.getByTestId("ru-hit-4"));
    expect(rails()).toHaveLength(2); // both left and right rail
    // RK_SELECT, not the pale hint blue — the lit rail marks where a device's ears would land.
    expect([...rails()].every((r) => r.getAttribute("fill") === RK_SELECT)).toBe(true);
    expect([...rails()].every((r) => r.getAttribute("y") === String(ruTopY(4, 1, 4)))).toBe(true);

    fireEvent.mouseLeave(screen.getByTestId("ru-hit-4"));
    expect(rails()).toHaveLength(0);
  });

  it("hovering a free RU darkens only that RU's ⊕, leaving the rest pale", () => {
    const { container } = render(<RackCanvas {...base} selectedId={null} />);
    const plusFill = (u: number) =>
      container.querySelector(`[data-testid="rack-slot"][data-u="${u}"]`)!.getAttribute("stroke");
    // free RUs are 1, 3, 4 here (d1 occupies U2) — all pale to start
    expect([1, 3, 4].every((u) => plusFill(u) === RK_PLUS)).toBe(true);

    fireEvent.mouseEnter(screen.getByTestId("ru-hit-4"));
    expect(plusFill(4)).toBe(RK_SELECT);              // the hovered one
    expect([1, 3].every((u) => plusFill(u) === RK_PLUS)).toBe(true); // and only it

    fireEvent.mouseLeave(screen.getByTestId("ru-hit-4"));
    expect(plusFill(4)).toBe(RK_PLUS);
  });

  it("no RU strip paints a background — the ⊕ and rails carry the hover, not a wash", () => {
    render(<RackCanvas {...base} selectedId={null} />);
    for (const u of [1, 3, 4]) {
      expect(screen.getByTestId(`ru-hit-${u}`).className).not.toMatch(/bg-/);
    }
  });

  it("press-dragging an UNSELECTED device's ear selects it and moves it in one gesture", () => {
    const onSelect = vi.fn(), onMove = vi.fn();
    // stays selectedId={null} throughout: the drag must not depend on being selected first
    render(<RackCanvas {...base} selectedId={null} onSelect={onSelect} onMove={onMove} />);
    const ear = screen.getByTestId("rack-dev-ear-l-d1");
    fireEvent.pointerDown(ear, { clientX: 0, clientY: 100, button: 0 });
    expect(onSelect).toHaveBeenCalledWith("d1"); // selected on PRESS, not on release
    fireEvent.pointerMove(window, { clientX: 0, clientY: 100 - RU_PX }); // up one RU → U3
    fireEvent.pointerUp(window, { clientX: 0, clientY: 100 - RU_PX });
    expect(onMove.mock.calls.at(-1)).toEqual(["d1", 3]);
  });

  it("pressing an ear without moving selects but commits no move", () => {
    const onSelect = vi.fn(), onMove = vi.fn();
    render(<RackCanvas {...base} selectedId={null} onSelect={onSelect} onMove={onMove} />);
    const ear = screen.getByTestId("rack-dev-ear-l-d1");
    fireEvent.pointerDown(ear, { clientX: 0, clientY: 100, button: 0 });
    fireEvent.pointerUp(window, { clientX: 0, clientY: 100 });
    expect(onSelect).toHaveBeenCalledWith("d1");
    // it may report the origin RU, but must never report a DIFFERENT one from a still pointer
    for (const call of onMove.mock.calls) expect(call).toEqual(["d1", 2]);
  });

  it("a right-click on an ear arms no drag", () => {
    render(<RackCanvas {...base} selectedId={null} />);
    fireEvent.pointerDown(screen.getByTestId("rack-dev-ear-l-d1"), { clientX: 0, clientY: 100, button: 2 });
    expect(screen.queryByTestId("rack-ghost")).toBeNull();
  });

  it("only the ears select a device (not the body); grip drag fires onMove with the RU target", () => {
    const onSelect = vi.fn(), onMove = vi.fn();
    const { rerender } = render(<RackCanvas {...base} selectedId={null} onSelect={onSelect} onMove={onMove} />);
    // Clicking the body container does not select — only the ear hit-strips do.
    fireEvent.click(screen.getByTestId("rack-dev-d1"));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("rack-dev-ear-l-d1"));
    expect(onSelect).toHaveBeenCalledWith("d1");
    rerender(<RackCanvas {...base} selectedId="d1" onSelect={onSelect} onMove={onMove} />);
    const grip = screen.getByTestId("rack-grip-d1");
    fireEvent.pointerDown(grip, { clientX: 0, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 100 - RU_PX }); // up one RU → U3
    fireEvent.pointerUp(window, { clientX: 0, clientY: 100 - RU_PX });
    expect(onMove.mock.calls.at(-1)).toEqual(["d1", 3]);
  });
  it("releasing a sub-RU drag snaps the faceplate back (not frozen at the loose pointer position)", () => {
    // Regression: while dragging, the faceplate transform is written imperatively per frame. On a
    // small drag that lands on the SAME RU, startU is unchanged so React never re-renders the
    // device — the release must reset the faceplate to its snapped RU, or it stays stuck mid-slot.
    render(<RackCanvas {...base} selectedId="d1" />);
    const grip = screen.getByTestId("rack-grip-d1");
    fireEvent.pointerDown(grip, { clientX: 0, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 120 }); // 20px < ½RU → still U2
    fireEvent.pointerUp(window, { clientX: 0, clientY: 120 });
    const face = screen.getByTestId("rack-device-d1");
    expect(face.getAttribute("transform")).toBe(`translate(${RACK_GUTTER_L}, ${ruTopY(2, 1, 4)})`);
  });
  it("Delete key removes the selection (not while typing in an input)", () => {
    const onDelete = vi.fn();
    render(<RackCanvas {...base} selectedId="d1" onDelete={onDelete} />);
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(onDelete).toHaveBeenCalledWith("d1");
  });
  it("occupied RUs have no hit strip", () => {
    render(<RackCanvas {...base} selectedId={null} />);
    expect(screen.queryByTestId("ru-hit-2")).toBeNull();
    expect(screen.getByTestId("ru-hit-1")).toBeInTheDocument();
  });
  it("zoomBy() scales the content and clamps to the absolute 0.05–3 range (same at any fit)", () => {
    const ref = createRef<RackCanvasHandle>();
    render(<RackCanvas ref={ref} {...base} selectedId={null} />);
    const content = screen.getByTestId("rack-canvas-scale");
    expect(scaleOf(content)).toBe(1);
    act(() => ref.current!.zoomBy(2));
    expect(scaleOf(content)).toBe(2);
    act(() => ref.current!.zoomBy(100));   // clamps up to MAX_SCALE
    expect(scaleOf(content)).toBe(3);
    act(() => ref.current!.zoomBy(0.0001)); // clamps down to MIN_SCALE
    expect(scaleOf(content)).toBe(0.05);
  });

  it("pinch (ctrl+wheel) zooms about the cursor and clamps to the max", () => {
    const { container } = render(<RackCanvas {...base} selectedId={null} />);
    const host = container.firstElementChild as HTMLElement;
    const content = screen.getByTestId("rack-canvas-scale");
    fireEvent.wheel(host, { ctrlKey: true, deltaY: -100 }); // pinch out → zoom in
    expect(scaleOf(content)).toBeGreaterThan(1);
    fireEvent.wheel(host, { ctrlKey: true, deltaY: -500 }); // huge pinch → clamp
    expect(scaleOf(content)).toBe(3);
  });

  it("plain two-finger scroll pans (translate changes) without zooming", () => {
    render(<RackCanvas {...base} selectedId={null} />);
    const content = screen.getByTestId("rack-canvas-scale");
    const host = content.parentElement as HTMLElement;
    const before = content.style.transform;
    fireEvent.wheel(host, { deltaX: 30, deltaY: 60 }); // no ctrlKey → pan
    expect(scaleOf(content)).toBe(1);                  // scale unchanged (not a zoom)
    expect(content.style.transform).not.toBe(before);  // translate moved
  });

  it("animates fit/zoom via a transform transition on the content", () => {
    render(<RackCanvas {...base} selectedId={null} />);
    const content = screen.getByTestId("rack-canvas-scale");
    expect(content.style.transition).toContain("transform");
    expect(content.style.transform).toContain("translate"); // translate+scale (pannable)
  });
});
