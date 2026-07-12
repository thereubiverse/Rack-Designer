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

  it("keeps a group with media 'usb_a' unchanged", () => {
    const f = validateDetectedFace({ groups: [{ media: "usb_a", connector: "USB-A", count: 4, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "high" });
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0].media).toBe("usb_a");
  });

  it("keeps a group with media 'ps2' and coerces invalid connector", () => {
    const f = validateDetectedFace({ groups: [{ media: "ps2", connector: "invalid", count: 2, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "high" });
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0].media).toBe("ps2");
    expect(f.groups[0].connector).toBe("PS/2");
  });

  it("keeps a group with media 'sfp+' and normalizes to 'sfp'", () => {
    const f = validateDetectedFace({ groups: [{ media: "sfp+", connector: "SFP", count: 4, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "high" });
    expect(f.groups).toHaveLength(1);
    expect(f.groups[0].media).toBe("sfp");
  });

  it("keeps valid rowOrientations and clamps to the row count", () => {
    const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 24, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, rowOrientations: ["down", "up", "up"] }], confidence: "high" });
    expect(f.groups[0].rowOrientations).toEqual(["down", "up"]); // clamped to rows=2
  });
  it("coerces unknown orientation values to 'down'", () => {
    const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, rowOrientations: ["sideways", "up"] }], confidence: "low" });
    expect(f.groups[0].rowOrientations).toEqual(["down", "up"]);
  });
  it("omits rowOrientations when not an array", () => {
    const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, rowOrientations: "up" }], confidence: "low" });
    expect(f.groups[0].rowOrientations).toBeUndefined();
  });

  it("keeps a valid portTypes entry and coerces its connector", () => {
    const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 24, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, portTypes: [{ index: 22, media: "sfp", connector: "bogus" }] }], confidence: "high" });
    expect(f.groups[0].portTypes).toEqual([{ index: 22, media: "sfp", connector: undefined }]);
  });
  it("drops portTypes entries with unknown media or out-of-range index", () => {
    const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, portTypes: [{ index: 2, media: "banana" }, { index: 99, media: "sfp" }, { index: 3, media: "fiber", connector: "LC" }] }], confidence: "high" });
    expect(f.groups[0].portTypes).toEqual([{ index: 3, media: "fiber", connector: "LC" }]);
  });
  it("keeps only the leading letters of labelPrefix (numbers belong to auto-numbering, not the id prefix)", () => {
    const mk = (lp: unknown) => validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, labelPrefix: lp }], confidence: "high" }).groups[0].labelPrefix;
    expect(mk("Gi1/0")).toBe("Gi");   // strip the port number
    expect(mk("GE")).toBe("GE");      // pure letters kept
    expect(mk("1")).toBeUndefined();  // numbered ports → no prefix
    expect(mk("24")).toBeUndefined();
  });

  it("omits portTypes when not an array", () => {
    const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, portTypes: "nope" }], confidence: "low" });
    expect(f.groups[0].portTypes).toBeUndefined();
  });
});
