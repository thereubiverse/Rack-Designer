"use server";

import { revalidatePath } from "next/cache";
import { dbSettingsStore } from "./store";
import { writeDeviceWizardSettings } from "./deviceWizardSettings";
import { withAdmin } from "@/features/auth/withMember";

export const updateDeviceWizardSettings = withAdmin(async (
  _member,
  patch: { enabled?: boolean; apiKey?: string },
): Promise<{ ok: boolean; error?: string }> => {
  try {
    await writeDeviceWizardSettings(dbSettingsStore, patch);
    revalidatePath("/settings");
    revalidatePath("/device-library");
    return { ok: true };
  } catch {
    // Don't surface raw DB errors to the browser on a write that carries the key.
    return { ok: false, error: "Failed to save settings" };
  }
});
