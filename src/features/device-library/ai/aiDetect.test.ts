import { describe, it, expect } from "vitest";
import { validateDetectedFace } from "./aiDetect";

describe("validateDetectedFace", () => {
  it("keeps a valid group unchanged", () => {
    const f = validateDetectedFace({
      groups: [{ media: "copper", connector: "RJ45", count: 24, rows: 2, order: "ltr", labelPrefix: "Gi", bbox: { x: 0.1, y: 0.2, w: 0.5, h: 0.3 } }],
      confidence: "high",
    });
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0].connector).toBe("RJ45");
    expect(f.confidence).toBe("high");
  });

  it("drops a group with an unknown media", () => {
    const f = validateDetectedFace({ groups: [{ media: "banana", connector: "X", count: 4, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "low" });
    expect(f.groups).toHaveLength(0);
  });

  it("maps the 'ethernet' synonym to copper", () => {
    const f = validateDetectedFace({ groups: [{ media: "ethernet", connector: "RJ45", count: 8, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "medium" });
    expect(f.groups[0].media).toBe("copper");
  });

  it("falls back to the media's first connector when the connector is invalid", () => {
    const f = validateDetectedFace({ groups: [{ media: "copper", connector: "bogus", count: 8, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "medium" });
    expect(f.groups[0].connector).toBe("RJ45"); // CONNECTORS.copper[0]
  });

  it("clamps count/rows/bbox and defaults order + confidence", () => {
    const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 9999, rows: 12, order: "sideways", bbox: { x: -3, y: 2, w: 9, h: -1 } }] });
    const g = f.groups[0];
    expect(g.count).toBe(96);
    expect(g.rows).toBe(4);
    expect(g.order).toBe("ltr");
    expect(g.bbox).toEqual({ x: 0, y: 1, w: 1, h: 0 });
    expect(f.confidence).toBe("low");
  });

  it("clamps optional rackUnits/widthIn and preserves text metadata", () => {
    const f = validateDetectedFace({ groups: [], rackUnits: 99, widthIn: 40, brand: "Cisco", modelText: "C9200", confidence: "high" });
    expect(f.rackUnits).toBe(4);
    expect(f.widthIn).toBe(17.5);
    expect(f.brand).toBe("Cisco");
    expect(f.modelText).toBe("C9200");
  });

  it("throws on non-object input", () => {
    expect(() => validateDetectedFace("nope")).toThrow("unreadable");
    expect(() => validateDetectedFace(null)).toThrow("unreadable");
  });
});
