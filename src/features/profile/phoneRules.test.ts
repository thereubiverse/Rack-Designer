import { describe, it, expect } from "vitest";
import {
  toE164, sameNumber, generateCode, cooldownRemainingMs, pendingState,
  CODE_TTL_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS,
} from "./phoneRules";

describe("toE164", () => {
  it("converts the way a person actually types a US number", () => {
    expect(toE164("(718) 555-0142")).toBe("+17185550142");
    expect(toE164("718-555-0142")).toBe("+17185550142");
    expect(toE164("718.555.0142")).toBe("+17185550142");
    expect(toE164(" 7185550142 ")).toBe("+17185550142");
  });

  it("accepts a US number that already carries its country code", () => {
    expect(toE164("1 718 555 0142")).toBe("+17185550142");
    expect(toE164("+1 (718) 555-0142")).toBe("+17185550142");
  });

  it("leaves an explicit international number alone", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses rather than guessing when it cannot be confident", () => {
    // Guessing here means texting a stranger, which is the exact error this feature prevents.
    expect(toE164("555-0142")).toBeNull();   // no area code
    expect(toE164("12345")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("not a phone")).toBeNull();
    expect(toE164("+" + "9".repeat(20))).toBeNull();
    expect(toE164("2 718 555 0142")).toBeNull(); // 11 digits not starting with 1
  });
});

describe("sameNumber", () => {
  it("treats a reformatted number as the same one", () => {
    expect(sameNumber("(718) 555-0142", "718-555-0142")).toBe(true);
    expect(sameNumber("(718) 555-0142", "+17185550142")).toBe(true);
  });

  it("sees a different number as different", () => {
    expect(sameNumber("(718) 555-0142", "(718) 555-0143")).toBe(false);
  });

  it("compares unconvertible values without throwing", () => {
    expect(sameNumber("junk", "junk")).toBe(true);
    expect(sameNumber("junk", "other")).toBe(false);
  });
});

describe("generateCode", () => {
  it("is always six digits", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it("is not a constant", () => {
    const seen = new Set(Array.from({ length: 50 }, generateCode));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("cooldownRemainingMs", () => {
  it("blocks a second send inside the window and reports how long is left", () => {
    expect(cooldownRemainingMs(1_000, 1_000)).toBe(RESEND_COOLDOWN_MS);
    expect(cooldownRemainingMs(1_000, 1_000 + RESEND_COOLDOWN_MS - 1)).toBe(1);
  });

  it("is zero once the window has passed", () => {
    expect(cooldownRemainingMs(1_000, 1_000 + RESEND_COOLDOWN_MS)).toBe(0);
    expect(cooldownRemainingMs(1_000, 9_999_999)).toBe(0);
  });
});

describe("pendingState", () => {
  const fresh = { expiresAtMs: 10_000, attempts: 0 };

  it("is usable before it expires", () => {
    expect(pendingState(fresh, 9_999)).toBe("ok");
  });

  it("expires exactly at the deadline, not after it", () => {
    expect(pendingState(fresh, 10_000)).toBe("expired");
  });

  it("is spent once the attempts are used up", () => {
    expect(pendingState({ expiresAtMs: 10_000, attempts: MAX_ATTEMPTS }, 0)).toBe("spent");
  });

  it("reports expiry ahead of spent-ness when both are true", () => {
    expect(pendingState({ expiresAtMs: 1, attempts: MAX_ATTEMPTS }, 5)).toBe("expired");
  });

  it("has a ten minute lifetime", () => {
    expect(CODE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
