import { describe, it, expect } from "vitest";
import { summarise, actionLabel } from "./summarise";

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

describe("actionLabel", () => {
  it("gives a short human label for the filter menu", () => {
    expect(actionLabel("client.rename")).toMatch(/client/i);
    expect(actionLabel("unknown.key")).toBe("unknown.key");
  });
});
