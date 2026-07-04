"use client";

import { useState, useEffect } from "react";
import { MEDIA, type Media } from "@/domain/faceplate";
import { PortGlyph } from "@/features/device-library/faceplate/portGlyphs";
import type { DeviceTypeRow, BrandRow } from "../repository";
import { useDeviceDraft, type DeviceDraft } from "./useDeviceDraft";
import { EditorCanvas } from "./EditorCanvas";

const MEDIA_LABELS: Record<Media, string> = {
  copper: "Copper", fiber: "Fiber", sfp: "SFP", usb_a: "USB-A", usb_c: "USB-C",
  hdmi: "HDMI", dp: "DP", vga: "VGA", ps2: "PS/2", audio: "Audio",
};

export interface RackDeviceEditorProps {
  mode: "create" | "edit";
  initial?: Partial<DeviceDraft>;
  types: DeviceTypeRow[];
  brands: BrandRow[];
  saving?: boolean;
  error?: string | null;
  onSave: (draft: DeviceDraft) => void;
  onCancel: () => void;
  onCreateBrand?: (name: string) => Promise<BrandRow | null>;
}

export function RackDeviceEditor(props: RackDeviceEditorProps) {
  const { draft, activeFace, setField, setActiveSide, errors, isValid } = useDeviceDraft(props.initial);
  const [addingBrand, setAddingBrand] = useState(false);
  const [newBrand, setNewBrand] = useState("");
  const [brands, setBrands] = useState(props.brands);

  async function confirmAddBrand() {
    if (!props.onCreateBrand || !newBrand.trim()) return;
    const created = await props.onCreateBrand(newBrand.trim());
    if (created) {
      setBrands((b) => [...b, created]);
      setField("brandId", created.id);
    }
    setAddingBrand(false);
    setNewBrand("");
  }

  const side = draft.activeSide === "front" ? "FRONT" : "BACK";

  // Escape closes the modal (behaves like Cancel), per spec §10.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") props.onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <div
      data-testid="rack-device-editor"
      role="dialog"
      aria-label="Rack Device Editor"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}
    >
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Rack Device Editor</h2>
          <button aria-label="Close" onClick={props.onCancel} className="text-neutral-400">✕</button>
        </div>

        {/* Header fields */}
        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Name *
            <input
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-3 text-sm font-normal text-neutral-800"
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
            />
          </label>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Brand
            {!addingBrand ? (
              <div className="mt-1 flex gap-1">
                <select
                  className="h-10 flex-1 rounded-lg border border-neutral-200 px-2 text-sm font-normal text-neutral-800"
                  value={draft.brandId ?? ""}
                  onChange={(e) => setField("brandId", e.target.value || null)}
                >
                  <option value="">—</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                {props.onCreateBrand && (
                  <button type="button" title="Add brand" aria-label="Add brand"
                    className="h-10 rounded-lg border border-neutral-200 px-2 text-sm"
                    onClick={() => setAddingBrand(true)}>+</button>
                )}
              </div>
            ) : (
              <div className="mt-1 flex gap-1">
                <input data-testid="brand-add-input" value={newBrand}
                  onChange={(e) => setNewBrand(e.target.value)}
                  className="h-10 flex-1 rounded-lg border border-neutral-200 px-2 text-sm font-normal" placeholder="New brand" />
                <button type="button" data-testid="brand-add-confirm"
                  className="h-10 rounded-lg bg-blue-600 px-2 text-sm text-white" onClick={confirmAddBrand}>Add</button>
              </div>
            )}
          </label>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Device type *
            <select
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-2 text-sm font-normal text-neutral-800"
              value={draft.deviceTypeId}
              onChange={(e) => setField("deviceTypeId", e.target.value)}
            >
              <option value="">—</option>
              {props.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Rack units
            <select
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-2 text-sm font-normal text-neutral-800"
              value={draft.rackUnits}
              onChange={(e) => setField("rackUnits", Number(e.target.value))}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((u) => (
                <option key={u} value={u}>{u} RU</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Width (in)
            <input
              type="number" step="0.1" min="0"
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-3 text-sm font-normal text-neutral-800"
              value={draft.widthIn}
              onChange={(e) => setField("widthIn", Number(e.target.value))}
            />
          </label>
        </div>

        {/* Canvas + palette + toggles */}
        <div className="rounded-xl border border-neutral-100 bg-neutral-50 p-4">
          <div className="mb-3 flex flex-wrap items-start gap-3">
            <div className="flex flex-wrap gap-2 rounded-lg border border-neutral-200 bg-white p-2">
              {MEDIA.map((m) => (
                <span key={m} className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-800" title={MEDIA_LABELS[m]}>
                  <span className="text-neutral-900"><PortGlyph media={m} /></span>{MEDIA_LABELS[m]}
                </span>
              ))}
            </div>
            <div className="ml-auto flex flex-col gap-2">
              <div className="flex rounded-lg border border-neutral-200 bg-white p-1 text-sm font-semibold">
                <button type="button"
                  className={`rounded-md px-4 py-1 ${draft.activeSide === "front" ? "bg-neutral-900 text-white" : "text-neutral-500"}`}
                  onClick={() => setActiveSide("front")}>Front</button>
                <button type="button"
                  className={`rounded-md px-4 py-1 ${draft.activeSide === "back" ? "bg-neutral-900 text-white" : "text-neutral-500"}`}
                  onClick={() => setActiveSide("back")}>Back</button>
              </div>
              <button type="button" aria-pressed={draft.rackMounted}
                className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs font-medium"
                onClick={() => setField("rackMounted", !draft.rackMounted)}>
                Rack Mounted
                <span className={`inline-block h-4 w-8 rounded-full ${draft.rackMounted ? "bg-blue-600" : "bg-neutral-300"}`} />
              </button>
            </div>
          </div>

          <div className="mt-2 overflow-auto">
            <EditorCanvas
              face={activeFace}
              widthIn={draft.widthIn > 0 ? draft.widthIn : 1}
              rackUnits={draft.rackUnits >= 1 ? draft.rackUnits : 1}
              rackMounted={draft.rackMounted}
              side={side}
            />
          </div>
        </div>

        {/* Settings placeholder (3b/3c fill this in) */}
        <div className="mt-4 rounded-xl border border-dashed border-neutral-200 p-6 text-center text-xs text-neutral-400">
          Select a port to edit its name. (Group building arrives in the next slice.)
        </div>

        {props.error && <p className="mt-3 text-sm text-red-600">{props.error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" data-testid="editor-cancel" onClick={props.onCancel}
            className="rounded-lg border border-neutral-200 px-5 py-2 text-sm font-semibold">Cancel</button>
          <button
            type="button"
            data-testid="editor-save"
            disabled={!isValid || props.saving}
            onClick={() => onSaveGuard(isValid, props.saving, () => props.onSave(draft))}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {props.saving ? "Saving…" : props.mode === "create" ? "Create" : "Save"}
          </button>
        </div>

        {/* consumed so errors object isn't flagged as unused when wired in 3b */}
        <span className="hidden">{Object.values(errors).join("")}</span>
      </div>
    </div>
  );
}

function onSaveGuard(isValid: boolean, saving: boolean | undefined, run: () => void) {
  if (isValid && !saving) run();
}
