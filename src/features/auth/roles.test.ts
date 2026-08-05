import { describe, it, expect } from "vitest";
import {
  isRole, satisfies, wouldLeaveNoAdmin, ROLES, type Role,
  isRefusal, NEEDS_EDITOR, NEEDS_ADMIN, LAST_ADMIN, CANNOT_CHANGE_OWN_ROLE, CANNOT_REVOKE_SELF,
} from "./roles";

describe("isRole", () => {
  it("accepts the three real roles and nothing else", () => {
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    for (const junk of ["superuser", "", "Admin", null, undefined, 7]) {
      expect(isRole(junk)).toBe(false);
    }
  });
});

describe("satisfies", () => {
  it("treats a requirement as a MINIMUM, so an admin passes an editor check", () => {
    expect(satisfies("admin", "editor")).toBe(true);
    expect(satisfies("admin", "viewer")).toBe(true);
    expect(satisfies("editor", "viewer")).toBe(true);
  });

  it("lets each role satisfy its own requirement", () => {
    for (const r of ROLES) expect(satisfies(r, r)).toBe(true);
  });

  it("refuses to promote anyone upward", () => {
    expect(satisfies("viewer", "editor")).toBe(false);
    expect(satisfies("viewer", "admin")).toBe(false);
    expect(satisfies("editor", "admin")).toBe(false);
  });
});

describe("wouldLeaveNoAdmin", () => {
  const active = (role: Role) => ({ role, disabledAt: null });
  const revoked = (role: Role) => ({ role, disabledAt: "2026-01-01T00:00:00Z" });

  it("blocks demoting the only admin", () => {
    expect(wouldLeaveNoAdmin([active("admin"), active("editor")], { from: "admin", to: "editor" })).toBe(true);
  });

  it("blocks revoking the only admin", () => {
    expect(wouldLeaveNoAdmin([active("admin")], { from: "admin", to: "revoked" })).toBe(true);
  });

  it("allows it when a second ACTIVE admin remains", () => {
    expect(wouldLeaveNoAdmin([active("admin"), active("admin")], { from: "admin", to: "editor" })).toBe(false);
  });

  it("does not count a REVOKED admin as cover — they cannot sign in to fix anything", () => {
    expect(wouldLeaveNoAdmin([active("admin"), revoked("admin")], { from: "admin", to: "viewer" })).toBe(true);
  });

  it("does not block changing an admin who is ALREADY revoked — they were never in the count", () => {
    // The sole active admin tidying up a revoked ex-admin's row must not be told there has to be at
    // least one active admin.
    expect(wouldLeaveNoAdmin(
      [active("admin"), revoked("admin")],
      { from: "admin", to: "viewer", fromDisabled: true }
    )).toBe(false);
  });

  it("does not care when the person changing is not an admin", () => {
    expect(wouldLeaveNoAdmin([active("admin"), active("editor")], { from: "editor", to: "viewer" })).toBe(false);
    expect(wouldLeaveNoAdmin([active("admin"), active("viewer")], { from: "viewer", to: "revoked" })).toBe(false);
  });

  it("allows promoting someone TO admin, which can never reduce the count", () => {
    expect(wouldLeaveNoAdmin([active("admin"), active("editor")], { from: "editor", to: "admin" })).toBe(false);
  });
});

describe("isRefusal", () => {
  it("recognises every rule-refusal message", () => {
    for (const msg of [NEEDS_EDITOR, NEEDS_ADMIN, LAST_ADMIN, CANNOT_CHANGE_OWN_ROLE, CANNOT_REVOKE_SELF]) {
      expect(isRefusal(msg)).toBe(true);
    }
  });

  it("does not treat a validation message as a refusal", () => {
    expect(isRefusal("Enter an email address.")).toBe(false);
  });

  it("does not treat undefined as a refusal", () => {
    expect(isRefusal(undefined)).toBe(false);
  });
});
