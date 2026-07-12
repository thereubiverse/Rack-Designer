"use client";

import { useState } from "react";
import { updateDeviceWizardSettings } from "./actions";

export function DeviceWizardSettingsPanel({
  initial, save = updateDeviceWizardSettings,
}: {
  initial: { enabled: boolean; hasKey: boolean };
  save?: typeof updateDeviceWizardSettings;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [hasKey, setHasKey] = useState(initial.hasKey);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    const next = !enabled;
    setEnabled(next); setBusy(true); setError("");
    const r = await save({ enabled: next });
    setBusy(false);
    if (!r.ok) { setEnabled(!next); setError(r.error ?? "Save failed"); }
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    setBusy(true); setError("");
    const r = await save({ apiKey: keyInput });
    setBusy(false);
    if (r.ok) { setHasKey(true); setKeyInput(""); } else setError(r.error ?? "Save failed");
  }

  async function removeKey() {
    setBusy(true); setError("");
    const r = await save({ apiKey: "" });
    setBusy(false);
    if (r.ok) setHasKey(false); else setError(r.error ?? "Save failed");
  }

  const status = !enabled ? "Disabled"
    : hasKey ? "Enabled · key set"
    : "Enabled · no key — the wizard will prompt you to add one";

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h2 className="text-lg font-bold">Device Wizard</h2>
        <p className="mt-1 text-sm text-neutral-500">{status}</p>
      </div>

      <label className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 p-4">
        <span className="text-sm font-medium text-neutral-800">Show the Device Wizard in the rack device editor</span>
        <button
          type="button" role="switch" aria-checked={enabled} aria-label="Show the Device Wizard in the rack device editor"
          disabled={busy} onClick={toggle}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-blue-600" : "bg-neutral-300"}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </label>

      <div className="rounded-lg border border-neutral-200 p-4">
        <label htmlFor="gemini-key" className="text-sm font-medium text-neutral-800">Gemini API key</label>
        <p className="mt-1 text-xs text-neutral-500">Free from Google AI Studio. Stored server-side and used only by the wizard.</p>
        {hasKey ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="rounded bg-neutral-100 px-2 py-1 text-sm text-neutral-600">•••• key is set</span>
            <button type="button" disabled={busy} onClick={removeKey} className="text-sm text-red-600 hover:underline">Remove key</button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <input
              id="gemini-key" type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Paste your key" className="w-64 rounded border border-neutral-300 px-2 py-1 text-sm"
            />
            <button type="button" disabled={busy || !keyInput.trim()} onClick={saveKey} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
