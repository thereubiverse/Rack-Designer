"use client";

import { DeviceWizardSettingsPanel } from "./DeviceWizardSettingsPanel";

export function SettingsPage({ deviceWizard }: { deviceWizard: { enabled: boolean; hasKey: boolean } }) {
  return (
    <div className="flex gap-8">
      <nav className="w-56 shrink-0">
        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">Features</p>
        <span className="block rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700">Device Wizard</span>
      </nav>
      <section className="min-w-0 flex-1">
        <DeviceWizardSettingsPanel initial={deviceWizard} />
      </section>
    </div>
  );
}
