import { describe, it, expect } from "vitest";
import { layoutDetectedFace } from "./layoutDetectedFace";
import type { DetectedFace } from "./aiDetect";
import { frameDims, CELL_W } from "@/domain/faceplate-geometry";

const face = (partial: Partial<DetectedFace>): DetectedFace => ({ groups: [], confidence: "high", ...partial });

describe("layoutDetectedFace", () => {
  it("derives cols from count/rows and seeds prefix + counting direction", () => {
    const out = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 24, rows: 2, order: "rtl", labelPrefix: "Gi", bbox: { x: 0, y: 0, w: 0.5, h: 0.5 } }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    expect(out.portGroups).toHaveLength(1);
    const g = out.portGroups[0];
    expect(g.cols).toBe(12);
    expect(g.rows).toBe(2);
    expect(g.idPrefix).toBe("Gi");
    expect(g.countingDirection).toBe("rtl");
    expect(g.media).toBe("copper");
  });

  it("places a group near its bbox.x on the grid", () => {
    const { bodyWidthPx } = frameDims({ widthIn: 17.5, rackUnits: 1, rackMounted: true });
    const out = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 4, rows: 1, order: "ltr", bbox: { x: 0.5, y: 0, w: 0.1, h: 0.5 } }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    const g = out.portGroups[0];
    expect(g.gridX % 12).toBe(0);                 // snapped to GRID_PX
    expect(Math.abs(g.gridX - bodyWidthPx * 0.5)).toBeLessThan(24); // near the requested x
    expect(g.gridX).toBeGreaterThanOrEqual(0);
  });

  it("de-overlaps two groups the model placed at the same x", () => {
    const out = layoutDetectedFace(
      face({ groups: [
        { media: "copper", connector: "RJ45", count: 4, rows: 1, order: "ltr", bbox: { x: 0.1, y: 0, w: 0.1, h: 0.5 } },
        { media: "sfp", connector: "SFP+", count: 4, rows: 1, order: "ltr", bbox: { x: 0.1, y: 0, w: 0.1, h: 0.5 } },
      ] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    expect(out.portGroups).toHaveLength(2);
    const [a, b] = out.portGroups;
    // non-overlapping horizontally (1U → same vertical band)
    const aRight = a.gridX + a.cols * CELL_W;
    const bRight = b.gridX + b.cols * CELL_W;
    expect(a.gridX >= bRight || b.gridX >= aRight).toBe(true);
  });

  it("sets a downward yOffset for a group low on a 2U device", () => {
    const out = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 4, rows: 1, order: "ltr", bbox: { x: 0, y: 0.8, w: 0.1, h: 0.1 } }] }),
      { widthIn: 17.5, rackUnits: 2 },
    );
    expect(out.portGroups[0].yOffset).toBeGreaterThan(0);
  });

  it("maps detected labels to text elements", () => {
    const out = layoutDetectedFace(
      face({ labels: [{ text: "CONSOLE", bbox: { x: 0.9, y: 0.1, w: 0.08, h: 0.1 } }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    expect(out.elements).toHaveLength(1);
    expect(out.elements[0].kind).toBe("text");
    expect((out.elements[0] as { content: string }).content).toBe("CONSOLE");
  });

  it("mirrors row rotation from rowOrientations", () => {
    const out = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 0.3, h: 0.5 }, rowOrientations: ["down", "up"] }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    const g = out.portGroups[0];
    expect(g.portOverrides[0]?.rotation ?? 0).toBe(0);   // row 0 (down) → 0
    expect(g.portOverrides[g.cols]?.rotation).toBe(180); // row 1 (up)  → 180
  });

  it("leaves rotation unset when no rowOrientations", () => {
    const out = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 0.3, h: 0.5 } }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    expect(out.portGroups[0].portOverrides).toEqual({});
  });

  it("A: applies per-port type overrides, merged with rotation", () => {
    const out = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 0.3, h: 0.5 }, rowOrientations: ["down", "up"], portTypes: [{ index: 4, media: "fiber", connector: "LC" }, { index: 5, media: "sfp" }] }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    const po = out.portGroups[0].portOverrides;
    expect(po[4]).toMatchObject({ media: "fiber", connectorType: "LC", rotation: 180 }); // type + row-1 rotation merged
    expect(po[5]).toMatchObject({ media: "sfp", connectorType: "SFP" });                 // connector defaulted
  });

  it("B: positions a single row low from a high bbox.y", () => {
    const low = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 4, rows: 1, order: "ltr", bbox: { x: 0, y: 0.75, w: 0.1, h: 0.1 } }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    expect(low.portGroups[0].yOffset).toBeGreaterThan(0);
  });

  it("C: places groups left-to-right by bbox.x regardless of input order", () => {
    const out = layoutDetectedFace(
      face({ groups: [
        { media: "copper", connector: "RJ45", count: 4, rows: 1, order: "ltr", bbox: { x: 0.6, y: 0, w: 0.1, h: 0.5 } },
        { media: "sfp", connector: "SFP", count: 4, rows: 1, order: "ltr", bbox: { x: 0.05, y: 0, w: 0.1, h: 0.5 } },
      ] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    expect(out.portGroups[0].media).toBe("sfp");                              // leftmost placed first
    expect(out.portGroups[0].gridX).toBeLessThan(out.portGroups[1].gridX);    // ascending
  });

  it("C: spreads a wide block via colSpacing, leaves a tight one at 0", () => {
    const wide = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 4, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 0.9, h: 0.5 } }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    expect(wide.portGroups[0].colSpacing).toBeGreaterThan(0);
    const tight = layoutDetectedFace(
      face({ groups: [{ media: "copper", connector: "RJ45", count: 24, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 0.3, h: 0.5 } }] }),
      { widthIn: 17.5, rackUnits: 1 },
    );
    expect(tight.portGroups[0].colSpacing).toBe(0);
  });
});
