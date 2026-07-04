import { describe, it, expect } from "vitest";
import { groupBounds, wouldOverlap, findFreePosition, SNAP, type GridBounds, addPortGroup, movePortGroup, addColumn, addRow, updatePortGroup, deletePortGroup, setPortOverride, setSpacing, maxSpacing, wouldOverlapAt, removeColumn, removeRow } from "./portGroupOps";
import type { Face, PortGroup } from "@/domain/faceplate";

function group(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}
const bounds: GridBounds = { width: 400, height: 84 };

describe("groupBounds", () => {
  it("is the cell footprint at the group's gridX/gridY (1x1 = 24x24)", () => {
    expect(groupBounds(group({ gridX: 10, gridY: 5 }))).toEqual({ x: 10, y: 5, width: 24, height: 24 });
  });
  it("grows with cols/rows", () => {
    expect(groupBounds(group({ cols: 3, rows: 2 }))).toMatchObject({ width: 72, height: 48 });
  });
});

describe("wouldOverlap", () => {
  const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
  it("detects an overlapping candidate", () => {
    expect(wouldOverlap(face, group({ id: "b", gridX: 10, gridY: 0 }))).toBe(true);
  });
  it("clears a non-overlapping candidate", () => {
    expect(wouldOverlap(face, group({ id: "b", gridX: 40, gridY: 0 }))).toBe(false);
  });
  it("excludes the group itself by id", () => {
    expect(wouldOverlap(face, group({ id: "a", gridX: 0, gridY: 0 }), "a")).toBe(false);
  });
});

describe("findFreePosition", () => {
  it("snaps the desired x position to the 8px grid when free; y passes through unchanged", () => {
    const face: Face = { portGroups: [], elements: [] };
    expect(findFreePosition(face, group(), { x: 11, y: 3 }, bounds)).toEqual({ x: 8, y: 3 });
  });
  it("clamps x within the grid bounds; y passes through unchanged (horizontal-only)", () => {
    const face: Face = { portGroups: [], elements: [] };
    // desired far right; 1x1 (24 wide) must fit within width 400 → max x = 376
    expect(findFreePosition(face, group(), { x: 999, y: 999 }, bounds)).toEqual({ x: 376, y: 999 });
  });
  it("nudges to the nearest free spot when the target overlaps", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
    const free = findFreePosition(face, group({ id: "b" }), { x: 0, y: 0 }, bounds, "b");
    expect(free).not.toBeNull();
    expect(wouldOverlap(face, group({ id: "b", gridX: free!.x, gridY: free!.y }), "b")).toBe(false);
  });
  it("returns null when the grid is full", () => {
    // a single 1x1 cell grid fully occupied
    const tiny: GridBounds = { width: 24, height: 24 };
    const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
    expect(findFreePosition(face, group({ id: "b" }), { x: 0, y: 0 }, tiny, "b")).toBeNull();
  });
});

describe("SNAP", () => {
  it("is 8", () => { expect(SNAP).toBe(8); });
});

describe("addPortGroup", () => {
  it("appends a 1-port group with the media's default connector at the snapped position", () => {
    const face: Face = { portGroups: [], elements: [] };
    const next = addPortGroup(face, "sfp", { x: 33, y: 9 }, bounds);
    expect(next.portGroups).toHaveLength(1);
    const g = next.portGroups[0];
    // x is snapped to the 8px grid; y passes through unchanged (horizontal-only positioning)
    expect(g).toMatchObject({ media: "sfp", connectorType: "SFP", cols: 1, rows: 1, gridX: 32, gridY: 9 });
    expect(g.id).toBeTruthy();
  });
  it("nudges the new group off an existing one at the same spot", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const next = addPortGroup(face, "copper", { x: 0, y: 0 }, bounds);
    expect(next.portGroups).toHaveLength(2);
    expect(wouldOverlap({ portGroups: [next.portGroups[0]], elements: [] }, next.portGroups[1])).toBe(false);
  });
  it("cancels (no group added) when the grid is full", () => {
    const tiny: GridBounds = { width: 24, height: 24 };
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, tiny);
    const next = addPortGroup(face, "copper", { x: 0, y: 0 }, tiny);
    expect(next.portGroups).toHaveLength(1);
  });
});

describe("movePortGroup", () => {
  it("relocates the group's x to the snapped target and leaves gridY untouched (horizontal-only)", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    const gridYBefore = face.portGroups[0].gridY;
    // 104 is already on the 8px grid, so it passes through unchanged
    const next = movePortGroup(face, id, { x: 104, y: 32 }, bounds);
    expect(next.portGroups[0]).toMatchObject({ gridX: 104, gridY: gridYBefore });
  });
});

describe("addColumn / addRow", () => {
  it("adds a column / a row", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    expect(addColumn(face, id, bounds).portGroups[0].cols).toBe(2);
    expect(addRow(face, id, bounds).portGroups[0].rows).toBe(2);
  });
  it("is a no-op when growth would exceed the grid width", () => {
    const narrow: GridBounds = { width: 24, height: 84 };
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, narrow);
    const id = face.portGroups[0].id;
    expect(addColumn(face, id, narrow).portGroups[0].cols).toBe(1);
  });
  it("is a no-op when growth would overlap a neighbor", () => {
    let face: Face = { portGroups: [], elements: [] };
    face = addPortGroup(face, "copper", { x: 0, y: 0 }, bounds);      // at 0,0 (24 wide)
    const id = face.portGroups[0].id;
    face = addPortGroup(face, "copper", { x: 24, y: 0 }, bounds);     // immediately to its right
    expect(addColumn(face, id, bounds).portGroups.find((g) => g.id === id)!.cols).toBe(1);
  });
});

describe("updatePortGroup / deletePortGroup", () => {
  it("patches only the allowed fields", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    const next = updatePortGroup(face, id, { idPrefix: "Gi", countingDirection: "rtl", connectorType: "Keystone" });
    expect(next.portGroups[0]).toMatchObject({ idPrefix: "Gi", countingDirection: "rtl", connectorType: "Keystone" });
  });
  it("deletes by id", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    expect(deletePortGroup(face, id).portGroups).toHaveLength(0);
  });
});

describe("setPortOverride", () => {
  it("creates an override for a port index", () => {
    const face: Face = { portGroups: [group({ id: "g", cols: 2 })], elements: [] };
    const next = setPortOverride(face, "g", 1, { name: "UPLINK", flipped: true });
    expect(next.portGroups[0].portOverrides[1]).toEqual({ name: "UPLINK", flipped: true });
    expect(face.portGroups[0].portOverrides[1]).toBeUndefined(); // immutable
  });
  it("merges into an existing override", () => {
    const face: Face = { portGroups: [group({ id: "g", portOverrides: { 0: { name: "A" } } })], elements: [] };
    const next = setPortOverride(face, "g", 0, { flipped: true });
    expect(next.portGroups[0].portOverrides[0]).toEqual({ name: "A", flipped: true });
  });
});

describe("setSpacing", () => {
  it("sets col and row spacing", () => {
    const face: Face = { portGroups: [group({ id: "g" })], elements: [] };
    expect(setSpacing(face, "g", { colSpacing: 8, rowSpacing: 4 }).portGroups[0]).toMatchObject({ colSpacing: 8, rowSpacing: 4 });
  });
});

describe("maxSpacing", () => {
  it("clamps to the grid edge", () => {
    // 3 cols * 24 = 72 tight; grid width 200, gridX 0 → maxCol = (200-0-72)/2 = 64
    const g = group({ id: "g", cols: 3, gridX: 0, gridY: 0 });
    const face: Face = { portGroups: [g], elements: [] };
    expect(maxSpacing(face, g, { width: 200, height: 84 }).maxCol).toBeCloseTo(64, 5);
  });
  it("clamps tighter to a neighbour on the right", () => {
    const g = group({ id: "g", cols: 3, gridX: 0, gridY: 0 });
    const nb = group({ id: "nb", cols: 1, gridX: 120, gridY: 0 }); // right neighbour, same row
    const face: Face = { portGroups: [g, nb], elements: [] };
    // maxCol = (120 - 0 - 72)/2 = 24  (tighter than grid's 64)
    expect(maxSpacing(face, g, { width: 200, height: 84 }).maxCol).toBeCloseTo(24, 5);
  });
  it("a single column has maxCol 0; a single row has maxRow 0", () => {
    const g = group({ id: "g", cols: 1, rows: 1 });
    const m = maxSpacing({ portGroups: [g], elements: [] }, g, { width: 200, height: 84 });
    expect(m.maxCol).toBe(0);
    expect(m.maxRow).toBe(0);
  });
});

describe("wouldOverlapAt", () => {
  const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
  const b = group({ id: "b", gridX: 0, gridY: 0 });
  it("true when the position overlaps another group", () => {
    expect(wouldOverlapAt(face, b, { x: 10, y: 0 }, { width: 400, height: 84 })).toBe(true);
  });
  it("true when out of bounds", () => {
    expect(wouldOverlapAt(face, b, { x: 390, y: 0 }, { width: 400, height: 84 })).toBe(true); // 390+24>400
  });
  it("false at a free in-bounds spot", () => {
    expect(wouldOverlapAt(face, b, { x: 40, y: 0 }, { width: 400, height: 84 })).toBe(false);
  });
});

describe("horizontal-only collision (3d)", () => {
  it("two groups overlap when their x-ranges overlap regardless of rows", () => {
    // a: 1 row at x0 (width 24); b: 2 rows at x10 → x-ranges overlap → collision
    const face: Face = { portGroups: [group({ id: "a", gridX: 0, rows: 1 })], elements: [] };
    expect(wouldOverlap(face, group({ id: "b", gridX: 10, rows: 2 }))).toBe(true);
  });
  it("no overlap when x-ranges are clear", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 0 })], elements: [] };
    expect(wouldOverlap(face, group({ id: "b", gridX: 40 }))).toBe(false);
  });
});

describe("movePortGroup is horizontal-only (3d)", () => {
  it("changes gridX and leaves gridY", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, { width: 400, height: 84 });
    const id = face.portGroups[0].id;
    const before = face.portGroups[0].gridY;
    const next = movePortGroup(face, id, { x: 104, y: 999 }, { width: 400, height: 84 });
    expect(next.portGroups[0].gridX).toBe(104);
    expect(next.portGroups[0].gridY).toBe(before);
  });
});

describe("maxSpacing.maxRow clamps to device height (3d)", () => {
  it("2 rows in 84px height: maxRow = (84 - 24 - 48)/1 = 12", () => {
    const g = group({ id: "g", rows: 2, cols: 1 });
    expect(maxSpacing({ portGroups: [g], elements: [] }, g, { width: 400, height: 84 }).maxRow).toBeCloseTo(12, 5);
  });
  it("single row → maxRow 0", () => {
    const g = group({ id: "g", rows: 1, cols: 1 });
    expect(maxSpacing({ portGroups: [g], elements: [] }, g, { width: 400, height: 84 }).maxRow).toBe(0);
  });
});

describe("setPortOverride carries labelPos (3d)", () => {
  it("stores labelPos", () => {
    const face: Face = { portGroups: [group({ id: "g" })], elements: [] };
    expect(setPortOverride(face, "g", 0, { labelPos: "bottom" }).portGroups[0].portOverrides[0]).toEqual({ labelPos: "bottom" });
  });
});

describe("removeColumn / removeRow (3f)", () => {
  it("removes a column, floored at 1", () => {
    const face: Face = { portGroups: [group({ id: "g", cols: 3, rows: 1 })], elements: [] };
    expect(removeColumn(face, "g").portGroups[0].cols).toBe(2);
  });
  it("does not remove below one column", () => {
    const face: Face = { portGroups: [group({ id: "g", cols: 1, rows: 1 })], elements: [] };
    expect(removeColumn(face, "g").portGroups[0].cols).toBe(1);
  });
  it("removes a row, floored at 1", () => {
    const face: Face = { portGroups: [group({ id: "g", cols: 1, rows: 3 })], elements: [] };
    expect(removeRow(face, "g").portGroups[0].rows).toBe(2);
    const single: Face = { portGroups: [group({ id: "g", cols: 1, rows: 1 })], elements: [] };
    expect(removeRow(single, "g").portGroups[0].rows).toBe(1);
  });
});
