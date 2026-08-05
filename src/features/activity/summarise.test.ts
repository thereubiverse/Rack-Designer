import { describe, it, expect } from "vitest";
import { summarise, actionLabel, VERBS } from "./summarise";
import { LOGGED_FIELDS } from "./redact";

const ok = (action: string, details: Record<string, string> = {}) =>
  summarise({ action, details, outcome: "ok" as const });

describe("summarise", () => {
  it("names the thing that changed when the details carry it", () => {
    expect(ok("client.rename", { code: "ACME", name: "Acme Corp" })).toContain("ACME");
    expect(ok("client.rename", { code: "ACME", name: "Acme Corp" })).toMatch(/renamed/i);
  });

  it("still reads sensibly with no details at all", () => {
    const s = ok("password.change");
    expect(s).toMatch(/password/i);
    expect(s.length).toBeGreaterThan(0);
  });

  it("falls back to the key for an action it does not know, rather than throwing", () => {
    expect(ok("some.action.added.later")).toContain("some.action.added.later");
  });

  it("reads differently for a refusal than for a success", () => {
    const a = summarise({ action: "client.rename", details: { code: "ACME" }, outcome: "ok" });
    const b = summarise({ action: "client.rename", details: { code: "ACME" }, outcome: "refused" });
    expect(a).not.toBe(b);
    expect(b).toMatch(/not allowed|refused|denied/i);
  });

  it("marks a failure as attempted, not done", () => {
    const s = summarise({ action: "client.rename", details: {}, outcome: "failed" });
    expect(s).toMatch(/tried|failed|attempt/i);
  });
});

describe("summarise: auth.signIn / auth.signOut", () => {
  // The generic verb/noun composition reads badly for these two ("Not allowed to signed in"), so
  // they are special-cased in summarise() — these strings are pinned exactly, not just matched.
  it("renders a successful sign-in per method", () => {
    expect(ok("auth.signIn", { method: "password" })).toBe("Signed in with a password");
    expect(ok("auth.signIn", { method: "google" })).toBe("Signed in with Google");
    expect(ok("auth.signIn", { method: "azure" })).toBe("Signed in with Microsoft");
  });

  it("renders a refused sign-in per method", () => {
    const refused = (details: Record<string, string>) =>
      summarise({ action: "auth.signIn", details, outcome: "refused" as const });
    expect(refused({ method: "password" })).toBe("Sign-in refused (password)");
    expect(refused({ method: "google" })).toBe("Sign-in refused (Google)");
    expect(refused({ method: "azure" })).toBe("Sign-in refused (Microsoft)");
  });

  it("renders a failed sign-in", () => {
    expect(summarise({ action: "auth.signIn", details: { method: "password" }, outcome: "failed" }))
      .toBe("Sign-in failed (password)");
  });

  it("renders a successful sign-out", () => {
    expect(ok("auth.signOut", { method: "password" })).toBe("Signed out");
  });

  it("still reads sensibly when details carries no method at all", () => {
    const s = ok("auth.signIn", {});
    expect(s).not.toMatch(/undefined/);
    expect(s.length).toBeGreaterThan(0);
  });
});

describe("actionLabel", () => {
  it("gives a short human label for the filter menu", () => {
    expect(actionLabel("client.rename")).toMatch(/client/i);
    expect(actionLabel("unknown.key")).toBe("unknown.key");
  });
});

describe("VERBS drift guard", () => {
  // Every loggable action ought to render as a real sentence, not its raw key. summarise() falls
  // back gracefully when an entry is missing (see the comment atop this file), so a gap here would
  // not throw or fail any other test — this is the one test standing between "added a new logged
  // action" and it silently rendering as a raw key like "client.delete" in the feed forever.
  it("has a VERBS entry for every action key LOGGED_FIELDS knows about", () => {
    const missing = Object.keys(LOGGED_FIELDS).filter((key) => !(key in VERBS));
    expect(missing).toEqual([]);
  });
});
