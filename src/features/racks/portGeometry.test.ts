import { describe, it, expect } from "vitest";
import type { Face, PortGroup } from "@/domain/faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H, RU_PX } from "@/domain/faceplate-geometry";
import { ruTopY, RACK_GUTTER_L, RACK_PAD } from "./RackFrame";
import { portCenters, portExitEdge } from "./portGeometry";

const group: PortGroup = {
  id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 2, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
};
const face: Face = { portGroups: [group], elements: [] };

describe("portCenters", () => {
  const args = { rackDeviceId: "d1", side: "front" as const, face, startU: 1,
    rackUnits: 1, widthIn: 19, rackMounted: true, heightU: 12 };

  it("returns one dot per port with the right PortRef", () => {
    const dots = portCenters(args);
    expect(dots).toHaveLength(2);
    expect(dots[0].port).toEqual({ rackDeviceId: "d1", side: "front", groupId: "g1", portIndex: 0 });
  });

  it("places a port centre at ix + earWidth + cell.x + CELL_W/2, deviceTop + cell.y + ROW_H/2", () => {
    const dims = frameDims({ widthIn: 19, rackUnits: 1, rackMounted: true });
    const cell = layoutPortGroup(group, dims.heightPx).cells[0];
    const ix = RACK_GUTTER_L + RACK_PAD;
    const top = ruTopY(1, 1, 12);
    const dot = portCenters(args)[0];
    expect(dot.x).toBeCloseTo(ix + dims.earWidthPx + cell.x + CELL_W / 2, 5);
    expect(dot.y).toBeCloseTo(top + cell.y + ROW_H / 2, 5);
  });
});

describe("portExitEdge", () => {
  // A 1RU-ish device spanning y 100..184 (mid 142).
  const top = 100, bottom = 184, mid = 142;

  it("a single-row port at the exact middle exits to the BOTTOM (not a floating-point coin-flip)", () => {
    // The real bug: a lone centred port is an exact tie. Nudge it a hair ABOVE centre so plain
    // nearest-edge would say "top"; the single-row rule must still send it down.
    expect(portExitEdge(mid, top, bottom, 1)).toBe("bottom");
    expect(portExitEdge(mid - 0.0001, top, bottom, 1)).toBe("bottom");
  });

  it("a single-row port clearly in the top portion still exits to the top", () => {
    // Outside the middle 50% band → nearest edge wins, so a high single row is not forced down.
    expect(portExitEdge(top + 5, top, bottom, 1)).toBe("top");
  });

  it("multi-row groups keep nearest-edge: the top row exits up even though it sits near the middle", () => {
    // Both rows of a 2-row device fall inside the middle band; without the rows===1 gate the top
    // row would wrongly be forced down. Upper row → top, lower row → bottom.
    expect(portExitEdge(mid - 12, top, bottom, 2)).toBe("top");
    expect(portExitEdge(mid + 12, top, bottom, 2)).toBe("bottom");
  });

  it("lower-half ports always exit to the bottom regardless of rows", () => {
    expect(portExitEdge(bottom - 5, top, bottom, 1)).toBe("bottom");
    expect(portExitEdge(bottom - 5, top, bottom, 2)).toBe("bottom");
  });
});

describe("exit direction is a property of the ROW", () => {
  // Ports sharing a row must all leave toward the SAME edge. That holds because the decision reads
  // only the port's y, its device's edges and its row count — all identical across a row — so it can
  // never depend on which connection a port happens to belong to. These drive real port centres
  // through portCenters rather than hand-picked ys, so a layout change can't quietly break it.
  const edgesByRow = (rows: number, cols: number): ("top" | "bottom")[][] => {
    const g: PortGroup = { ...group, id: "g", rows, cols };
    const dots = portCenters({
      rackDeviceId: "d", side: "front", face: { portGroups: [g], elements: [] },
      startU: 1, rackUnits: 1, widthIn: 19, rackMounted: true, heightU: 12,
    });
    const top = ruTopY(1, 1, 12), bottom = top + RU_PX;
    const byRow = new Map<number, ("top" | "bottom")[]>();
    for (const d of dots) {
      const key = Math.round(d.y * 1000); // same row === same y
      byRow.set(key, [...(byRow.get(key) ?? []), portExitEdge(d.y, top, bottom, rows)]);
    }
    return [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  };

  it("a single row of many ports all exit the same direction", () => {
    const rows = edgesByRow(1, 8);
    expect(rows).toHaveLength(1);            // one row...
    expect(rows[0]).toHaveLength(8);         // ...of 8 ports
    expect(new Set(rows[0]).size).toBe(1);   // every one of them agrees
  });

  it("each row of a 2-row group is internally consistent, and the two rows go opposite ways", () => {
    const rows = edgesByRow(2, 8);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(new Set(r).size).toBe(1); // no row is split
    expect(rows[0][0]).toBe("top");                        // upper row up
    expect(rows[1][0]).toBe("bottom");                     // lower row down
  });
});
