"use client";

import { useState, useEffect } from "react";
import { MEDIA, MAX_BODY_WIDTH_IN, CONNECTORS, type Media } from "@/domain/faceplate";
import { PortGlyph } from "@/features/device-library/faceplate/portGlyphs";
import type { DeviceTypeRow, BrandRow } from "../repository";
import { useDeviceDraft, type DeviceDraft } from "./useDeviceDraft";
import { EditorCanvas } from "./EditorCanvas";
import { frameDims, layoutPortGroup } from "@/domain/faceplate-geometry";
import { PortGroupSettings } from "./PortGroupSettings";
import { PortSettings } from "./PortSettings";
import { BrandPicker } from "./BrandPicker";
import { Select } from "./Select";
import {
  addPortGroup, movePortGroup, addColumn, addRow, removeColumn, removeRow, updatePortGroup, deletePortGroup,
  setPortOverride, setPortMedia, setSpacing, type GridBounds,
} from "./portGroupOps";

// The seeded default brand — always available, never deletable.
const PROTECTED_BRAND_NAME = "Generic";

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
  onDeleteBrand?: (id: string) => Promise<boolean>;
}

export function RackDeviceEditor(props: RackDeviceEditorProps) {
  const { draft, activeFace, setField, setActiveSide, setActiveFace, errors, isValid } = useDeviceDraft(props.initial);
  const [brands, setBrands] = useState(props.brands);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedPortIndex, setSelectedPortIndex] = useState<number | null>(null);
  const [snapToGrid, setSnapToGrid] = useState(false); // toggle only for now; snapping wired in a later slice
  const dims = frameDims({
    widthIn: draft.widthIn > 0 ? draft.widthIn : 1,
    rackUnits: draft.rackUnits >= 1 ? draft.rackUnits : 1,
    rackMounted: draft.rackMounted,
  });
  const bounds: GridBounds = { width: dims.bodyWidthPx, height: dims.heightPx };
  const selectedGroup = activeFace.portGroups.find((g) => g.id === selectedGroupId) ?? null;

  function selectGroup(id: string | null) {
    setSelectedGroupId(id);
    setSelectedPortIndex(null);
  }

  function stepWidth(delta: number) {
    const next = Math.round((draft.widthIn + delta) * 10) / 10; // avoid float drift
    setField("widthIn", Math.min(MAX_BODY_WIDTH_IN, Math.max(0.1, next)));
  }

  function switchSide(next: "front" | "back") {
    setSelectedGroupId(null);
    setSelectedPortIndex(null);
    setActiveSide(next);
  }

  const side = draft.activeSide === "front" ? "FRONT" : "BACK";

  // Rotate the current selection clockwise: a port icon by 180° per click, an element
  // by 90° (elements arrive in a later slice). Disabled when nothing rotatable is selected.
  const canRotate = selectedGroupId !== null && selectedPortIndex !== null;
  function rotateSelection() {
    if (selectedGroupId === null || selectedPortIndex === null) return;
    const group = activeFace.portGroups.find((g) => g.id === selectedGroupId);
    const current = group?.portOverrides[selectedPortIndex]?.rotation ?? 0;
    setActiveFace(setPortOverride(activeFace, selectedGroupId, selectedPortIndex, { rotation: (current + 180) % 360 }));
  }

  // "Other" always sits at the bottom of the device-type list.
  const orderedTypes = [
    ...props.types.filter((t) => t.name !== "Other"),
    ...props.types.filter((t) => t.name === "Other"),
  ];

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
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-[6vh]"
      onClick={(e) => { if (e.target === e.currentTarget) props.onCancel(); }}
    >
      <div className="no-select-ui w-full max-w-[1000px] rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Rack Device Editor</h2>
          <button aria-label="Close" onClick={props.onCancel} className="text-neutral-400">✕</button>
        </div>

        {/* Header fields — Rack units + Width kept narrow so the wider Name/Brand/
            Device type columns have room (e.g. the brand "＋" edit row). */}
        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-[1.6fr_1.2fr_1.2fr_0.7fr_0.9fr]">
          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Name *
            <input
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-3 text-sm font-normal text-neutral-800"
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
            />
          </label>

          <div className="flex flex-col text-xs font-semibold text-neutral-600">
            Brand
            <BrandPicker
              brands={brands}
              value={draft.brandId ?? null}
              onChange={(id) => setField("brandId", id)}
              onCreate={props.onCreateBrand && (async (name) => {
                const created = await props.onCreateBrand!(name);
                if (created) { setBrands((b) => [...b, created]); setField("brandId", created.id); }
              })}
              onDelete={props.onDeleteBrand && (async (id) => {
                const ok = await props.onDeleteBrand!(id);
                if (ok) { setBrands((b) => b.filter((x) => x.id !== id)); if (draft.brandId === id) setField("brandId", null); }
              })}
              canDelete={(b) => b.name !== PROTECTED_BRAND_NAME}
            />
          </div>

          <div className="flex flex-col text-xs font-semibold text-neutral-600">
            Device type *
            <Select
              testId="device-type-trigger"
              ariaLabel="Device type"
              value={draft.deviceTypeId}
              onChange={(v) => setField("deviceTypeId", v)}
              options={[{ value: "", label: "—" }, ...orderedTypes.map((t) => ({ value: t.id, label: t.name }))]}
            />
          </div>

          <div className="flex flex-col text-xs font-semibold text-neutral-600">
            Rack units
            <Select
              testId="rack-units-trigger"
              ariaLabel="Rack units"
              value={String(draft.rackUnits)}
              onChange={(v) => setField("rackUnits", Number(v))}
              options={Array.from({ length: 10 }, (_, i) => i + 1).map((u) => ({ value: String(u), label: `${u} RU` }))}
            />
          </div>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Width (in)
            <div className="relative mt-1">
              <input
                type="number" step="0.1" min="0" max={MAX_BODY_WIDTH_IN}
                className="h-10 w-full rounded-lg border border-neutral-200 pl-3 pr-7 text-sm font-normal text-neutral-800 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                value={draft.widthIn}
                onChange={(e) => setField("widthIn", Math.min(Number(e.target.value), MAX_BODY_WIDTH_IN))}
              />
              <div className="absolute inset-y-1 right-1 flex w-5 flex-col overflow-hidden rounded border border-neutral-200">
                <button type="button" tabIndex={-1} aria-label="Increase width by 0.1"
                  className="flex flex-1 items-center justify-center text-neutral-500 hover:bg-neutral-100"
                  onClick={() => stepWidth(0.1)}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6 -6l6 6" /></svg>
                </button>
                <button type="button" tabIndex={-1} aria-label="Decrease width by 0.1"
                  className="flex flex-1 items-center justify-center border-t border-neutral-200 text-neutral-500 hover:bg-neutral-100"
                  onClick={() => stepWidth(-0.1)}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6l6 -6" /></svg>
                </button>
              </div>
            </div>
          </label>
        </div>

        {/* Canvas + palette + toggles. Clicking any empty space here deselects the
            current group/port — group boxes and port targets stopPropagation so
            selecting them isn't undone by this. */}
        <div
          className="rounded-xl border border-neutral-100 bg-neutral-50 p-4"
          onClick={() => selectGroup(null)}
        >
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-stretch gap-2">
              <span className="flex items-center justify-center text-[10px] font-medium text-neutral-400" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Port Types</span>
              <div className="grid grid-cols-5 gap-2 rounded-lg border border-neutral-200 bg-white p-2">
                {MEDIA.map((m) => {
                  const portSelected = selectedGroupId != null && selectedPortIndex !== null;
                  return (
                    <span key={m} draggable
                      onDragStart={(e) => e.dataTransfer.setData("text/plain", m)}
                      onClick={(e) => {
                        if (!portSelected) return;
                        e.stopPropagation(); // keep the port selected so its settings stay shown
                        setActiveFace(setPortMedia(activeFace, selectedGroupId!, selectedPortIndex!, m));
                      }}
                      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-neutral-800 ${portSelected ? "cursor-pointer border-neutral-200 hover:border-blue-400 hover:bg-blue-50" : "cursor-grab border-neutral-200"}`}
                      title={portSelected ? `Set selected port to ${MEDIA_LABELS[m]}` : MEDIA_LABELS[m]}>
                      <span className="text-neutral-900"><PortGlyph media={m} /></span>{MEDIA_LABELS[m]}
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="flex items-stretch gap-2" onClick={(e) => e.stopPropagation()}>
              <span className="flex items-center justify-center text-[10px] font-medium text-neutral-400" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Elements</span>
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-neutral-200 bg-white p-2" title="Elements arrive in a later slice">
                <span data-testid="element-text" className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-400">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 20l6 -16l2 0l7 16" /><path d="M4 20l3 0" /><path d="M14 20l7 0" /><path d="M6.9 15l6.9 0" /></svg>
                  Text
                </span>
                <span data-testid="element-icon" className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-400">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6.5" cy="6.5" r="3.5" /><path d="M2.5 21h8l-4 -7z" /><path d="M14 3l7 7" /><path d="M14 14h7v7h-7z" /></svg>
                  Icon
                </span>
                <span data-testid="element-shapes" className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-400">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l4.5 8h-9z" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1" /><circle cx="17" cy="17.2" r="3.8" /></svg>
                  Shapes
                </span>
                <span data-testid="element-lines" className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-400">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 18l12 -12" /><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /></svg>
                  Lines
                </span>
              </div>
            </div>
            {/* Snap-to-grid (functional toggle: grey off, blue on) + rotate (future) icons,
                sitting between the Elements box and the Front/Back + Rack Mounted toggles. */}
            {/* Grid + rotate icons — their own row group so justify-between centres
                them between the Elements box and the Front/Back + Rack Mounted toggles. */}
            <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
              <button type="button" data-testid="snap-to-grid" aria-pressed={snapToGrid} aria-label="Snap to grid" title="Snap to grid"
                onClick={() => setSnapToGrid((v) => !v)}
                className={`flex h-9 w-9 items-center justify-center rounded-lg border ${snapToGrid ? "border-blue-600 bg-blue-50 text-blue-600" : "border-neutral-200 bg-white text-neutral-400"}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>
              </button>
              <button type="button" data-testid="rotate-element" aria-label="Rotate clockwise" title="Rotate clockwise"
                disabled={!canRotate}
                onClick={rotateSelection}
                className={`flex h-9 w-9 items-center justify-center rounded-lg border ${canRotate ? "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100" : "border-neutral-200 bg-white text-neutral-300"}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19.95 11a8 8 0 1 0 -.5 4" /><path d="M20 4.5v5h-5" /></svg>
              </button>
            </div>
            <div className="flex flex-col gap-2">
              <div className="relative flex h-9 rounded-lg border border-neutral-200 bg-white p-0.5 text-xs font-semibold">
                {/* sliding black indicator behind the labels */}
                <span className={`pointer-events-none absolute inset-y-0.5 left-0.5 w-[calc(50%-2px)] rounded-md bg-neutral-900 transition-transform duration-200 ${draft.activeSide === "back" ? "translate-x-full" : "translate-x-0"}`} />
                <button type="button"
                  className={`relative z-10 flex flex-1 items-center justify-center rounded-md px-2.5 transition-colors ${draft.activeSide === "front" ? "text-white" : "text-neutral-500"}`}
                  onClick={() => switchSide("front")}>Front</button>
                <button type="button"
                  className={`relative z-10 flex flex-1 items-center justify-center rounded-md px-2.5 transition-colors ${draft.activeSide === "back" ? "text-white" : "text-neutral-500"}`}
                  onClick={() => switchSide("back")}>Back</button>
              </div>
              <button type="button" aria-pressed={draft.rackMounted}
                className="flex h-9 items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 text-xs font-medium"
                onClick={() => setField("rackMounted", !draft.rackMounted)}>
                Rack Mounted
                <span className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${draft.rackMounted ? "bg-blue-600" : "bg-neutral-300"}`}>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all ${draft.rackMounted ? "left-3.5" : "left-0.5"}`} />
                </span>
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
              selectedGroupId={selectedGroupId}
              onSelect={selectGroup}
              onCreate={(media, pos) => {
                const before = activeFace.portGroups.length;
                const next = addPortGroup(activeFace, media, pos, bounds);
                setActiveFace(next);
                if (next.portGroups.length > before) selectGroup(next.portGroups[next.portGroups.length - 1].id);
              }}
              onMove={(id, pos) => setActiveFace(movePortGroup(activeFace, id, pos, bounds))}
              onAddColumn={(id) => setActiveFace((prev) => addColumn(prev, id, bounds))}
              onAddRow={(id) => setActiveFace((prev) => addRow(prev, id, bounds))}
              onRemoveColumn={(id) => setActiveFace((prev) => removeColumn(prev, id))}
              onRemoveRow={(id) => setActiveFace((prev) => removeRow(prev, id))}
              selectedPortIndex={selectedPortIndex}
              onSelectPort={setSelectedPortIndex}
              onPortMedia={(gid, index, media) => {
                setActiveFace(setPortMedia(activeFace, gid, index, media));
                setSelectedGroupId(gid);
                setSelectedPortIndex(index); // select the changed port so its settings show
              }}
              onSpacing={(id, spacing) => setActiveFace(setSpacing(activeFace, id, spacing))}
              highlight={selectedGroupId && selectedPortIndex !== null ? { groupId: selectedGroupId, portIndex: selectedPortIndex } : null}
            />
          </div>
        </div>

        {selectedGroup ? (
          <div className="mt-4 flex flex-wrap gap-5 rounded-xl border border-neutral-200 p-4">
            <div className="min-w-0 flex-1">
              <PortGroupSettings
                embedded
                group={selectedGroup}
                onChange={(patch) => setActiveFace(updatePortGroup(activeFace, selectedGroup.id, patch))}
                onDelete={() => { setActiveFace(deletePortGroup(activeFace, selectedGroup.id)); selectGroup(null); }}
              />
            </div>
            <div className="flex w-full flex-col rounded-lg border border-dashed border-neutral-300 p-3 sm:w-[230px]">
              {selectedPortIndex !== null ? (() => {
                const cell = layoutPortGroup(selectedGroup, undefined).cells.find((c) => c.index === selectedPortIndex);
                const ov = selectedGroup.portOverrides[selectedPortIndex] ?? {};
                return (
                  <PortSettings
                    embedded
                    portLabel={cell ? cell.label : String(selectedPortIndex + 1)}
                    name={ov.name ?? ""}
                    flipped={ov.flipped ?? false}
                    labelPos={cell ? cell.labelPos : "top"}
                    typeLabel={ov.media ? MEDIA_LABELS[ov.media] : undefined}
                    connectorType={cell?.connectorType}
                    connectorOptions={ov.media ? CONNECTORS[ov.media] : undefined}
                    onChange={(patch) => setActiveFace(setPortOverride(activeFace, selectedGroup.id, selectedPortIndex, patch))}
                  />
                );
              })() : (
                <span className="m-auto text-center text-xs text-neutral-400">Select a port to edit its name.</span>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-neutral-200 p-6 text-center text-xs text-neutral-400">
            Drag a port type onto the grid to add a group. Select a group to edit it.
          </div>
        )}

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
