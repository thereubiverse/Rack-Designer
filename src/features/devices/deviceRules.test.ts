import { describe, it, expect } from "vitest";
import {
  generateDeviceToken, hashDeviceToken, generateCode, deviceLabel,
  challengeState, cooldownRemainingMs, MAX_ATTEMPTS, RESEND_COOLDOWN_MS,
} from "./deviceRules";

describe("generateDeviceToken", () => {
  it("is long, url-safe, and never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, generateDeviceToken));
    expect(seen.size).toBe(200);
    for (const t of seen) expect(t).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe("hashDeviceToken", () => {
  it("is stable for the same token and different for another", () => {
    const a = generateDeviceToken();
    expect(hashDeviceToken(a)).toBe(hashDeviceToken(a));
    expect(hashDeviceToken(a)).not.toBe(hashDeviceToken(generateDeviceToken()));
  });

  it("does not contain the token — a database dump must not yield working cookies", () => {
    const a = generateDeviceToken();
    expect(hashDeviceToken(a)).not.toContain(a);
    expect(hashDeviceToken(a)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("generateCode", () => {
  it("is six digits and varies", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
    expect(new Set(Array.from({ length: 50 }, generateCode)).size).toBeGreaterThan(1);
  });
});

describe("deviceLabel", () => {
  it("names something a person would recognise", () => {
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"))
      .toMatch(/Chrome.*Mac/i);
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"))
      .toMatch(/iPhone|Safari/i);
  });

  it("falls back rather than throwing on junk, null or empty", () => {
    for (const junk of [null, undefined, "", "   ", "!!!"]) {
      expect(deviceLabel(junk).length).toBeGreaterThan(0);
    }
  });

  it("never returns something enormous, whatever the header says", () => {
    expect(deviceLabel("x".repeat(5000)).length).toBeLessThanOrEqual(80);
  });
});

describe("challengeState", () => {
  const fresh = { expiresAtMs: 10_000, attempts: 0 };
  it("is usable before it expires", () => expect(challengeState(fresh, 9_999)).toBe("ok"));
  it("expires exactly at the deadline", () => expect(challengeState(fresh, 10_000)).toBe("expired"));
  it("is spent once attempts are used", () =>
    expect(challengeState({ expiresAtMs: 10_000, attempts: MAX_ATTEMPTS }, 0)).toBe("spent"));
  it("reports expiry ahead of spent when both are true", () =>
    expect(challengeState({ expiresAtMs: 1, attempts: MAX_ATTEMPTS }, 5)).toBe("expired"));
});

describe("cooldownRemainingMs", () => {
  it("blocks a second send inside the window and is zero after", () => {
    expect(cooldownRemainingMs(1_000, 1_000)).toBe(RESEND_COOLDOWN_MS);
    expect(cooldownRemainingMs(1_000, 1_000 + RESEND_COOLDOWN_MS)).toBe(0);
  });
});
