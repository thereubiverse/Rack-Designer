import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import { EditorCanvas, toDevicePos } from "./EditorCanvas";
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
    expect(onSelect).toHaveBeenCalledWith("g1", false);
  });

  it("clicking empty overlay space (no drag) deselects", () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" onSelect={onSelect} />,
    );
    fireEvent.pointerDown(getByTestId("editor-overlay"), { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 50 }); // no movement → deselect
    expect(onSelect).toHaveBeenCalledWith(null, false);
  });

  it("dragging a marquee on blank space selects the groups it touches", () => {
    const onMarqueeSelect = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        onSelect={() => {}} onMarqueeSelect={onMarqueeSelect} />,
    );
    // drag a box across the whole overlay → should include g1
    fireEvent.pointerDown(getByTestId("editor-overlay"), { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(window, { clientX: 900, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 900, clientY: 200 });
    expect(onMarqueeSelect).toHaveBeenCalled();
    expect(onMarqueeSelect.mock.calls[0][0]).toContain("g1");
  });

  // jsdom has no layout, so mock the group box's on-screen rect. The box is the PADDED
  // selection box (SEL_PAD=6 all round, LABEL_H=12 strips top+bottom); the visible port
  // glyphs sit inset from it. left/right glyph edges = box ± 6; top/bottom = box ± 18.
  function mockGroupRect(el: HTMLElement, r: { left: number; top: number; right: number; bottom: number }) {
    el.getBoundingClientRect = () => ({
      left: r.left, top: r.top, right: r.right, bottom: r.bottom,
      width: r.right - r.left, height: r.bottom - r.top, x: r.left, y: r.top, toJSON() {},
    }) as DOMRect;
  }

  it("marquee does NOT select a group while it only overlaps the box padding (not the glyphs)", () => {
    const onMarqueeSelect = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        onSelect={() => {}} onMarqueeSelect={onMarqueeSelect} />,
    );
    // padded box 100..136 × 100..160 → visible glyphs 106..130 × 118..142.
    mockGroupRect(getByTestId("group-box-g1"), { left: 100, top: 100, right: 136, bottom: 160 });
    fireEvent.pointerDown(getByTestId("editor-overlay"), { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerMove(window, { clientX: 104, clientY: 130 }); // reaches into the pad (100–106), short of glyph (106)
    const lastIds = onMarqueeSelect.mock.calls.at(-1)?.[0] ?? [];
    expect(lastIds).not.toContain("g1");
  });

  it("marquee selects a group once it overlaps the glyphs", () => {
    const onMarqueeSelect = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        onSelect={() => {}} onMarqueeSelect={onMarqueeSelect} />,
    );
    mockGroupRect(getByTestId("group-box-g1"), { left: 100, top: 100, right: 136, bottom: 160 });
    fireEvent.pointerDown(getByTestId("editor-overlay"), { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerMove(window, { clientX: 110, clientY: 130 }); // past glyph left edge (106)
    const lastIds = onMarqueeSelect.mock.calls.at(-1)?.[0] ?? [];
    expect(lastIds).toContain("g1");
  });

  it("a marquee drag's trailing click does not bubble (parent can't clear the fresh selection)", () => {
    const parentClick = vi.fn();
    const { getByTestId } = render(
      <div onClick={parentClick}>
        <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
          onSelect={() => {}} onMarqueeSelect={() => {}} />
      </div>,
    );
    fireEvent.pointerDown(getByTestId("editor-overlay"), { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(window, { clientX: 900, clientY: 200 }); // real drag
    fireEvent.pointerUp(window, { clientX: 900, clientY: 200 });
    fireEvent.click(getByTestId("editor-overlay"), { clientX: 900, clientY: 200 });
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("a plain click (no drag) still bubbles so the parent can deselect", () => {
    const parentClick = vi.fn();
    const { getByTestId } = render(
      <div onClick={parentClick}>
        <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
          onSelect={() => {}} onMarqueeSelect={() => {}} />
      </div>,
    );
    fireEvent.pointerDown(getByTestId("editor-overlay"), { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 50 }); // no movement
    fireEvent.click(getByTestId("editor-overlay"), { clientX: 50, clientY: 50 });
    expect(parentClick).toHaveBeenCalled();
  });

  it("a blank click still deselects even after a marquee that released over a group glyph", () => {
    const parentClick = vi.fn();
    const { getByTestId } = render(
      <div onClick={parentClick}>
        <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
          onSelect={() => {}} onMarqueeSelect={() => {}} />
      </div>,
    );
    // Marquee drag whose trailing click lands on the GROUP box (not the overlay), so the
    // overlay's onClick never runs to reset the "just dragged" flag.
    fireEvent.pointerDown(getByTestId("editor-overlay"), { clientX: 0, clientY: 0, button: 0 });
    fireEvent.pointerMove(window, { clientX: 900, clientY: 200 });
    fireEvent.pointerUp(window, { clientX: 900, clientY: 200 });
    fireEvent.click(getByTestId("group-box-g1")); // click consumed by the group, flag left set
    parentClick.mockClear();
    // Now a plain blank click must still bubble so the parent can deselect.
    fireEvent.pointerDown(getByTestId("editor-overlay"), { clientX: 50, clientY: 50, button: 0 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 50 });
    fireEvent.click(getByTestId("editor-overlay"), { clientX: 50, clientY: 50 });
    expect(parentClick).toHaveBeenCalled();
  });

  it("marks the selected group's box", () => {
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" selectedGroupIds={["g1"]} onSelect={() => {}} />,
    );
    expect(getByTestId("group-box-g1").getAttribute("data-selected")).toBe("true");
  });

  it("shows chevrons on the selected group and fires add column/row", () => {
    const onAddColumn = vi.fn();
    const onAddRow = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onAddColumn={onAddColumn} onAddRow={onAddRow} />,
    );
    fireEvent.pointerDown(getByTestId("chevron-col"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    fireEvent.pointerDown(getByTestId("chevron-row"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
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

  it("shows a drop-preview box while a palette chip is dragged over empty space", () => {
    const { getByTestId, queryByTestId } = render(
      <EditorCanvas face={{ portGroups: [], elements: [] }} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        onSelect={() => {}} onCreate={() => {}} paletteDragMedia="copper" />,
    );
    expect(queryByTestId("drop-preview")).toBeNull();
    fireEvent.dragOver(getByTestId("editor-overlay"), { dataTransfer: { dropEffect: "" }, clientX: 100, clientY: 40 });
    expect(getByTestId("drop-preview")).toBeInTheDocument();
    fireEvent.dragLeave(getByTestId("editor-overlay"));
    expect(queryByTestId("drop-preview")).toBeNull();
  });
});

describe("EditorCanvas drag-to-move", () => {
  it("commits onMove with the dragged delta on pointer up", () => {
    const onMove = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onMove={onMove} />,
    );
    const box = getByTestId("group-box-g1");
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 108 });
    fireEvent.pointerUp(window, { clientX: 140, clientY: 108 });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, pos] = onMove.mock.calls[0];
    expect(id).toBe("g1");
    // group started at gridX 20; moved +40 horizontally. This is a 1U device, so vertical
    // is fixed → yOffset stays at the group's original offset (0).
    expect(pos).toEqual({ x: 60, yOffset: 0 });
  });

  it("on a 2RU device a vertical drag carries a yOffset delta", () => {
    const onMove = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={2} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onMove={onMove} />,
    );
    const box = getByTestId("group-box-g1");
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 100, clientY: 140 }); // straight down 40px
    fireEvent.pointerUp(window, { clientX: 100, clientY: 140 });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [, target] = onMove.mock.calls[0];
    expect(target.yOffset).toBe(40); // vertical delta carried (allowVertical on 2RU)
  });

  it("does not commit a move when the pointer did not move (plain click)", () => {
    const onMove = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onMove={onMove} />,
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
        selectedGroupIds={["g1"]} onSelect={() => {}} onSelectPort={onSelectPort} />,
    );
    fireEvent.click(getByTestId("port-target-1"));
    expect(onSelectPort).toHaveBeenCalledWith(1, false);
  });

});

describe("EditorCanvas highlight passthrough (3d)", () => {
  it("forwards highlight to Faceplate (selected port renders blue, no overlay copy)", () => {
    const { getAllByTestId, queryByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} selectedPortIndices={[1]} onSelect={() => {}} onSelectPort={() => {}}
        highlight={{ groupId: "g1", portIndex: 1 }} />,
    );
    expect(queryByTestId("port-highlight")).toBeNull(); // overlay copy gone
    const blued = getAllByTestId("port-cell").filter((c) => c.getAttribute("data-highlighted") === "true");
    expect(blued).toHaveLength(1);
  });
});

describe("EditorCanvas spacing handle", () => {
  it("drags to increase spacing, clamped to the max", () => {
    const onSpacing = vi.fn();
    // group: 3 cols at gridX 0 in a 19in rack-mounted frame (bodyWidthPx 912) → plenty of room
    const face: Face = { portGroups: [grp({ id: "g1", cols: 3, gridX: 0, gridY: 0 })], elements: [] };
    const { getByTestId } = render(
      <EditorCanvas face={face} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onSpacing={onSpacing} />,
    );
    const handle = getByTestId("spacing-handle");
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 130, clientY: 100 }); // handle follows cursor +30
    expect(onSpacing).toHaveBeenCalled();
    const last = onSpacing.mock.calls[onSpacing.mock.calls.length - 1][1];
    // cursor moved +30; the box widens by (cols-1)=2 per unit of spacing, so the
    // handle tracks the cursor when colSpacing = 30/2 = 15.
    expect(last.colSpacing).toBeCloseTo(15, 5);
    fireEvent.pointerUp(window, { clientX: 130, clientY: 100 });
  });

  it("does not spread a single-column group (maxCol 0)", () => {
    const onSpacing = vi.fn();
    const face: Face = { portGroups: [grp({ id: "g1", cols: 1, rows: 1, gridX: 0, gridY: 0 })], elements: [] };
    const { getByTestId } = render(
      <EditorCanvas face={face} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onSpacing={onSpacing} />,
    );
    fireEvent.pointerDown(getByTestId("spacing-handle"), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200 });
    const last = onSpacing.mock.calls[onSpacing.mock.calls.length - 1][1];
    expect(last.colSpacing).toBe(0);
    expect(last.rowSpacing).toBe(0);
    fireEvent.pointerUp(window, { clientX: 200, clientY: 200 });
  });
});

describe("EditorCanvas live move feedback", () => {
  it("shows a red-invalid marker when dragging a group onto another", () => {
    const twoGroups: Face = {
      portGroups: [grp({ id: "g1", gridX: 0, gridY: 0 }), grp({ id: "g2", cols: 1, gridX: 200, gridY: 0 })],
      elements: [],
    };
    const { getByTestId, queryByTestId } = render(
      <EditorCanvas face={twoGroups} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g2"]} onSelect={() => {}} onMove={() => {}} />,
    );
    const box = getByTestId("group-box-g2");
    // drag g2 (at gridX 200) left onto g1 (at gridX 0)
    fireEvent.pointerDown(box, { clientX: 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 5, clientY: 20 }); // now near gridX 5 → overlaps g1
    expect(queryByTestId("move-invalid")).not.toBeNull();
    fireEvent.pointerUp(window, { clientX: 5, clientY: 20 });
  });
});

describe("EditorCanvas chevron drag (3d)", () => {
  it("dragging the column chevron right adds one column per CELL_W", () => {
    const onAddColumn = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onAddColumn={onAddColumn} />,
    );
    const chev = getByTestId("chevron-col");
    fireEvent.pointerDown(chev, { clientX: 100, clientY: 50 });
    fireEvent.pointerMove(window, { clientX: 100 + 24 * 2 + 2, clientY: 50 }); // ~2 columns of drag
    fireEvent.pointerUp(window, { clientX: 100 + 24 * 2 + 2, clientY: 50 });
    expect(onAddColumn).toHaveBeenCalledTimes(2);
  });

  it("a plain click still adds one column", () => {
    const onAddColumn = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onAddColumn={onAddColumn} />,
    );
    fireEvent.pointerDown(getByTestId("chevron-col"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    expect(onAddColumn).toHaveBeenCalledTimes(1);
  });
});

describe("EditorCanvas port selection (recolor only, no box)", () => {
  it("never renders a per-port selection box — port selection is the blue recolor only", () => {
    const { queryByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} selectedPortIndices={[1]} onSelect={() => {}} onSelectPort={() => {}} />,
    );
    expect(queryByTestId("port-select-box")).toBeNull();
  });
});

describe("toDevicePos (3e scaling)", () => {
  it("at scale 1, subtracts the rect origin and ear offset", () => {
    expect(toDevicePos({ x: 150, y: 40 }, { left: 50, top: 10 }, 1, 20)).toEqual({ x: 80, y: 30 });
  });
  it("at scale 0.5, divides the in-rect offset by the scale before removing the ear", () => {
    // in-rect offset (100, 30) / 0.5 = (200, 60); x minus earX 20 = 180
    expect(toDevicePos({ x: 150, y: 40 }, { left: 50, top: 10 }, 0.5, 20)).toEqual({ x: 180, y: 60 });
  });
  it("treats scale 0 as 1 (guard)", () => {
    expect(toDevicePos({ x: 30, y: 10 }, { left: 0, top: 0 }, 0, 0)).toEqual({ x: 30, y: 10 });
  });
});

describe("EditorCanvas fit wrapper (3e)", () => {
  it("wraps the canvas in a fit container and still renders the faceplate + overlay", () => {
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" onSelect={() => {}} />,
    );
    const fit = getByTestId("editor-canvas-fit");
    expect(fit.querySelector('[data-testid="faceplate-svg"]')).not.toBeNull();
    expect(fit.querySelector('[data-testid="editor-overlay"]')).not.toBeNull();
  });
});

describe("EditorCanvas chevron drag to remove (3f)", () => {
  it("dragging the column chevron left removes one column per CELL_W, floored at 1", () => {
    const onRemoveColumn = vi.fn();
    // group g1 has cols:3 (grp default)
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onAddColumn={() => {}} onRemoveColumn={onRemoveColumn} />,
    );
    const chev = getByTestId("chevron-col");
    fireEvent.pointerDown(chev, { clientX: 100, clientY: 50 });
    // drag far left — 3-col group can remove at most 2 (floor of 1)
    fireEvent.pointerMove(window, { clientX: 100 - 24 * 5, clientY: 50 });
    fireEvent.pointerUp(window, { clientX: 100 - 24 * 5, clientY: 50 });
    expect(onRemoveColumn).toHaveBeenCalledTimes(2);
  });

  it("dragging the row chevron up removes rows down to 1", () => {
    const onRemoveRow = vi.fn();
    const twoRow: Face = { portGroups: [grp({ id: "g1", rows: 2, cols: 1 })], elements: [] };
    const { getByTestId } = render(
      <EditorCanvas face={twoRow} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupIds={["g1"]} onSelect={() => {}} onAddRow={() => {}} onRemoveRow={onRemoveRow} />,
    );
    const chev = getByTestId("chevron-row");
    fireEvent.pointerDown(chev, { clientX: 50, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 100 - 24 * 3 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 100 - 24 * 3 });
    expect(onRemoveRow).toHaveBeenCalledTimes(1); // 2 rows → floor at 1 → one removal
  });
});
