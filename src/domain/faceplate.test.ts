import { describe, it, expect } from "vitest";
import { MEDIA, CONNECTORS, emptyFace, isValidWidthIn, isValidRackUnits } from "./faceplate";
import type { FaceElement } from "./faceplate";

describe("faceplate domain", () => {
  it("lists all ten media types", () => {
    expect(MEDIA).toEqual(["copper","fiber","sfp","usb_a","usb_c","hdmi","dp","vga","ps2","audio"]);
  });
  it("maps connector options per media", () => {
    expect(CONNECTORS.copper).toContain("RJ45");
    expect(CONNECTORS.sfp).toContain("SFP+");
    expect(CONNECTORS.fiber).toContain("LC");
    // every media has at least one connector option
    for (const m of MEDIA) expect(CONNECTORS[m].length).toBeGreaterThan(0);
  });
  it("emptyFace has no groups or elements", () => {
    expect(emptyFace()).toEqual({ portGroups: [], elements: [] });
  });
  it("validates width in inches (0 < w <= 17.5 max body width)", () => {
    expect(isValidWidthIn(17.5)).toBe(true);
    expect(isValidWidthIn(10.6)).toBe(true);
    expect(isValidWidthIn(0)).toBe(false);
    expect(isValidWidthIn(19)).toBe(false);
  });
  it("validates rack units (int, 1..60)", () => {
    expect(isValidRackUnits(1)).toBe(true);
    expect(isValidRackUnits(0)).toBe(false);
    expect(isValidRackUnits(1.5)).toBe(false);
    expect(isValidRackUnits(61)).toBe(false);
  });
});

it("FaceElement union accepts text, shape, and line", () => {
  const els: FaceElement[] = [
    { id: "t", kind: "text", gridX: 0, gridY: 0, w: 40, h: 24, content: "A", alignment: "center", fontSize: 11 },
    { id: "s", kind: "shape", shape: "rect", gridX: 0, gridY: 0, w: 40, h: 24 },
    { id: "l", kind: "line", x1: 0, y1: 0, x2: 40, y2: 0, stroke: "#111418", strokeWidth: 1.5 },
  ];
  expect(els).toHaveLength(3);
});
