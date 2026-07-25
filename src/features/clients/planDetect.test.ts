import { describe, it, expect } from "vitest";
import {
  FLOOR_TYPE_CODES, coerceTypeCode, validateRoomDiscovery, validateDeviceDiscovery,
} from "./planDetect";

describe("coerceTypeCode", () => {
  it("passes known floor codes through (case-insensitive)", () => {
    expect(coerceTypeCode("CAM")).toBe("CAM");
    expect(coerceTypeCode("ap")).toBe("AP");
  });
  it("maps common synonyms", () => {
    expect(coerceTypeCode("access point")).toBe("AP");
    expect(coerceTypeCode("wap")).toBe("AP");
    expect(coerceTypeCode("outlet")).toBe("TO");
    expect(coerceTypeCode("display")).toBe("SCR");
  });
  it("falls back to TO for unknown/garbage", () => {
    for (const v of ["banana", "", null, 42, {}]) expect(coerceTypeCode(v)).toBe("TO");
  });
  it("only ever returns a real floor code", () => {
    expect(FLOOR_TYPE_CODES).toContain(coerceTypeCode("whatever"));
  });
});

describe("validateDeviceDiscovery", () => {
  it("clamps coordinates into 0..1 and keeps the 0-edge", () => {
    const out = validateDeviceDiscovery({ devices: [
      { label: "CAM01", typeCode: "CAM", x: 1.4, y: -0.2, confidence: "high" },
      { label: "TO01", typeCode: "TO", x: 0, y: 0, confidence: "medium" },
    ] });
    expect(out).toHaveLength(2);
    expect(out[0].point).toEqual([1, 0]);   // clamped
    expect(out[1].point).toEqual([0, 0]);   // 0-edge is real (Null Island)
    expect(out[0].id).toBe("dev-0");
  });
  it("drops points that aren't two finite numbers, never throws", () => {
    const out = validateDeviceDiscovery({ devices: [
      { label: "A", typeCode: "AP", x: "nope", y: 0.5 },
      { label: "B", typeCode: "AP", x: NaN, y: 0.5 },
      { label: "C", typeCode: "AP", x: 0.5, y: 0.5 },
    ] });
    expect(out.map((d) => d.label)).toEqual(["C"]);
  });
  it("coerces unknown types to TO and defaults confidence to low", () => {
    const out = validateDeviceDiscovery({ devices: [{ label: "X", typeCode: "spaceship", x: 0.5, y: 0.5 }] });
    expect(out[0].typeCode).toBe("TO");
    expect(out[0].confidence).toBe("low");
  });
  it("never throws on garbage and caps at 40", () => {
    expect(validateDeviceDiscovery(null)).toEqual([]);
    expect(validateDeviceDiscovery({ devices: "x" })).toEqual([]);
    const many = { devices: Array.from({ length: 50 }, (_, i) => ({ label: `D${i}`, typeCode: "TO", x: 0.5, y: 0.5 })) };
    expect(validateDeviceDiscovery(many)).toHaveLength(40);
  });
});

describe("validateRoomDiscovery", () => {
  it("keeps rooms with >=3 valid clamped vertices, ids room-N", () => {
    const out = validateRoomDiscovery({ rooms: [
      { name: "MDF", roomType: "MDF", polygon: [[0, 0], [1, 0], [0.5, 1.3]], confidence: "high" },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].polygon).toEqual([[0, 0], [1, 0], [0.5, 1]]); // last y clamped
    expect(out[0].id).toBe("room-0");
    expect(out[0].roomType).toBe("MDF");
  });
  it("drops polygons under 3 valid vertices and coerces bad room types to other", () => {
    const out = validateRoomDiscovery({ rooms: [
      { name: "Too small", roomType: "other", polygon: [[0, 0], [1, 1]] },
      { name: "Bad type", roomType: "closet", polygon: [[0, 0], [1, 0], [1, 1]] },
    ] });
    expect(out.map((r) => r.name)).toEqual(["Bad type"]);
    expect(out[0].roomType).toBe("other");
  });
  it("never throws on garbage", () => {
    expect(validateRoomDiscovery(undefined)).toEqual([]);
    expect(validateRoomDiscovery({ rooms: [null, 3, "x"] })).toEqual([]);
  });
});
