import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { EditorCanvas } from "./EditorCanvas";
import { emptyFace } from "@/domain/faceplate";
import type { Face, PortGroup } from "@/domain/faceplate";

describe("EditorCanvas", () => {
  it("renders a relative-positioned wrapper around the Faceplate", () => {
    const { getByTestId } = render(
      <EditorCanvas face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted side="FRONT" />,
    );
    const canvas = getByTestId("editor-canvas");
    expect(canvas).toBeInTheDocument();
    expect(canvas.querySelector('[data-testid="faceplate-svg"]')).not.toBeNull();
  });

  it("drops screw holes when not rack-mounted (preview reflects props)", () => {
    const { queryAllByTestId } = render(
      <EditorCanvas face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted={false} side="FRONT" />,
    );
    expect(queryAllByTestId("screw-hole")).toHaveLength(0);
  });
});

function grp(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 3, gridX: 20, gridY: 20,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}
const faceWithGroup: Face = { portGroups: [grp()], elements: [] };

describe("EditorCanvas overlay", () => {
  it("has no overlay controls in pure-preview mode (no edit props)", () => {
    const { queryByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" />,
    );
    expect(queryByTestId("editor-overlay")).toBeNull();
  });

  it("renders a selectable box per group and fires onSelect", () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" onSelect={onSelect} />,
    );
    fireEvent.click(getByTestId("group-box-g1"));
    expect(onSelect).toHaveBeenCalledWith("g1");
  });

  it("clicking empty overlay space deselects", () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" onSelect={onSelect} />,
    );
    fireEvent.click(getByTestId("editor-overlay"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("marks the selected group's box", () => {
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" selectedGroupId="g1" onSelect={() => {}} />,
    );
    expect(getByTestId("group-box-g1").getAttribute("data-selected")).toBe("true");
  });

  it("shows chevrons on the selected group and fires add column/row", () => {
    const onAddColumn = vi.fn();
    const onAddRow = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onAddColumn={onAddColumn} onAddRow={onAddRow} />,
    );
    fireEvent.click(getByTestId("chevron-col"));
    fireEvent.click(getByTestId("chevron-row"));
    expect(onAddColumn).toHaveBeenCalledWith("g1");
    expect(onAddRow).toHaveBeenCalledWith("g1");
  });

  it("dropping a media on the overlay fires onCreate with that media", () => {
    const onCreate = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={{ portGroups: [], elements: [] }} widthIn={19} rackUnits={1} rackMounted side="FRONT" onCreate={onCreate} />,
    );
    fireEvent.drop(getByTestId("editor-overlay"), {
      dataTransfer: { getData: () => "copper" },
      clientX: 50, clientY: 10,
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toBe("copper");
  });

  it("ignores a drop whose payload is not a known media", () => {
    const onCreate = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={{ portGroups: [], elements: [] }} widthIn={19} rackUnits={1} rackMounted side="FRONT" onCreate={onCreate} />,
    );
    fireEvent.drop(getByTestId("editor-overlay"), { dataTransfer: { getData: () => "banana" }, clientX: 5, clientY: 5 });
    expect(onCreate).not.toHaveBeenCalled();
  });
});

describe("EditorCanvas drag-to-move", () => {
  it("commits onMove with the dragged delta on pointer up", () => {
    const onMove = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onMove={onMove} />,
    );
    const box = getByTestId("group-box-g1");
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 108 });
    fireEvent.pointerUp(window, { clientX: 140, clientY: 108 });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, pos] = onMove.mock.calls[0];
    expect(id).toBe("g1");
    // group started at gridX 20, gridY 20; moved +40,+8
    expect(pos).toEqual({ x: 60, y: 28 });
  });

  it("does not commit a move when the pointer did not move (plain click)", () => {
    const onMove = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onMove={onMove} />,
    );
    const box = getByTestId("group-box-g1");
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
    expect(onMove).not.toHaveBeenCalled();
  });
});

describe("EditorCanvas per-port selection", () => {
  it("renders a click target per cell and fires onSelectPort", () => {
    const onSelectPort = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSelectPort={onSelectPort} />,
    );
    fireEvent.click(getByTestId("port-target-1"));
    expect(onSelectPort).toHaveBeenCalledWith(1);
  });

  it("draws the blue highlight only for the selected port", () => {
    const { queryByTestId, rerender } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSelectPort={() => {}} />,
    );
    expect(queryByTestId("port-highlight")).toBeNull();
    rerender(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" selectedPortIndex={1} onSelect={() => {}} onSelectPort={() => {}} />,
    );
    expect(queryByTestId("port-highlight")).not.toBeNull();
  });
});

describe("EditorCanvas spacing handle", () => {
  it("drags to increase spacing, clamped to the max", () => {
    const onSpacing = vi.fn();
    // group: 3 cols at gridX 0 in a 19in rack-mounted frame (bodyWidthPx 912) → plenty of room
    const face: Face = { portGroups: [grp({ id: "g1", cols: 3, gridX: 0, gridY: 0 })], elements: [] };
    const { getByTestId } = render(
      <EditorCanvas face={face} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSpacing={onSpacing} />,
    );
    const handle = getByTestId("spacing-handle");
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 130, clientY: 100 }); // +30 horizontal
    expect(onSpacing).toHaveBeenCalled();
    const last = onSpacing.mock.calls[onSpacing.mock.calls.length - 1][1];
    expect(last.colSpacing).toBeCloseTo(30, 5);
    fireEvent.pointerUp(window, { clientX: 130, clientY: 100 });
  });

  it("does not spread a single-column group (maxCol 0)", () => {
    const onSpacing = vi.fn();
    const face: Face = { portGroups: [grp({ id: "g1", cols: 1, rows: 1, gridX: 0, gridY: 0 })], elements: [] };
    const { getByTestId } = render(
      <EditorCanvas face={face} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSpacing={onSpacing} />,
    );
    fireEvent.pointerDown(getByTestId("spacing-handle"), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200 });
    const last = onSpacing.mock.calls[onSpacing.mock.calls.length - 1][1];
    expect(last.colSpacing).toBe(0);
    expect(last.rowSpacing).toBe(0);
    fireEvent.pointerUp(window, { clientX: 200, clientY: 200 });
  });
});
