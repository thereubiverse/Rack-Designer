import { describe, it, expect } from "vitest";
import {
  deviceTypeIcon,
  DEFAULT_DEVICE_ICON,
  deviceTypeColor,
  DEFAULT_DEVICE_COLOR,
  resolveTypeIcon,
  resolveTypeColor,
} from "./deviceTypeIcons";

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

describe("deviceTypeColor", () => {
  it("maps known type codes to a colour, case-insensitively", () => {
    expect(deviceTypeColor("CAM")).toBe("#dc2626");
    expect(deviceTypeColor("ap")).toBe("#2563eb");
  });

  it("falls back to the default colour for unmapped or missing codes", () => {
    expect(deviceTypeColor("ZZZ")).toBe(DEFAULT_DEVICE_COLOR);
    expect(deviceTypeColor(null)).toBe(DEFAULT_DEVICE_COLOR);
    expect(deviceTypeColor(undefined)).toBe(DEFAULT_DEVICE_COLOR);
  });
});

describe("resolveTypeIcon / resolveTypeColor", () => {
  it("prefer a type's stored override, else fall back to the code default", () => {
    expect(resolveTypeIcon({ code: "CAM", icon: "tabler:star" })).toBe("tabler:star");
    expect(resolveTypeIcon({ code: "CAM", icon: null })).toBe("tabler:camera");
    expect(resolveTypeColor({ code: "CAM", color: "#123456" })).toBe("#123456");
    expect(resolveTypeColor({ code: "CAM", color: null })).toBe("#dc2626");
  });
});
