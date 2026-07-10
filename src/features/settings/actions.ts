"use server";

import { revalidatePath } from "next/cache";
import { dbSettingsStore } from "./store";
import { readDeviceWizardSettings, writeDeviceWizardSettings, type DeviceWizardSettings } from "./deviceWizardSettings";

export async function getDeviceWizardSettings(): Promise<DeviceWizardSettings> {
  return readDeviceWizardSettings(dbSettingsStore);
}

export async function updateDeviceWizardSettings(
  patch: { enabled?: boolean; apiKey?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    await writeDeviceWizardSettings(dbSettingsStore, patch);
    revalidatePath("/settings");
    revalidatePath("/device-library");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save settings" };
  }
}
