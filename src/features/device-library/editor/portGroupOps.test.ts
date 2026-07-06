import { describe, it, expect } from "vitest";
import { groupBounds, wouldOverlap, findFreePosition, SNAP, type GridBounds, addPortGroup, movePortGroup, addColumn, addRow, updatePortGroup, deletePortGroup, setPortOverride, setPortMedia, setSpacing, maxSpacing, wouldOverlapAt, removeColumn, removeRow, patchPorts, rotatePorts, deletePortGroups, allPortIndices } from "./portGroupOps";
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
    expect(wouldOverlap(face, group({ id: "b", gridX: 10, gridY: 0 }), bounds)).toBe(true);
  });
  it("clears a non-overlapping candidate", () => {
    expect(wouldOverlap(face, group({ id: "b", gridX: 40, gridY: 0 }), bounds)).toBe(false);
  });
  it("excludes the group itself by id", () => {
    expect(wouldOverlap(face, group({ id: "a", gridX: 0, gridY: 0 }), bounds, "a")).toBe(false);
  });
  it("clears a same-column candidate that is vertically separated (2RU)", () => {
    // two 1-row groups on a 2U (168px) device: one pushed to the top, one to the bottom,
    // both at gridX 0 → same column but no vertical overlap.
    const twoU: GridBounds = { width: 400, height: 168 };
    const top = group({ id: "a", gridX: 0, yOffset: -60 });
    const faceTop: Face = { portGroups: [top], elements: [] };
    expect(wouldOverlap(faceTop, group({ id: "b", gridX: 0, yOffset: 60 }), twoU)).toBe(false);
  });
});

describe("findFreePosition", () => {
  it("snaps the desired x position to the 8px grid when free; y passes through unchanged", () => {
    const face: Face = { portGroups: [], elements: [] };
    expect(findFreePosition(face, group(), { x: 11, y: 3 }, bounds)).toEqual({ x: 8, y: 3 });
  });
  it("clamps x within the grid bounds; y passes through unchanged (horizontal-only)", () => {
    const face: Face = { portGroups: [], elements: [] };
    // desired far right; 1x1 (24 wide) fits within width 400, reserving SEL_PAD(6) each
    // side for the selection box → max x = 400 - 24 - 6 = 370
    expect(findFreePosition(face, group(), { x: 999, y: 999 }, bounds)).toEqual({ x: 370, y: 999 });
  });
  it("nudges to the nearest free spot when the target overlaps", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
    const free = findFreePosition(face, group({ id: "b" }), { x: 0, y: 0 }, bounds, "b");
    expect(free).not.toBeNull();
    expect(wouldOverlap(face, group({ id: "b", gridX: free!.x, gridY: free!.y }), bounds, "b")).toBe(false);
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
    expect(wouldOverlap({ portGroups: [next.portGroups[0]], elements: [] }, next.portGroups[1], bounds)).toBe(false);
  });
  it("respects the snap step: free (1px) vs the 12px grid", () => {
    const free = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 33, y: 0 }, bounds, 1).portGroups[0];
    expect(free.gridX).toBe(33); // step 1 → no snapping
    const grid = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 17, y: 0 }, bounds, 12).portGroups[0];
    expect(grid.gridX).toBe(12); // 17 → nearest 12px line
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
    // 104 is on the 8px grid; free-move (no snap opts) passes x through unchanged
    const next = movePortGroup(face, id, { x: 104 }, bounds);
    expect(next.portGroups[0]).toMatchObject({ gridX: 104, gridY: gridYBefore });
  });

  it("with snap on, snaps x to the 12px (0.25\") grid", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    const next = movePortGroup(face, id, { x: 17 }, bounds, { snap: true });
    expect(next.portGroups[0].gridX).toBe(12); // 17 → nearest 12px grid line
  });

  it("does not move vertically unless allowVertical is set", () => {
    const twoU: GridBounds = { width: 400, height: 168 };
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, twoU);
    const id = face.portGroups[0].id;
    const next = movePortGroup(face, id, { x: 0, yOffset: 60 }, twoU, { snap: true });
    expect(next.portGroups[0].yOffset ?? 0).toBe(0); // vertical ignored
  });

  it("with allowVertical, sets a snapped yOffset clamped inside the device", () => {
    const twoU: GridBounds = { width: 400, height: 168 };
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, twoU);
    const id = face.portGroups[0].id;
    // push far down: a 1-row (24px) group in 168px height centers at top 72; max top = 144.
    const next = movePortGroup(face, id, { x: 0, yOffset: 999 }, twoU, { snap: true, allowVertical: true });
    const g = next.portGroups[0];
    // clamped so the icon top sits at 144 (a 12px grid line) → offset = 144 - 72 = 72
    expect(g.yOffset).toBe(72);
  });
});

describe("addColumn / addRow", () => {
  it("adds a column / a row", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    expect(addColumn(face, id, bounds).portGroups[0].cols).toBe(2);
    expect(addRow(face, id, bounds).portGroups[0].rows).toBe(2);
  });
  it("caps rows at 2 per rack unit (1U → 2 rows max)", () => {
    let face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds); // height 84 = 1U
    const id = face.portGroups[0].id;
    face = addRow(face, id, bounds);
    expect(face.portGroups[0].rows).toBe(2);
    face = addRow(face, id, bounds); // third row rejected
    expect(face.portGroups[0].rows).toBe(2);
  });
  it("allows 4 rows in a 2U device (2 per rack unit)", () => {
    const twoU: GridBounds = { width: 400, height: 168 };
    let face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, twoU);
    const id = face.portGroups[0].id;
    for (let i = 0; i < 5; i++) face = addRow(face, id, twoU);
    expect(face.portGroups[0].rows).toBe(4);
  });
  it("seeds default row spacing when a group reaches 3 rows (so labels have room)", () => {
    const twoU: GridBounds = { width: 400, height: 168 };
    let face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, twoU);
    const id = face.portGroups[0].id;
    face = addRow(face, id, twoU); // 2 rows — no auto spacing
    expect(face.portGroups[0].rowSpacing).toBe(0);
    face = addRow(face, id, twoU); // 3 rows — seeds LABEL_H (12) of spacing
    expect(face.portGroups[0].rows).toBe(3);
    expect(face.portGroups[0].rowSpacing).toBe(12);
  });
  it("adds a row even when the group sits mid-height (gridY does not gate growth)", () => {
    let face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 40 }, bounds);
    const id = face.portGroups[0].id;
    face = addRow(face, id, bounds);
    expect(face.portGroups[0].rows).toBe(2);
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

describe("add/remove propagate per-port orientation + label (but not name)", () => {
  const twoU: GridBounds = { width: 400, height: 168 };

  it("adding a column copies a flipped port's orientation onto the new port", () => {
    const g = group({ cols: 1, rows: 1, portOverrides: { 0: { flipped: true } } });
    const next = addColumn({ portGroups: [g], elements: [] }, "g", bounds).portGroups[0];
    expect(next.cols).toBe(2);
    expect(next.portOverrides[1]?.flipped).toBe(true); // r0c1 (new) inherits r0c0
  });

  it("copies each row's orientation to the new column when rows differ", () => {
    // 2 rows, 1 col: idx0=r0 (flipped), idx1=r1 (default)
    const g = group({ cols: 1, rows: 2, portOverrides: { 0: { flipped: true } } });
    const next = addColumn({ portGroups: [g], elements: [] }, "g", bounds).portGroups[0];
    expect(next.cols).toBe(2);
    // reindexed to cols=2: r0c0=0, r0c1=1, r1c0=2, r1c1=3
    expect(next.portOverrides[0]?.flipped).toBe(true);        // r0c0 kept
    expect(next.portOverrides[1]?.flipped).toBe(true);        // r0c1 new → matches row 0
    expect(next.portOverrides[2]?.flipped).toBeUndefined();   // r1c0 unchanged (not flipped)
    expect(next.portOverrides[3]?.flipped).toBeUndefined();   // r1c1 new → matches row 1 (not flipped)
  });

  it("adding a row copies the last row's label position + flip to the new row", () => {
    const g = group({ cols: 2, rows: 1, portOverrides: { 0: { labelPos: "bottom" }, 1: { flipped: true } } });
    const next = addRow({ portGroups: [g], elements: [] }, "g", twoU).portGroups[0];
    expect(next.rows).toBe(2);
    expect(next.portOverrides[2]?.labelPos).toBe("bottom"); // r1c0 inherits r0c0
    expect(next.portOverrides[3]?.flipped).toBe(true);      // r1c1 inherits r0c1
  });

  it("does not copy the per-port name onto added ports", () => {
    const g = group({ cols: 1, rows: 1, portOverrides: { 0: { name: "WAN", flipped: true } } });
    const next = addColumn({ portGroups: [g], elements: [] }, "g", bounds).portGroups[0];
    expect(next.portOverrides[1]?.flipped).toBe(true);
    expect(next.portOverrides[1]?.name).toBeUndefined();
  });

  it("adding a column copies a type-overridden port's media + connector onto the new port", () => {
    // group is copper; port 0 was overridden to fiber. The new column should duplicate
    // the CURRENT port (fiber), not fall back to the group's original copper media.
    const g = group({ cols: 1, rows: 1, media: "copper", connectorType: "RJ45", portOverrides: { 0: { media: "fiber", connectorType: "LC" } } });
    const next = addColumn({ portGroups: [g], elements: [] }, "g", bounds).portGroups[0];
    expect(next.portOverrides[1]?.media).toBe("fiber");
    expect(next.portOverrides[1]?.connectorType).toBe("LC");
  });

  it("adding a row copies the last row's type override onto the new row", () => {
    const g = group({ cols: 1, rows: 1, media: "copper", connectorType: "RJ45", portOverrides: { 0: { media: "fiber", connectorType: "LC" } } });
    const next = addRow({ portGroups: [g], elements: [] }, "g", twoU).portGroups[0];
    expect(next.portOverrides[1]?.media).toBe("fiber"); // r1c0 inherits r0c0 type
    expect(next.portOverrides[1]?.connectorType).toBe("LC");
  });

  it("removing a column drops that column's overrides and reindexes the rest", () => {
    // 2 cols, 2 rows; column 0 (idx 0 and 2) flipped
    const g = group({ cols: 2, rows: 2, portOverrides: { 0: { flipped: true }, 2: { flipped: true } } });
    const next = removeColumn({ portGroups: [g], elements: [] }, "g").portGroups[0];
    expect(next.cols).toBe(1);
    expect(next.portOverrides[0]?.flipped).toBe(true); // r0c0
    expect(next.portOverrides[1]?.flipped).toBe(true); // r1c0 (reindexed from old idx 2)
  });
});

describe("setPortMedia (per-port type override)", () => {
  it("overrides one port's media and seeds that type's default connector", () => {
    const g = group({ cols: 2, media: "copper", connectorType: "RJ45" });
    const next = setPortMedia({ portGroups: [g], elements: [] }, "g", 1, "fiber").portGroups[0];
    expect(next.media).toBe("copper");             // group media unchanged
    expect(next.portOverrides[1]?.media).toBe("fiber");
    expect(next.portOverrides[1]?.connectorType).toBe("LC"); // first fiber connector
    expect(next.portOverrides[0]).toBeUndefined(); // sibling port untouched
  });
  it("clears the override when set back to the group's own media", () => {
    const g = group({ cols: 2, media: "copper", portOverrides: { 1: { media: "fiber", connectorType: "LC" } } });
    const next = setPortMedia({ portGroups: [g], elements: [] }, "g", 1, "copper").portGroups[0];
    expect(next.portOverrides[1]?.media).toBeUndefined();
    expect(next.portOverrides[1]?.connectorType).toBeUndefined();
  });
});

describe("batch ops: patchPorts / rotatePorts / deletePortGroups (multi-select)", () => {
  it("patchPorts applies a patch to several ports in one group", () => {
    const g = group({ id: "g", cols: 4 });
    const next = patchPorts({ portGroups: [g], elements: [] }, [{ groupId: "g", indices: [0, 2] }], { labelPos: "bottom" }).portGroups[0];
    expect(next.portOverrides[0]?.labelPos).toBe("bottom");
    expect(next.portOverrides[2]?.labelPos).toBe("bottom");
    expect(next.portOverrides[1]).toBeUndefined(); // untouched
  });

  it("patchPorts spans multiple groups", () => {
    const a = group({ id: "a", cols: 2 });
    const b = group({ id: "b", cols: 2 });
    const face: Face = { portGroups: [a, b], elements: [] };
    const next = patchPorts(face, [
      { groupId: "a", indices: allPortIndices(a) },
      { groupId: "b", indices: allPortIndices(b) },
    ], { rotation: 180 });
    expect(next.portGroups[0].portOverrides[1]?.rotation).toBe(180);
    expect(next.portGroups[1].portOverrides[0]?.rotation).toBe(180);
  });

  it("patchPorts merges without dropping an existing override", () => {
    const g = group({ id: "g", cols: 2, portOverrides: { 0: { name: "WAN", media: "fiber" } } });
    const next = patchPorts({ portGroups: [g], elements: [] }, [{ groupId: "g", indices: [0] }], { rotation: 180 }).portGroups[0];
    expect(next.portOverrides[0]).toMatchObject({ name: "WAN", media: "fiber", rotation: 180 });
  });

  it("rotatePorts increments each targeted port by delta (mod 360)", () => {
    const g = group({ id: "g", cols: 2, portOverrides: { 0: { rotation: 180 } } });
    const next = rotatePorts({ portGroups: [g], elements: [] }, [{ groupId: "g", indices: [0, 1] }], 180).portGroups[0];
    expect(next.portOverrides[0]?.rotation).toBe(0);   // 180 + 180 → 0
    expect(next.portOverrides[1]?.rotation).toBe(180); // 0 + 180 → 180
  });

  it("allPortIndices lists every port row-major", () => {
    expect(allPortIndices(group({ rows: 2, cols: 3 }))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("deletePortGroups removes all listed groups, keeps the rest", () => {
    const face: Face = { portGroups: [group({ id: "a" }), group({ id: "b" }), group({ id: "c" })], elements: [] };
    const next = deletePortGroups(face, ["a", "c"]);
    expect(next.portGroups.map((g) => g.id)).toEqual(["b"]);
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
    // 3 cols * 24 = 72 tight; width 200 minus SEL_PAD(6) at the edge, gridX 0 →
    // maxCol = (200 - 6 - 0 - 72)/2 = 61
    const g = group({ id: "g", cols: 3, gridX: 0, gridY: 0 });
    const face: Face = { portGroups: [g], elements: [] };
    expect(maxSpacing(face, g, { width: 200, height: 84 }).maxCol).toBeCloseTo(61, 5);
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

describe("collision — 2D but centered groups collide on x-overlap", () => {
  it("two centered groups overlap when their x-ranges overlap regardless of rows", () => {
    // a: 1 row at x0 (width 24); b: 2 rows at x10 → x-ranges overlap; both centered → collision
    const face: Face = { portGroups: [group({ id: "a", gridX: 0, rows: 1 })], elements: [] };
    expect(wouldOverlap(face, group({ id: "b", gridX: 10, rows: 2 }), bounds)).toBe(true);
  });
  it("no overlap when x-ranges are clear", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 0 })], elements: [] };
    expect(wouldOverlap(face, group({ id: "b", gridX: 40 }), bounds)).toBe(false);
  });
});

describe("movePortGroup is horizontal-only (3d)", () => {
  it("changes gridX and leaves gridY", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, { width: 400, height: 84 });
    const id = face.portGroups[0].id;
    const before = face.portGroups[0].gridY;
    const next = movePortGroup(face, id, { x: 104 }, { width: 400, height: 84 });
    expect(next.portGroups[0].gridX).toBe(104);
    expect(next.portGroups[0].gridY).toBe(before);
  });
});

describe("maxSpacing.maxRow clamps to device height (3d)", () => {
  it("2 rows in 84px height: labels + SEL_PAD fill the U, so maxRow = (84 - 36 - 48)/1 = 0", () => {
    const g = group({ id: "g", rows: 2, cols: 1 });
    expect(maxSpacing({ portGroups: [g], elements: [] }, g, { width: 400, height: 84 }).maxRow).toBeCloseTo(0, 5);
  });
  it("2 rows in a 2U height (168px) leaves room to spread: maxRow = (168 - 36 - 48)/1 = 84", () => {
    const g = group({ id: "g", rows: 2, cols: 1 });
    expect(maxSpacing({ portGroups: [g], elements: [] }, g, { width: 400, height: 168 }).maxRow).toBeCloseTo(84, 5);
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
