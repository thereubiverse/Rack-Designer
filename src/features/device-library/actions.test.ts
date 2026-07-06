import { describe, it, expect } from "vitest";
import { validateDeviceTemplateInput, type DeviceTemplateInput } from "./validation";
import { emptyFace } from "@/domain/faceplate";

function input(over: Partial<DeviceTemplateInput> = {}): DeviceTemplateInput {
  return {
    name: "Switch", brandId: null, deviceTypeId: "t1",
    rackUnits: 1, widthIn: 17.5, rackMounted: true,
    frontFace: emptyFace(), backFace: emptyFace(),
    ...over,
  };
}

describe("validateDeviceTemplateInput", () => {
  it("accepts a valid input", () => {
    expect(validateDeviceTemplateInput(input())).toBeNull();
  });
  it("rejects an empty name", () => {
    expect(validateDeviceTemplateInput(input({ name: "  " }))).toMatch(/name/i);
  });
  it("rejects a missing device type", () => {
    expect(validateDeviceTemplateInput(input({ deviceTypeId: "" }))).toMatch(/device type/i);
  });
  it("rejects width <= 0", () => {
    expect(validateDeviceTemplateInput(input({ widthIn: 0 }))).toMatch(/width/i);
  });
  it("rejects rack units < 1", () => {
    expect(validateDeviceTemplateInput(input({ rackUnits: 0 }))).toMatch(/rack units/i);
  });
});
