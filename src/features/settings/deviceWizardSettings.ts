import "server-only"; // reads GEMINI_API_KEY / returns the raw key via resolveGeminiKey — never import from the client
import type { SettingsStore } from "./store";

export const KEY_ENABLED = "device_wizard.enabled";
export const KEY_GEMINI = "device_wizard.gemini_api_key";

export interface DeviceWizardSettings { enabled: boolean; hasKey: boolean }

export async function readDeviceWizardSettings(
  store: SettingsStore, orgId: string
): Promise<DeviceWizardSettings> {
  const [enabled, key] = await Promise.all([store.get(orgId, KEY_ENABLED), store.get(orgId, KEY_GEMINI)]);
  // hasKey reflects the DB key only (what the settings UI manages). A GEMINI_API_KEY env var is a
  // server-side detection fallback (see resolveGeminiKey) but is intentionally NOT surfaced here, so
  // the in-app "key is set" state and Remove action stay honest about the DB value.
  return { enabled: enabled === "true", hasKey: !!key && key.trim().length > 0 };
}

export async function writeDeviceWizardSettings(
  store: SettingsStore,
  patch: { enabled?: boolean; apiKey?: string },
  orgId: string,
): Promise<void> {
  if (patch.enabled !== undefined) await store.set(orgId, KEY_ENABLED, patch.enabled ? "true" : "false");
  if (patch.apiKey !== undefined) {
    const k = patch.apiKey.trim();
    if (k) await store.set(orgId, KEY_GEMINI, k);
    else await store.del(orgId, KEY_GEMINI);
  }
}

export async function resolveGeminiKey(store: SettingsStore, orgId: string): Promise<string | null> {
  const dbKey = (await store.get(orgId, KEY_GEMINI))?.trim();
  if (dbKey) return dbKey;
  const env = process.env.GEMINI_API_KEY?.trim();
  return env ? env : null;
}
