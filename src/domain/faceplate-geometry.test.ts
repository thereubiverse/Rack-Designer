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
