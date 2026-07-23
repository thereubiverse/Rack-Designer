import { describe, it, expect } from "vitest";
import { normaliseCode, validateCode, describeCascade, requiresTypedConfirm } from "./validation";

describe("normaliseCode", () => {
  it("uppercases and trims so codes are stored one way", () => {
    expect(normaliseCode("  acme ")).toBe("ACME");
  });
});

describe("validateCode", () => {
  it("accepts letters, digits, dash and underscore", () => {
    expect(validateCode("ACME-1_A", "client")).toBeNull();
  });
  it("rejects an empty code, naming the kind", () => {
    expect(validateCode("  ", "client")).toBe("Client code is required");
  });
  it("rejects characters outside the allowed set, naming the kind", () => {
    expect(validateCode("AC ME", "site")).toBe("Site code can only use letters, numbers, - and _");
  });
  it("accepts a floor code", () => {
    expect(validateCode("gf", "floor")).toBeNull();
  });
  it("rejects an empty device code, naming the kind", () => {
    expect(validateCode("", "device")).toBe("Device code is required");
  });
});

describe("describeCascade", () => {
  it("lists only the non-zero parts, pluralised", () => {
    expect(describeCascade({ sites: 3, racks: 7, devices: 41 })).toBe("3 sites, 7 racks and 41 devices");
    expect(describeCascade({ sites: 1, racks: 1, devices: 0 })).toBe("1 site and 1 rack");
  });
  it("says nothing is affected when the subtree is empty", () => {
    expect(describeCascade({})).toBe("nothing else");
  });
  it("includes rooms between sites and racks, pluralised", () => {
    expect(describeCascade({ rooms: 2, racks: 1, devices: 3 })).toBe("2 rooms, 1 rack and 3 devices");
  });
  it("singularises a lone room", () => {
    expect(describeCascade({ rooms: 1 })).toBe("1 room");
  });
});

describe("requiresTypedConfirm", () => {
  it("only demands the typed code when something would actually be destroyed", () => {
    expect(requiresTypedConfirm({})).toBe(false);
    expect(requiresTypedConfirm({ sites: 0, racks: 0 })).toBe(false);
    expect(requiresTypedConfirm({ racks: 1 })).toBe(true);
  });
});
