import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { RackCanvas, type RackCanvasHandle } from "./RackCanvas";
import { ruTopY, RACK_GUTTER_L, RK_SELECT } from "./RackFrame";
import { EAR_GREY } from "@/features/device-library/faceplate/Faceplate";
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
  it("a selected device paints its ears the SAME blue as its selection box", () => {
    const { rerender, container } = render(<RackCanvas {...base} selectedId={null} />);
    const earFills = () => [...container.querySelectorAll('[data-testid="face-ear"]')]
      .map((e) => e.getAttribute("fill"));
    // unselected: unpainted grey, no box
    expect(earFills().length).toBeGreaterThan(0);
    expect(earFills().every((f) => f === EAR_GREY)).toBe(true);
    expect(container.querySelector('[data-testid="rack-select-box-d1"]')).toBeNull();

    rerender(<RackCanvas {...base} selectedId="d1" />);
    // The point of the test: the two must be the SAME value, not two blues that merely look
    // close. (Tailwind v4's blue-500 resolves to rgb(43,127,255), NOT this hex's rgb(59,130,246).)
    const box = container.querySelector('[data-testid="rack-select-box-d1"]') as HTMLElement;
    expect(box).toBeTruthy();
    expect(earFills().every((f) => f === RK_SELECT)).toBe(true);
    // the DOM normalises the hex, so compare like for like
    const n = parseInt(RK_SELECT.slice(1), 16);
    expect(box.style.borderColor).toBe(`rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`);
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
