import { describe, it, expect } from "vitest";
import {
  RAIL_WIDTH_IN,
  U_HEIGHT_IN,
  PX_PER_IN,
  earWidthIn,
  frameDims,
  screwHoles,
  SCREW_EDGE_INSET_PX,
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

  it("frameDims: body wider than the max is clamped to 17.5in when mounted", () => {
    const d = frameDims({ widthIn: 24, rackUnits: 1, rackMounted: true });
    expect(d.bodyWidthIn).toBe(17.5);
    expect(d.earWidthIn).toBeCloseTo(0.75, 5);
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

  it("multi-U still yields only 4 corner holes (not repeated per U)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 2, rackMounted: true });
    const holes = screwHoles(d, 2);
    expect(holes).toHaveLength(4);
    // one near the top edge, one near the bottom edge of the whole frame
    expect(holes.some((h) => h.cy < d.heightPx * 0.2)).toBe(true);
    expect(holes.some((h) => h.cy > d.heightPx * 0.8)).toBe(true);
  });

  it("left holes sit inside the left ear, right holes inside the right ear", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    const holes = screwHoles(d, 1);
    const leftX = SCREW_EDGE_INSET_PX;
    const rightX = d.frameWidthPx - SCREW_EDGE_INSET_PX;
    expect(holes.filter((h) => Math.abs(h.cx - leftX) < 0.001)).toHaveLength(2);
    expect(holes.filter((h) => Math.abs(h.cx - rightX) < 0.001)).toHaveLength(2);
    // both sit within their ear
    for (const h of holes) expect(h.cx < d.earWidthPx || h.cx > d.frameWidthPx - d.earWidthPx).toBe(true);
  });

  it("holes stay the same distance from the outer edge regardless of body width", () => {
    const wide = screwHoles(frameDims({ widthIn: 17.5, rackUnits: 1, rackMounted: true }), 1);
    const narrow = screwHoles(frameDims({ widthIn: 8, rackUnits: 1, rackMounted: true }), 1);
    const frame = frameDims({ widthIn: 8, rackUnits: 1, rackMounted: true }).frameWidthPx;
    const leftInset = (hs: { cx: number }[]) => Math.min(...hs.map((h) => h.cx));
    const rightInset = (hs: { cx: number }[]) => frame - Math.max(...hs.map((h) => h.cx));
    expect(leftInset(wide)).toBeCloseTo(SCREW_EDGE_INSET_PX);
    expect(leftInset(narrow)).toBeCloseTo(SCREW_EDGE_INSET_PX);
    expect(rightInset(wide)).toBeCloseTo(SCREW_EDGE_INSET_PX);
    expect(rightInset(narrow)).toBeCloseTo(SCREW_EDGE_INSET_PX);
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

describe("layoutPortGroup — vertical centering & labelPos", () => {
  function g(over: Partial<PortGroup> = {}): PortGroup {
    return {
      id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
      countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
      colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
    };
  }
  it("centers a single row dead-center in the device height", () => {
    // heightPx 84 (1U), height = ROW_H 24 → top = (84-24)/2 = 30
    const laid = layoutPortGroup(g(), 84);
    expect(laid.top).toBeCloseTo(30, 5);
    expect(laid.cells[0].y).toBeCloseTo(30, 5);
  });
  it("applies yOffset to shift the stack off-center (2RU)", () => {
    // 168px (2U), single row centers at 72; yOffset -60 → top 12
    const laid = layoutPortGroup(g({ yOffset: -60 }), 168);
    expect(laid.top).toBeCloseTo(12, 5);
  });
  it("clamps yOffset so the stack stays inside the device", () => {
    // 168px, single row (24px): max top = 168-24 = 144, so a huge offset clamps there
    expect(layoutPortGroup(g({ yOffset: 999 }), 168).top).toBeCloseTo(144, 5);
    expect(layoutPortGroup(g({ yOffset: -999 }), 168).top).toBeCloseTo(0, 5);
  });
  it("centers a two-row group symmetric about center", () => {
    // 2 rows, rowSpacing 0 → height 48, top = (84-48)/2 = 18; row1 y = 18, row2 y = 18+24 = 42
    const laid = layoutPortGroup(g({ rows: 2, cols: 1 }), 84);
    expect(laid.cells[0].y).toBeCloseTo(18, 5);
    expect(laid.cells[1].y).toBeCloseTo(42, 5);
  });
  it("defaults labelPos: single row → top; bottom row of a multi-row group → bottom", () => {
    expect(layoutPortGroup(g(), 84).cells[0].labelPos).toBe("top");
    const two = layoutPortGroup(g({ rows: 2, cols: 1 }), 84);
    expect(two.cells[0].labelPos).toBe("top");   // row 0
    expect(two.cells[1].labelPos).toBe("bottom"); // last row
  });
  it("a per-port labelPos override wins", () => {
    const laid = layoutPortGroup(g({ portOverrides: { 0: { labelPos: "bottom" } } }), 84);
    expect(laid.cells[0].labelPos).toBe("bottom");
  });
  it("a 3+ row group defaults every label to the bottom", () => {
    const three = layoutPortGroup(g({ rows: 3, cols: 1 }), 168);
    expect(three.cells.map((c) => c.labelPos)).toEqual(["bottom", "bottom", "bottom"]);
  });
  it("without heightPx, uses the legacy gridY origin (back-compat)", () => {
    const laid = layoutPortGroup(g({ gridY: 10 }));
    expect(laid.cells[0].y).toBe(10);
    expect(laid.top).toBe(10);
  });
});
