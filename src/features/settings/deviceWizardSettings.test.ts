import { describe, it, expect, beforeEach, vi } from "vitest";
import { readDeviceWizardSettings, writeDeviceWizardSettings, resolveGeminiKey, KEY_ENABLED, KEY_GEMINI } from "./deviceWizardSettings";
import type { SettingsStore } from "./store";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG_ID = "00000000-0000-0000-0000-000000000002";

// Records the org id every call arrives with, so a test can assert it is the one that was passed
// in — a store that discards its orgId argument (or a caller that hardcodes/drops it) would leave
// `orgIdsSeen` wrong even though every read/write still "worked".
function fakeStore(initial: Record<string, string> = {}): SettingsStore & { data: Record<string, string>; orgIdsSeen: string[] } {
  const data = { ...initial };
  const orgIdsSeen: string[] = [];
  return {
    data,
    orgIdsSeen,
    get: vi.fn(async (orgId: string, k: string) => { orgIdsSeen.push(orgId); return k in data ? data[k] : null; }),
    set: vi.fn(async (orgId: string, k: string, v: string) => { orgIdsSeen.push(orgId); data[k] = v; }),
    del: vi.fn(async (orgId: string, k: string) => { orgIdsSeen.push(orgId); delete data[k]; }),
  };
}

describe("readDeviceWizardSettings", () => {
  it("reports enabled + hasKey from stored values", async () => {
    const s = fakeStore({ [KEY_ENABLED]: "true", [KEY_GEMINI]: "sk-abc" });
    expect(await readDeviceWizardSettings(s, ORG_ID)).toEqual({ enabled: true, hasKey: true });
    expect(s.orgIdsSeen).toEqual([ORG_ID, ORG_ID]);
  });
  it("defaults to disabled + no key when unset", async () => {
    expect(await readDeviceWizardSettings(fakeStore(), ORG_ID)).toEqual({ enabled: false, hasKey: false });
  });
  it("treats a blank key as no key", async () => {
    const s = fakeStore({ [KEY_GEMINI]: "   " });
    expect((await readDeviceWizardSettings(s, ORG_ID)).hasKey).toBe(false);
  });
  it("passes a different org id straight through, not a hardcoded one", async () => {
    const s = fakeStore({ [KEY_ENABLED]: "true" });
    await readDeviceWizardSettings(s, OTHER_ORG_ID);
    expect(s.orgIdsSeen.every((id) => id === OTHER_ORG_ID)).toBe(true);
    expect(s.orgIdsSeen).not.toContain(ORG_ID);
  });
});

describe("writeDeviceWizardSettings", () => {
  it("writes the enabled flag as a string", async () => {
    const s = fakeStore();
    await writeDeviceWizardSettings(s, { enabled: true }, ORG_ID);
    expect(s.data[KEY_ENABLED]).toBe("true");
    expect(s.orgIdsSeen).toEqual([ORG_ID]);
  });
  it("stores a trimmed key and deletes on empty", async () => {
    const s = fakeStore();
    await writeDeviceWizardSettings(s, { apiKey: "  sk-xyz  " }, ORG_ID);
    expect(s.data[KEY_GEMINI]).toBe("sk-xyz");
    await writeDeviceWizardSettings(s, { apiKey: "" }, ORG_ID);
    expect(KEY_GEMINI in s.data).toBe(false);
  });
  it("leaves fields untouched when not in the patch", async () => {
    const s = fakeStore({ [KEY_ENABLED]: "true" });
    await writeDeviceWizardSettings(s, { apiKey: "sk-1" }, ORG_ID);
    expect(s.data[KEY_ENABLED]).toBe("true");
  });
  it("carries a different org id to every store call, not a dropped or hardcoded one", async () => {
    const s = fakeStore();
    await writeDeviceWizardSettings(s, { enabled: true, apiKey: "sk-1" }, OTHER_ORG_ID);
    expect(s.orgIdsSeen.length).toBeGreaterThan(0);
    expect(s.orgIdsSeen.every((id) => id === OTHER_ORG_ID)).toBe(true);
  });
});

describe("resolveGeminiKey", () => {
  const OLD = process.env.GEMINI_API_KEY;
  beforeEach(() => { delete process.env.GEMINI_API_KEY; });
  it("prefers the DB key", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    expect(await resolveGeminiKey(fakeStore({ [KEY_GEMINI]: "db-key" }), ORG_ID)).toBe("db-key");
  });
  it("falls back to the env key", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    expect(await resolveGeminiKey(fakeStore(), ORG_ID)).toBe("env-key");
  });
  it("returns null when neither is set", async () => {
    expect(await resolveGeminiKey(fakeStore(), ORG_ID)).toBeNull();
  });
  it("looks the key up under whichever org id is passed in", async () => {
    const s = fakeStore({ [KEY_GEMINI]: "db-key" });
    expect(await resolveGeminiKey(s, OTHER_ORG_ID)).toBe("db-key");
    expect(s.orgIdsSeen).toEqual([OTHER_ORG_ID]);
  });
});
