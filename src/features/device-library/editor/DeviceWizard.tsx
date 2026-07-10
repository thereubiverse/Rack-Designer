"use client";

import { useRef, useState } from "react";
import { detectPortsAction } from "../ai/actions";
import type { DetectedFace } from "../ai/aiDetect";

export interface WizardApply { detected: DetectedFace }
export interface DeviceWizardProps {
  widthIn: number;
  rackUnits: number;
  enabled: boolean;
  hasKey: boolean;
  onApply: (a: WizardApply) => void;
  runDetect?: typeof detectPortsAction;
}

// Search is hidden for now (no free real-image lookup) — the wizard is upload-only: the icon toggles
// into a blue "upload a photo" button, reads the photo with vision, and drops the ports into a draft.
type Phase = "idle" | "upload" | "detecting" | "review" | "error";

const WAND = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" /></svg>
);
const UPLOAD = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M12 15V3M7 8l5-5 5 5" /></svg>
);

function SettingsPrompt() {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap text-sm text-neutral-600">
      Add your Gemini API key in
      <a href="/settings" className="font-medium text-blue-600 hover:underline">Settings →</a>
    </span>
  );
}

export function DeviceWizard({ enabled, hasKey, onApply, runDetect = detectPortsAction }: DeviceWizardProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [detected, setDetected] = useState<DetectedFace | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reset = () => { setPhase("idle"); setError(""); setDetected(null); };

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const base64 = await fileToBase64(file);
    setPhase("detecting"); setError("");
    const r = await runDetect({ imageBase64: base64, mimeType: file.type || "image/png" });
    if (!r.ok) { setError(r.error); setPhase("error"); return; }
    setDetected(r.face); setPhase("review");
  }

  function apply() {
    if (!detected) return;
    onApply({ detected });
    reset();
  }

  if (!enabled) return null;

  // idle: the wizard icon. Clicking it turns into the upload control (or a Settings prompt if no key).
  if (phase === "idle") {
    return (
      <button
        type="button" aria-label="Device Wizard" title="Device Wizard"
        onClick={() => { if (hasKey) setPhase("upload"); else { setError("no-key"); setPhase("error"); } }}
        className="flex h-7 w-7 items-center justify-center text-blue-600"
      >
        {WAND}
      </button>
    );
  }

  const summary = detected ? detected.groups.map((g) => `${g.count}× ${g.connector}`).join(", ") || "no ports detected" : "";

  return (
    <div className="flex items-center gap-2 whitespace-nowrap">
      {(phase === "upload" || phase === "detecting") && (
        <>
          <button
            type="button" data-testid="wizard-upload" aria-label="Upload a photo" title="Upload a photo"
            onClick={() => fileRef.current?.click()} disabled={phase === "detecting"}
            className="flex h-7 w-7 items-center justify-center text-blue-600 disabled:opacity-50"
          >
            {UPLOAD}
          </button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e)} />
          {phase === "detecting" && <span className="text-xs text-neutral-500">Working…</span>}
        </>
      )}

      {phase === "review" && detected && (
        <div className="flex items-center gap-2 text-sm">
          <span>Detected {summary} · {detected.confidence}</span>
          <button type="button" onClick={apply} className="rounded bg-blue-600 px-2 py-1 text-white">Apply</button>
          <button type="button" onClick={reset} className="rounded border border-neutral-300 px-2 py-1">Discard</button>
        </div>
      )}

      {phase === "error" && (
        error === "no-key" ? (
          <SettingsPrompt />
        ) : (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <span>{error}</span>
            <button type="button" onClick={reset} className="rounded border border-neutral-300 px-2 py-1 text-neutral-700">Try again</button>
          </div>
        )
      )}
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
