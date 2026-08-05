import { describe, it, expect } from "vitest";
import { redact, LOGGED_FIELDS, MAX_VALUE_LENGTH } from "./redact";

describe("redact", () => {
  it("keeps only the fields its action allows", () => {
    expect(redact("client.rename", { id: "c1", code: "ACME", name: "Acme", secretSauce: "x" }))
      .toEqual({ code: "ACME", name: "Acme" });
  });

  it("NEVER records a password, even though the form carries three of them", () => {
    // changePasswordAction receives current/next/confirm. This is the whole reason redaction is an
    // allowlist: the log is readable by every member of the company.
    expect(redact("password.change", { current: "hunter2", next: "s3cret", confirm: "s3cret" }))
      .toEqual({});
  });

  it("NEVER records the Gemini API key", () => {
    expect(redact("settings.deviceWizard.update", { apiKey: "AIza-live-key", enabled: "true" }))
      .toEqual({});
  });

  it("NEVER records a phone verification code", () => {
    expect(redact("phone.confirm", { code: "123456" })).toEqual({});
  });

  it("records NOTHING for an action it does not know, rather than everything", () => {
    // The safe direction: an unknown action is a gap in a report, not a credential in a table.
    expect(redact("some.action.added.later", { anything: "at all", password: "leak" })).toEqual({});
  });

  it("survives being handed something that is not an object", () => {
    for (const junk of [null, undefined, "str", 7, []]) {
      expect(redact("client.rename", junk)).toEqual({});
    }
  });

  it("stringifies and truncates, so one pasted essay cannot bloat the table", () => {
    const long = "x".repeat(MAX_VALUE_LENGTH + 50);
    const out = redact("client.rename", { code: long, name: 42 });
    expect(out.code).toHaveLength(MAX_VALUE_LENGTH);
    expect(out.name).toBe("42");
  });

  it("omits absent fields rather than writing empty strings", () => {
    expect(redact("client.rename", { code: "ACME" })).toEqual({ code: "ACME" });
  });
});

describe("the allowlist itself", () => {
  // A guard against the next person adding a field without thinking. Note `code` is deliberately NOT
  // in this list: a client/site/floor code is a short public identifier like ACME, and logging it is
  // the point. The phone verification code is kept out by `phone.confirm` having an EMPTY allowlist,
  // asserted separately below — a name-based rule cannot tell those two `code`s apart.
  const FORBIDDEN = /^(password|current|next|confirm|apikey|api_key|token|secret|auth|credential)$/i;

  it("allows no field whose name is a known secret", () => {
    for (const [action, fields] of Object.entries(LOGGED_FIELDS)) {
      for (const f of fields) {
        expect(FORBIDDEN.test(f), `${action} allows "${f}"`).toBe(false);
      }
    }
  });

  it("keeps the three secret-carrying actions completely empty", () => {
    for (const action of ["password.change", "settings.deviceWizard.update", "phone.confirm"]) {
      expect(LOGGED_FIELDS[action], `${action} must be present and empty`).toEqual([]);
    }
  });
});
