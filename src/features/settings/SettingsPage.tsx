"use client";

import { DeviceWizardSettingsPanel } from "./DeviceWizardSettingsPanel";
import { SettingsShell } from "./SettingsShell";

export function SettingsPage({ deviceWizard }: { deviceWizard: { enabled: boolean; hasKey: boolean } }) {
  return (
    <SettingsShell active="device-wizard">
      <DeviceWizardSettingsPanel initial={deviceWizard} />
    </SettingsShell>
  );
}
