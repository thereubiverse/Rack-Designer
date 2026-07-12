import { describe, it, expect, beforeEach, vi } from "vitest";
import { readDeviceWizardSettings, writeDeviceWizardSettings, resolveGeminiKey, KEY_ENABLED, KEY_GEMINI } from "./deviceWizardSettings";
import type { SettingsStore } from "./store";

function fakeStore(initial: Record<string, string> = {}): SettingsStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get: vi.fn(async (k: string) => (k in data ? data[k] : null)),
    set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
    del: vi.fn(async (k: string) => { delete data[k]; }),
  };
}

describe("readDeviceWizardSettings", () => {
  it("reports enabled + hasKey from stored values", async () => {
    const s = fakeStore({ [KEY_ENABLED]: "true", [KEY_GEMINI]: "sk-abc" });
    expect(await readDeviceWizardSettings(s)).toEqual({ enabled: true, hasKey: true });
  });
  it("defaults to disabled + no key when unset", async () => {
    expect(await readDeviceWizardSettings(fakeStore())).toEqual({ enabled: false, hasKey: false });
  });
  it("treats a blank key as no key", async () => {
    const s = fakeStore({ [KEY_GEMINI]: "   " });
    expect((await readDeviceWizardSettings(s)).hasKey).toBe(false);
  });
});

describe("writeDeviceWizardSettings", () => {
  it("writes the enabled flag as a string", async () => {
    const s = fakeStore();
    await writeDeviceWizardSettings(s, { enabled: true });
    expect(s.data[KEY_ENABLED]).toBe("true");
  });
  it("stores a trimmed key and deletes on empty", async () => {
    const s = fakeStore();
    await writeDeviceWizardSettings(s, { apiKey: "  sk-xyz  " });
    expect(s.data[KEY_GEMINI]).toBe("sk-xyz");
    await writeDeviceWizardSettings(s, { apiKey: "" });
    expect(KEY_GEMINI in s.data).toBe(false);
  });
  it("leaves fields untouched when not in the patch", async () => {
    const s = fakeStore({ [KEY_ENABLED]: "true" });
    await writeDeviceWizardSettings(s, { apiKey: "sk-1" });
    expect(s.data[KEY_ENABLED]).toBe("true");
  });
});

describe("resolveGeminiKey", () => {
  const OLD = process.env.GEMINI_API_KEY;
  beforeEach(() => { delete process.env.GEMINI_API_KEY; });
  it("prefers the DB key", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    expect(await resolveGeminiKey(fakeStore({ [KEY_GEMINI]: "db-key" }))).toBe("db-key");
  });
  it("falls back to the env key", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    expect(await resolveGeminiKey(fakeStore())).toBe("env-key");
  });
  it("returns null when neither is set", async () => {
    expect(await resolveGeminiKey(fakeStore())).toBeNull();
  });
});
