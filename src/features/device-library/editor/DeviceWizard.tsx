"use client";

import { useRef, useState } from "react";
import type { Face } from "@/domain/faceplate";
import { layoutDetectedFace } from "../ai/layoutDetectedFace";
import { detectPortsAction, identifyDeviceAction } from "../ai/actions";
import type { DetectedFace, DeviceMatch } from "../ai/aiDetect";

export interface WizardApply { face: Face; detected: DetectedFace; match?: DeviceMatch }
export interface DeviceWizardProps {
  widthIn: number;
  rackUnits: number;
  onApply: (a: WizardApply) => void;
  runDetect?: typeof detectPortsAction;
  runIdentify?: typeof identifyDeviceAction;
}

type Phase = "input" | "candidate" | "detecting" | "review" | "error";

export function DeviceWizard({ widthIn, rackUnits, onApply, runDetect = detectPortsAction, runIdentify = identifyDeviceAction }: DeviceWizardProps) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("input");
  const [modelName, setModelName] = useState("");
  const [error, setError] = useState("");
  const [match, setMatch] = useState<DeviceMatch | null>(null);
  const [image, setImage] = useState<{ base64: string; mimeType: string } | null>(null);
  const [detected, setDetected] = useState<DetectedFace | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const reset = () => { setPhase("input"); setError(""); setMatch(null); setImage(null); setDetected(null); };

  async function search() {
    if (phase === "detecting") return;
    if (!modelName.trim()) return;
    setPhase("detecting"); setError("");
    const r = await runIdentify(modelName);
    if (!r.ok) { setError(r.error); setPhase("error"); return; }
    setMatch(r.match); setImage({ base64: r.imageBase64, mimeType: r.mimeType }); setPhase("candidate");
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const base64 = await fileToBase64(file);
    setImage({ base64, mimeType: file.type || "image/png" });
    setMatch(null);
    await detect(base64, file.type || "image/png");
  }

  async function detect(base64: string, mimeType: string) {
    setPhase("detecting"); setError("");
    const r = await runDetect({ imageBase64: base64, mimeType, modelHint: modelName || undefined });
    if (!r.ok) { setError(r.error); setPhase("error"); return; }
    setDetected(r.face); setPhase("review");
  }

  function apply() {
    if (!detected) return;
    const face = layoutDetectedFace(detected, { widthIn, rackUnits });
    onApply({ face, detected, match: match ?? undefined });
    setOpen(false); reset();
  }

  const summary = detected
    ? detected.groups.map((g) => `${g.count}× ${g.connector}`).join(", ") || "no ports detected"
    : "";

  return (
    <div className="flex items-center">
      <button
        type="button"
        aria-label="Device Wizard"
        title="Device Wizard"
        onClick={() => { setOpen((o) => !o); if (open) reset(); }}
        className="flex h-7 w-7 items-center justify-center text-blue-600"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8L19 13M15 9h.01M17.8 6.2L19 5M3 21l9-9M12.2 6.2L11 5" /></svg>
      </button>

      {/* slide-out strip: search + upload emerge to the right from behind the icon */}
      <div
        data-testid="wizard-strip"
        className="overflow-hidden transition-all duration-300 ease-out"
        style={{ maxWidth: open ? 520 : 0, opacity: open ? 1 : 0 }}
      >
        <div className="ml-2 flex items-center gap-2 whitespace-nowrap">
          {(phase === "input" || phase === "detecting") && (
            <>
              <input
                placeholder="Search a model…"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void search(); }}
                disabled={phase === "detecting"}
                className="w-48 rounded border border-neutral-300 px-2 py-1 text-sm"
              />
              <button type="button" onClick={() => void search()} disabled={phase === "detecting"} className="rounded bg-blue-600 px-2 py-1 text-sm text-white">Search</button>
              <span className="text-xs text-neutral-400">or</span>
              <button type="button" data-testid="wizard-upload" onClick={() => fileRef.current?.click()} disabled={phase === "detecting"} className="rounded border border-neutral-300 px-2 py-1 text-sm">Upload</button>
              <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e)} />
              {phase === "detecting" && <span className="text-xs text-neutral-500">Working…</span>}
            </>
          )}

          {phase === "candidate" && match && (
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">{match.name}</span>
              <span className="text-neutral-500">{match.brand} · {match.rackUnits}U</span>
              <button type="button" onClick={() => image && void detect(image.base64, image.mimeType)} className="rounded bg-blue-600 px-2 py-1 text-white">Confirm</button>
              <button type="button" onClick={reset} className="rounded border border-neutral-300 px-2 py-1">Override</button>
            </div>
          )}

          {phase === "review" && detected && (
            <div className="flex items-center gap-2 text-sm">
              <span>Detected {summary} · {detected.confidence}</span>
              <button type="button" onClick={apply} className="rounded bg-blue-600 px-2 py-1 text-white">Apply</button>
              <button type="button" onClick={reset} className="rounded border border-neutral-300 px-2 py-1">Discard</button>
            </div>
          )}

          {phase === "error" && (
            <div className="flex items-center gap-2 text-sm text-red-600">
              <span>{error}</span>
              <button type="button" onClick={reset} className="rounded border border-neutral-300 px-2 py-1 text-neutral-700">Try again</button>
            </div>
          )}
        </div>
      </div>
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
