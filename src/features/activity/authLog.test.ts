import { describe, it, expect } from "vitest";
import { safeActorEmail, NOT_AN_EMAIL, MAX_EMAIL_LENGTH } from "./authLog";

describe("safeActorEmail", () => {
  it("keeps a normal address, normalised", () => {
    expect(safeActorEmail("Bob@Example.COM")).toBe("bob@example.com");
    expect(safeActorEmail("  bob@example.com  ")).toBe("bob@example.com");
  });

  it("refuses anything that is not shaped like an address", () => {
    // activity_log.actor_email is NOT NULL and the feed renders it whenever there is no member
    // name — which is exactly the unknown-address case. People type passwords into email boxes.
    for (const junk of ["hunter2", "", "   ", "no-at-sign", "@nolocal.com", "no@domain", "a b@c.com"]) {
      expect(safeActorEmail(junk)).toBe(NOT_AN_EMAIL);
    }
  });

  it("refuses a value that is not a string at all", () => {
    for (const junk of [null, undefined, 7, {}, []]) {
      expect(safeActorEmail(junk)).toBe(NOT_AN_EMAIL);
    }
  });

  it("refuses an absurdly long value rather than storing it", () => {
    expect(safeActorEmail("a".repeat(MAX_EMAIL_LENGTH) + "@example.com")).toBe(NOT_AN_EMAIL);
  });

  it("accepts an address right at the limit, so the boundary is not off by one", () => {
    const local = "a".repeat(MAX_EMAIL_LENGTH - "@example.com".length);
    expect(safeActorEmail(`${local}@example.com`)).toBe(`${local}@example.com`);
  });
});
