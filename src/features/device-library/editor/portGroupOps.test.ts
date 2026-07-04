import { describe, it, expect } from "vitest";
import { groupBounds, wouldOverlap, findFreePosition, SNAP, type GridBounds, addPortGroup, movePortGroup, addColumn, addRow, updatePortGroup, deletePortGroup } from "./portGroupOps";
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
  it("snaps the desired position to the 8px grid when free", () => {
    const face: Face = { portGroups: [], elements: [] };
    expect(findFreePosition(face, group(), { x: 11, y: 3 }, bounds)).toEqual({ x: 8, y: 0 });
  });
  it("clamps within the grid bounds", () => {
    const face: Face = { portGroups: [], elements: [] };
    // desired far right; 1x1 (24 wide) must fit within width 400 → max x = 376
    expect(findFreePosition(face, group(), { x: 999, y: 999 }, bounds)).toEqual({ x: 376, y: 60 });
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
    expect(g).toMatchObject({ media: "sfp", connectorType: "SFP", cols: 1, rows: 1, gridX: 32, gridY: 8 });
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
  it("relocates the group to the snapped target", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    // 104 and 32 are already on the 8px grid, so they pass through unchanged
    const next = movePortGroup(face, id, { x: 104, y: 32 }, bounds);
    expect(next.portGroups[0]).toMatchObject({ gridX: 104, gridY: 32 });
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
