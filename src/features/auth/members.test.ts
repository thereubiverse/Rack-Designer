import { describe, it, expect } from "vitest";
import { normaliseEmail, memberDecision, NOT_A_MEMBER, type Member } from "./members";

const member = (over: Partial<Member> = {}): Member => ({
  id: "m1",
  email: "bob@example.com",
  name: "Bob",
  authUserId: "au1",
  disabledAt: null,
  avatarPath: null,
  role: "admin",
  orgId: "00000000-0000-0000-0000-000000000001",
  ...over,
});

describe("normaliseEmail", () => {
  it("lowercases and trims, so a sign-in matches the invite however it was typed", () => {
    expect(normaliseEmail("  Bob@Example.COM ")).toBe("bob@example.com");
  });

  it("leaves an already-normal address alone", () => {
    expect(normaliseEmail("bob@example.com")).toBe("bob@example.com");
  });
});

describe("memberDecision", () => {
  it("allows an active member and hands the row back", () => {
    const d = memberDecision(member());
    expect(d.allowed).toBe(true);
    if (!d.allowed) throw new Error("unreachable");
    expect(d.member.email).toBe("bob@example.com");
  });

  it("REFUSES someone who was never invited", () => {
    // The whole point: authenticating with Google does not make you a member.
    expect(memberDecision(null).allowed).toBe(false);
    expect(memberDecision(undefined).allowed).toBe(false);
  });

  it("REFUSES a revoked member", () => {
    expect(memberDecision(member({ disabledAt: "2026-08-01T00:00:00Z" })).allowed).toBe(false);
  });

  it("allows a member who has never signed in before", () => {
    // Invited but no auth_user_id yet — the normal state on someone's first sign-in.
    expect(memberDecision(member({ authUserId: null })).allowed).toBe(true);
  });
});

describe("NOT_A_MEMBER", () => {
  it("is one message that does not distinguish the three refusal reasons", () => {
    // Saying "revoked" vs "never invited" vs "no such account" tells an outsider which addresses
    // are real. All three refusals use this exact string.
    expect(NOT_A_MEMBER).toBe("That account doesn't have access to this app. Ask an administrator to invite you.");
    expect(NOT_A_MEMBER).not.toMatch(/revoked|disabled|unknown|not found|never/i);
  });
});
