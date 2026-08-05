// @vitest-environment node
import { describe, it, expect } from "vitest";
import { hashDeviceTokenEdge } from "./middleware";
import { generateDeviceToken, hashDeviceToken } from "./features/devices/deviceRules";

/** The device hash exists TWICE, and it has to: actions.ts writes it with node:crypto, while the
 *  middleware runs on the Edge runtime where node:crypto is unavailable and must use crypto.subtle.
 *
 *  Nothing else forces them to agree. If they ever drift, the stored hash stops matching the one the
 *  middleware computes, `is_device_trusted` returns false for every device, and every member is
 *  redirected to /verify-device forever — including the admin who would fix it. The failure is
 *  total, silent, and identical to "nobody has an approved device".
 *
 *  A comment saying the two were checked once is not a guard. This is. */
describe("the two device-hash implementations", () => {
  it("agree, over many random tokens", async () => {
    for (let i = 0; i < 50; i++) {
      const token = generateDeviceToken();
      expect(await hashDeviceTokenEdge(token)).toBe(hashDeviceToken(token));
    }
  });

  it("agree on awkward input, not just the happy path", async () => {
    for (const token of ["", " ", "a", "ünïcødé-token", "x".repeat(4096), "tab\tand\nnewline"]) {
      expect(await hashDeviceTokenEdge(token)).toBe(hashDeviceToken(token));
    }
  });

  it("both produce a 64-character lowercase hex digest", async () => {
    const token = generateDeviceToken();
    expect(await hashDeviceTokenEdge(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashDeviceToken(token)).toMatch(/^[a-f0-9]{64}$/);
  });
});
