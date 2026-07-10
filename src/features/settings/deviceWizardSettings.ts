import type { SettingsStore } from "./store";

export const KEY_ENABLED = "device_wizard.enabled";
export const KEY_GEMINI = "device_wizard.gemini_api_key";

export interface DeviceWizardSettings { enabled: boolean; hasKey: boolean }

export async function readDeviceWizardSettings(store: SettingsStore): Promise<DeviceWizardSettings> {
  const [enabled, key] = await Promise.all([store.get(KEY_ENABLED), store.get(KEY_GEMINI)]);
  return { enabled: enabled === "true", hasKey: !!key && key.trim().length > 0 };
}

export async function writeDeviceWizardSettings(
  store: SettingsStore,
  patch: { enabled?: boolean; apiKey?: string },
): Promise<void> {
  if (patch.enabled !== undefined) await store.set(KEY_ENABLED, patch.enabled ? "true" : "false");
  if (patch.apiKey !== undefined) {
    const k = patch.apiKey.trim();
    if (k) await store.set(KEY_GEMINI, k);
    else await store.del(KEY_GEMINI);
  }
}

export async function resolveGeminiKey(store: SettingsStore): Promise<string | null> {
  const dbKey = (await store.get(KEY_GEMINI))?.trim();
  if (dbKey) return dbKey;
  const env = process.env.GEMINI_API_KEY?.trim();
  return env ? env : null;
}
