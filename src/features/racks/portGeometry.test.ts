import { describe, it, expect } from "vitest";
import type { Face, PortGroup } from "@/domain/faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H } from "@/domain/faceplate-geometry";
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
