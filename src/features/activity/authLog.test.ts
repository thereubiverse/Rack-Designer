import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked one level DOWN, at the repository, so logAuthEvent's own body actually runs. Mocking
// logAuthEvent itself — which every call-site test does — would leave the line that applies
// safeActorEmail untested, and replacing it with String(e.email) would keep the whole suite green
// while writing the next mistyped password verbatim into a table every member reads.
const writeEntry = vi.fn();
vi.mock("./repository", () => ({ writeEntry: (...a: unknown[]) => writeEntry(...a) }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => ({}) }));

import { safeActorEmail, logAuthEvent, NOT_AN_EMAIL, MAX_EMAIL_LENGTH } from "./authLog";

beforeEach(() => {
  vi.clearAllMocks();
  writeEntry.mockResolvedValue(undefined);
});

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

describe("logAuthEvent", () => {
  const entry = () => writeEntry.mock.calls[0][1] as Record<string, unknown>;

  it("puts the submitted address through safeActorEmail before it is stored", () => {
    // The one that stops someone "simplifying" this to String(e.email).
    return logAuthEvent({
      action: "auth.signIn", outcome: "refused", method: "password", email: "hunter2",
    }).then(() => {
      expect(writeEntry).toHaveBeenCalledTimes(1);
      expect(entry().actorEmail).toBe(NOT_AN_EMAIL);
    });
  });

  it("keeps a real address intact", async () => {
    await logAuthEvent({
      action: "auth.signIn", outcome: "ok", method: "google",
      email: "Bob@Example.com", memberId: "m1", memberName: "Bob",
    });
    expect(entry().actorEmail).toBe("bob@example.com");
    expect(entry().memberId).toBe("m1");
    expect(entry().actorName).toBe("Bob");
  });

  it("passes details through the allowlist rather than writing them raw", async () => {
    // The extra field is not part of the call's type — a future caller could add one, and redact
    // must drop it. Cast through unknown because that is precisely the point: this is a shape the
    // types do not allow, and the runtime guard is what has to hold.
    const withExtra = {
      action: "auth.signIn", outcome: "ok", method: "password", email: "bob@example.com",
      password: "hunter2",
    } as unknown as Parameters<typeof logAuthEvent>[0];
    await logAuthEvent(withExtra);
    expect(entry().details).toEqual({ method: "password" });
  });

  it("does NOT reject when the write fails — recording a sign-in must never prevent one", async () => {
    writeEntry.mockRejectedValue(new Error("database is down"));
    await expect(
      logAuthEvent({ action: "auth.signOut", outcome: "ok", email: "bob@example.com" })
    ).resolves.toBeUndefined();
  });
});
