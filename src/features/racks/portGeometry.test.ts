import { describe, it, expect } from "vitest";
import type { Face, PortGroup } from "@/domain/faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H } from "@/domain/faceplate-geometry";
import { ruTopY, RACK_GUTTER_L, RACK_PAD } from "./RackFrame";
import { portCenters } from "./portGeometry";

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
