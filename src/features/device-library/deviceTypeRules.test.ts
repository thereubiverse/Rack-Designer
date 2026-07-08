import { describe, it, expect } from "vitest";
import { normalizeCode, validateCode, validateTypeName, CODE_HELP } from "./deviceTypeRules";

describe("normalizeCode", () => {
  it("uppercases, strips non-alphanumerics, and caps at 4 chars", () => {
    expect(normalizeCode("sw")).toBe("SW");
    expect(normalizeCode(" 3d-p! ")).toBe("3DP");
    expect(normalizeCode("switch")).toBe("SWIT");
  });
});

describe("validateCode", () => {
  it("accepts 1-4 uppercase alphanumerics", () => {
    expect(validateCode("SW")).toBeNull();
    expect(validateCode("3DP")).toBeNull();
    expect(validateCode("MISC")).toBeNull();
  });
  it("rejects empty, too-long, lowercase, and symbols", () => {
    expect(validateCode("")).toBe(CODE_HELP);
    expect(validateCode("TOOLONG")).toBe(CODE_HELP);
    expect(validateCode("sw")).toBe(CODE_HELP);
    expect(validateCode("S-W")).toBe(CODE_HELP);
  });
});

describe("validateTypeName", () => {
  it("requires a non-blank name", () => {
    expect(validateTypeName("Media Converter")).toBeNull();
    expect(validateTypeName("   ")).toBe("Name is required");
  });
});
