import { describe, it, expect } from "vitest";
import { buildLabel } from "./naming";

describe("buildLabel", () => {
  it("builds a full port-level path", () => {
    expect(
      buildLabel({ site: "HQ", floor: "28", room: "SL", rack: "RK001_M", device: "D", port: 17 })
    ).toBe("HQ/28/SL/RK001_M/D/17");
  });

  it("builds a rack-level path", () => {
    expect(buildLabel({ site: "HQ", floor: "28", room: "SL", rack: "RK001_M" })).toBe(
      "HQ/28/SL/RK001_M"
    );
  });

  it("builds a site-only path", () => {
    expect(buildLabel({ site: "HQ" })).toBe("HQ");
  });

  it("stops at the first missing level (room without floor is ignored)", () => {
    expect(buildLabel({ site: "HQ", room: "SL" })).toBe("HQ");
  });

  it("ignores a port when there is no device", () => {
    expect(buildLabel({ site: "HQ", floor: "28", room: "SL", rack: "RK001_M", port: 17 })).toBe(
      "HQ/28/SL/RK001_M"
    );
  });
});
