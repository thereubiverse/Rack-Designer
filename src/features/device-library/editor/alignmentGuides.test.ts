import { describe, it, expect } from "vitest";
import { computeGuides, rectOf } from "./alignmentGuides";
import type { Face, PortGroup } from "@/domain/faceplate";
import type { GridBounds } from "./portGroupOps";

function group(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}
const bounds: GridBounds = { width: 400, height: 84 }; // 1U
const opts = { threshold: 6, allowVertical: false };

describe("computeGuides — edge/center alignment", () => {
  it("snaps a near left-edge to another group's left edge and emits a vertical line", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 100 }), group({ id: "g", gridX: 0 })], elements: [] };
    const res = computeGuides(face, "g", { x: 97, yOffset: 0 }, bounds, opts); // left 97 vs a.left 100
    expect(res.x).toBe(100);
    expect(res.lines.some((l) => l.axis === "x" && Math.round(l.pos) === 100)).toBe(true);
  });

  it("snaps centers together when edges don't line up", () => {
    // a: 3 cols (width 72) at 100 → cx 136; g: 1 col, drag so its center is near 136
    const face: Face = { portGroups: [group({ id: "a", gridX: 100, cols: 3 }), group({ id: "g", gridX: 0 })], elements: [] };
    const res = computeGuides(face, "g", { x: 127, yOffset: 0 }, bounds, opts); // g.cx 139 vs a.cx 136
    expect(res.x).toBe(124); // shifted so g.cx = 136
    expect(res.lines.some((l) => Math.round(l.pos) === 136)).toBe(true);
  });

  it("does not snap when everything is far away", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 300 }), group({ id: "g", gridX: 0 })], elements: [] };
    const res = computeGuides(face, "g", { x: 40, yOffset: 0 }, bounds, opts);
    expect(res.x).toBe(40);
    expect(res.lines).toHaveLength(0);
  });
});

describe("computeGuides — equal spacing", () => {
  it("matches the gap to another group's gap and reports the px distance", () => {
    // a(0..24), b(60..84): reference gap 36. Drag g to the right of b so its gap ≈ 36.
    const face: Face = { portGroups: [group({ id: "a", gridX: 0 }), group({ id: "b", gridX: 60 }), group({ id: "g", gridX: 200 })], elements: [] };
    const res = computeGuides(face, "g", { x: 117, yOffset: 0 }, bounds, opts); // g.left 117; target 84+36=120
    expect(res.x).toBe(120);
    expect(res.spacings.some((s) => s.gap === 36)).toBe(true);
  });

  it("centers a group between two neighbours (equal gaps both sides)", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 0 }), group({ id: "b", gridX: 120 }), group({ id: "g", gridX: 50 })], elements: [] };
    const res = computeGuides(face, "g", { x: 57, yOffset: 0 }, bounds, opts); // centered gridX = 60 (cx 72 = mid of 24..120)
    expect(res.x).toBe(60);
    // two equal gaps of 36 reported
    expect(res.spacings.filter((s) => s.gap === 36).length).toBeGreaterThanOrEqual(2);
  });
});

describe("computeGuides — equal distance to a device edge", () => {
  it("snaps G's right margin to match another group's left margin (mirrored), with px brackets", () => {
    // body width 400. a at gridX 30 → left margin 30. Drag g near the RIGHT edge so its
    // right margin (400 - g.right) ≈ 30 → g.right ≈ 370 → g.left ≈ 346.
    const face: Face = { portGroups: [group({ id: "a", gridX: 30 }), group({ id: "g", gridX: 200 })], elements: [] };
    const res = computeGuides(face, "g", { x: 343, yOffset: 0 }, bounds, opts); // g.right 367; target 370
    expect(res.x).toBe(346); // g.right = 370 → right margin 30 == a's left margin 30
    expect(res.spacings.some((s) => s.gap === 30)).toBe(true);
  });

  it("snaps G's left margin to match another group's left margin", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 40 }), group({ id: "g", gridX: 200 })], elements: [] };
    // but that's also left-edge alignment; ensure the margin bracket (gap 40) is reported
    const res = computeGuides(face, "g", { x: 43, yOffset: 0 }, bounds, opts);
    expect(res.x).toBe(40);
    expect(res.spacings.some((s) => s.gap === 40)).toBe(true);
  });
});

describe("computeGuides — vertical alignment (2RU+)", () => {
  const twoU: GridBounds = { width: 400, height: 168 };
  it("snaps the vertical center to another group's center on a 2U device", () => {
    const face: Face = {
      portGroups: [group({ id: "a", gridX: 0, yOffset: -40 }), group({ id: "g", gridX: 200 })],
      elements: [],
    };
    // a is pushed up 40; drag g near that offset → snaps yOffset to -40
    const res = computeGuides(face, "g", { x: 200, yOffset: -37 }, twoU, { threshold: 6, allowVertical: true });
    expect(res.yOffset).toBe(-40);
    expect(res.lines.some((l) => l.axis === "y")).toBe(true);
  });

  it("leaves yOffset alone when vertical is disabled (1U)", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 0 }), group({ id: "g", gridX: 200 })], elements: [] };
    const res = computeGuides(face, "g", { x: 200, yOffset: 5 }, bounds, opts);
    expect(res.yOffset).toBe(5);
  });
});

describe("computeGuides — guides stay inside the body (never into the ears)", () => {
  it("keeps every line/bracket coordinate within [0, width] × [0, height]", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 30 }), group({ id: "g", gridX: 200 })], elements: [] };
    const res = computeGuides(face, "g", { x: 343, yOffset: 0 }, bounds, opts); // mirrored edge-distance → brackets
    expect(res.lines.length + res.spacings.length).toBeGreaterThan(0);
    for (const l of res.lines) {
      const [lo, hi] = l.axis === "x" ? [0, bounds.width] : [0, bounds.height];
      expect(l.pos).toBeGreaterThanOrEqual(lo); expect(l.pos).toBeLessThanOrEqual(hi);
      const [elo, ehi] = l.axis === "x" ? [0, bounds.height] : [0, bounds.width];
      expect(Math.min(l.start, l.end)).toBeGreaterThanOrEqual(elo);
      expect(Math.max(l.start, l.end)).toBeLessThanOrEqual(ehi);
    }
    for (const s of res.spacings) {
      expect(s.start).toBeGreaterThanOrEqual(0);
      expect(s.end).toBeLessThanOrEqual(bounds.width);
      expect(s.y).toBeGreaterThanOrEqual(0); expect(s.y).toBeLessThanOrEqual(bounds.height);
    }
  });
});

describe("rectOf", () => {
  it("computes device-space extents with an override", () => {
    const r = rectOf(group({ cols: 2 }), bounds, { gridX: 10 }); // width 48, centered in 84
    expect(r).toMatchObject({ left: 10, right: 58, cx: 34, top: 30, bottom: 54 });
  });
});
