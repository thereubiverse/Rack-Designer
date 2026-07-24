import { describe, it, expect } from "vitest";
import { deviceTypeIcon, DEFAULT_DEVICE_ICON } from "./deviceTypeIcons";

describe("deviceTypeIcon", () => {
  it("maps known type codes to their icon, case-insensitively", () => {
    expect(deviceTypeIcon("CAM")).toBe("tabler:camera");
    expect(deviceTypeIcon("ap")).toBe("tabler:wifi");
    expect(deviceTypeIcon("3DP")).toBe("tabler:cube");
    expect(deviceTypeIcon("SW")).toBe("tabler:switch-horizontal");
  });

  it("falls back to the default glyph for unmapped or missing codes", () => {
    expect(deviceTypeIcon("ZZZ")).toBe(DEFAULT_DEVICE_ICON);
    expect(deviceTypeIcon("")).toBe(DEFAULT_DEVICE_ICON);
    expect(deviceTypeIcon(null)).toBe(DEFAULT_DEVICE_ICON);
    expect(deviceTypeIcon(undefined)).toBe(DEFAULT_DEVICE_ICON);
  });
});
