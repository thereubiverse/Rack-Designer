import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RackCanvas } from "./RackCanvas";
import { emptyFace } from "@/domain/faceplate";
import { RU_PX } from "@/domain/faceplate-geometry";

const tpl = { rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: emptyFace(), backFace: emptyFace() };
const placements = [{ id: "d1", startU: 2, template: tpl }];
const base = { heightU: 4, placements, side: "FRONT" as const, onSelect: vi.fn(), onAddAt: vi.fn(), onMove: vi.fn(), onDelete: vi.fn() };

describe("RackCanvas", () => {
  it("clicking a free RU strip fires onAddAt with that U", () => {
    const onAddAt = vi.fn();
    render(<RackCanvas {...base} selectedId={null} onAddAt={onAddAt} />);
    fireEvent.click(screen.getByTestId("ru-hit-4"));
    expect(onAddAt).toHaveBeenCalledWith(4);
  });
  it("clicking a device selects it; grip drag fires onMove with the RU target", () => {
    const onSelect = vi.fn(), onMove = vi.fn();
    const { rerender } = render(<RackCanvas {...base} selectedId={null} onSelect={onSelect} onMove={onMove} />);
    fireEvent.click(screen.getByTestId("rack-dev-d1"));
    expect(onSelect).toHaveBeenCalledWith("d1");
    rerender(<RackCanvas {...base} selectedId="d1" onSelect={onSelect} onMove={onMove} />);
    const grip = screen.getByTestId("rack-grip-d1");
    fireEvent.pointerDown(grip, { clientX: 0, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 100 - RU_PX }); // up one RU → U3
    fireEvent.pointerUp(window, { clientX: 0, clientY: 100 - RU_PX });
    expect(onMove.mock.calls.at(-1)).toEqual(["d1", 3]);
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
  it("applies the zoom multiplier on top of the fit scale (fit scale is 1 in jsdom)", () => {
    render(<RackCanvas {...base} selectedId={null} zoom={2} />);
    const scaleContainer = screen.getByTestId("rack-canvas-scale");
    expect(scaleContainer.style.transform).toContain("scale(2)");
  });
});
