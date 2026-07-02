import { describe, it, expect } from "vitest";
import { isValidCode, isValidRackHeight, ROOM_TYPES } from "./hierarchy";

describe("isValidCode", () => {
  it("accepts alphanumeric, underscore, and hyphen", () => {
    expect(isValidCode("RK001_M")).toBe(true);
    expect(isValidCode("HQ-2")).toBe(true);
  });
  it("rejects slashes and empty strings", () => {
    expect(isValidCode("HQ/28")).toBe(false);
    expect(isValidCode("")).toBe(false);
    expect(isValidCode("has space")).toBe(false);
  });
});

describe("isValidRackHeight", () => {
  it("accepts 1..60", () => {
    expect(isValidRackHeight(42)).toBe(true);
    expect(isValidRackHeight(1)).toBe(true);
  });
  it("rejects zero, negatives, non-integers, and over 60", () => {
    expect(isValidRackHeight(0)).toBe(false);
    expect(isValidRackHeight(-5)).toBe(false);
    expect(isValidRackHeight(12.5)).toBe(false);
    expect(isValidRackHeight(61)).toBe(false);
  });
});

describe("ROOM_TYPES", () => {
  it("lists the three room types", () => {
    expect(ROOM_TYPES).toEqual(["MDF", "IDF", "other"]);
  });
});
