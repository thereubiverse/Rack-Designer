import { describe, it, expect } from "vitest";
import {
  RAIL_WIDTH_IN,
  U_HEIGHT_IN,
  PX_PER_IN,
  earWidthIn,
  frameDims,
  screwHoles,
} from "./faceplate-geometry";

describe("faceplate geometry — frame & ears", () => {
  it("exposes rack constants", () => {
    expect(RAIL_WIDTH_IN).toBe(19);
    expect(U_HEIGHT_IN).toBe(1.75);
  });

  it("ear width fills half the gap between body and 19in rails when rack-mounted", () => {
    expect(earWidthIn(10.6, true)).toBeCloseTo((19 - 10.6) / 2, 5); // 4.2
    expect(earWidthIn(19, true)).toBeCloseTo(0, 5);
  });

  it("has no ears when not rack-mounted", () => {
    expect(earWidthIn(10.6, false)).toBe(0);
  });

  it("clamps ear width to zero for bodies wider than the rails", () => {
    expect(earWidthIn(24, true)).toBe(0);
  });

  it("frameDims: rack-mounted frame locks to 19in, body centered, height scales per U", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    expect(d.frameWidthIn).toBe(19);
    expect(d.bodyWidthIn).toBe(10.6);
    expect(d.earWidthIn).toBeCloseTo(4.2, 5);
    expect(d.heightIn).toBeCloseTo(1.75, 5);
    expect(d.frameWidthPx).toBeCloseTo(19 * PX_PER_IN, 5);
    expect(d.heightPx).toBeCloseTo(1.75 * PX_PER_IN, 5);
  });

  it("frameDims: stand-alone frame equals the body width (no ears)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 2, rackMounted: false });
    expect(d.frameWidthIn).toBe(10.6);
    expect(d.earWidthIn).toBe(0);
    expect(d.heightIn).toBeCloseTo(3.5, 5);
  });

  it("frameDims: body wider than rails is clamped to the rail width when mounted", () => {
    const d = frameDims({ widthIn: 24, rackUnits: 1, rackMounted: true });
    expect(d.bodyWidthIn).toBe(19);
    expect(d.earWidthIn).toBe(0);
  });
});

describe("faceplate geometry — screw holes", () => {
  it("no holes when there are no ears (stand-alone)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: false });
    expect(screwHoles(d, 1)).toEqual([]);
  });

  it("rack-mounted 1U yields 4 holes: 2 per ear (top & bottom)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    expect(screwHoles(d, 1)).toHaveLength(4);
  });

  it("hole count scales with rack units (2 per U per ear)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 2, rackMounted: true });
    expect(screwHoles(d, 2)).toHaveLength(8);
  });

  it("left holes sit inside the left ear, right holes inside the right ear", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    const holes = screwHoles(d, 1);
    const leftX = d.earWidthPx / 2;
    const rightX = d.frameWidthPx - d.earWidthPx / 2;
    expect(holes.filter((h) => Math.abs(h.cx - leftX) < 0.001)).toHaveLength(2);
    expect(holes.filter((h) => Math.abs(h.cx - rightX) < 0.001)).toHaveLength(2);
  });

  it("holes stay within the frame height", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    for (const h of screwHoles(d, 1)) {
      expect(h.cy).toBeGreaterThan(0);
      expect(h.cy).toBeLessThan(d.heightPx);
    }
  });
});

import { portSequence, layoutPortGroup } from "./faceplate-geometry";
import type { PortGroup } from "./faceplate";

describe("faceplate geometry — port numbering", () => {
  it("ltr numbers left-to-right then top-to-bottom (row-major)", () => {
    expect(portSequence(2, 2, "ltr")).toEqual([1, 2, 3, 4]);
  });
  it("rtl reverses within each row", () => {
    expect(portSequence(2, 2, "rtl")).toEqual([2, 1, 4, 3]);
  });
  it("ttb numbers column-major top-to-bottom", () => {
    expect(portSequence(2, 2, "ttb")).toEqual([1, 3, 2, 4]);
  });
  it("btt numbers column-major bottom-to-top", () => {
    expect(portSequence(2, 2, "btt")).toEqual([2, 4, 1, 3]);
  });
});

function group(overrides: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g1",
    media: "copper",
    connectorType: "RJ45",
    idPrefix: "",
    countingDirection: "ltr",
    rows: 1,
    cols: 2,
    gridX: 0,
    gridY: 0,
    colSpacing: 0,
    rowSpacing: 0,
    portOverrides: {},
    ...overrides,
  };
}

describe("faceplate geometry — layoutPortGroup", () => {
  it("lays out cells on a uniform grid from gridX/gridY", () => {
    const g = layoutPortGroup(group({ gridX: 10, gridY: 5 }));
    expect(g.cells).toHaveLength(2);
    expect(g.cells[0]).toMatchObject({ index: 0, row: 0, col: 0, x: 10, y: 5 });
    expect(g.cells[1]).toMatchObject({ index: 1, row: 0, col: 1, x: 34, y: 5 }); // 10 + CELL_W
  });

  it("applies column and row spacing (px) between cells", () => {
    const g = layoutPortGroup(group({ rows: 2, cols: 2, colSpacing: 6, rowSpacing: 8 }));
    expect(g.cells[1].x).toBe(30); // 24 + 6
    expect(g.cells[2].y).toBe(32); // 24 + 8
    expect(g.width).toBe(54); // 2*24 + 6
    expect(g.height).toBe(56); // 2*24 + 8
  });

  it("builds labels from idPrefix + zero-padded sequence number", () => {
    const g = layoutPortGroup(group({ idPrefix: "Gi0/", cols: 3 }));
    expect(g.cells.map((c) => c.label)).toEqual(["Gi0/01", "Gi0/02", "Gi0/03"]);
  });

  it("honors per-port flip and name overrides", () => {
    const g = layoutPortGroup(
      group({ cols: 2, portOverrides: { 1: { flipped: true, name: "UPLINK" } } }),
    );
    expect(g.cells[0].flipped).toBe(false);
    expect(g.cells[1].flipped).toBe(true);
    expect(g.cells[1].label).toBe("UPLINK");
  });

  it("numbers cells according to counting direction", () => {
    const g = layoutPortGroup(group({ cols: 2, countingDirection: "rtl" }));
    expect(g.cells.map((c) => c.number)).toEqual([2, 1]);
    expect(g.cells.map((c) => c.label)).toEqual(["02", "01"]);
  });
});
