"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import type { RackRow, RackDeviceRow, RackDeviceInput } from "./repository";
import type { DeviceTypeRow, PickerTemplate } from "@/features/device-library/repository";
import { RackCanvas, type RackCanvasHandle } from "./RackCanvas";
import { AddDevicePicker } from "./AddDevicePicker";
import { RackDeviceSettings, type PlacementDraft } from "./RackDeviceSettings";
import { saveRackLayoutAction, updateRackAction } from "./actions";
import { nextCode, resolveMove, findFreeSlot, validateDeviceCode, minRackHeight, type PlacementLike, type FitMode } from "./rackOps";
import { createHistory, push, undo, redo, canUndo, canRedo, type History } from "./history";

function fromRow(r: RackDeviceRow): PlacementDraft {
  return {
    id: r.id, deviceTemplateId: r.device_template_id, code: r.code, name: r.name,
    startU: r.start_u, side: "front", status: r.status,
    manufacturer: r.manufacturer, modelName: r.model_name, serialNumber: r.serial_number,
    purchaseDate: r.purchase_date, operationStart: r.operation_start,
  };
}
function toInput(d: PlacementDraft): RackDeviceInput {
  return {
    id: d.id, device_template_id: d.deviceTemplateId, code: d.code, name: d.name,
    start_u: d.startU, side: d.side, status: d.status,
    manufacturer: d.manufacturer, model_name: d.modelName, serial_number: d.serialNumber,
    purchase_date: d.purchaseDate, operation_start: d.operationStart,
  };
}

export function RackBuilder({ rack, initialDevices, types, templatesByType }: {
  rack: RackRow;
  initialDevices: RackDeviceRow[];
  types: DeviceTypeRow[];
  templatesByType: Record<string, PickerTemplate[]>;
}) {
  const [hist, setHist] = useState<History<PlacementDraft[]>>(() => createHistory(initialDevices.map(fromRow)));
  const placements = hist.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [side, setSide] = useState<"FRONT" | "BACK">("FRONT");
  // initialTypeId null → picker opens at the "Select type" list (free-RU click); a type id →
  // opens straight to that type's templates (palette click). atU is the RU the insert lands on.
  const [picker, setPicker] = useState<{ initialTypeId: string | null; atU: number | null } | null>(null);
  const canvasRef = useRef<RackCanvasHandle>(null); // zoom in/out drive the canvas imperatively
  // PatchDocs' Fit toggle: default fits the whole rack (height); each click flips width ↔ height.
  const [fitMode, setFitMode] = useState<FitMode>("height");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Rack height is local state so the canvas re-renders LIVE as the arrows/input change it; the
  // persist is debounced. Never below the highest occupied RU (minHeight) or above 60.
  const [heightU, setHeightU] = useState(rack.height_u);
  const heightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allTemplates = useMemo(() => Object.values(templatesByType).flat(), [templatesByType]);
  const templatesById = useMemo(() => Object.fromEntries(allTemplates.map((t) => [t.id, t])), [allTemplates]);
  const ru = useMemo(() => Object.fromEntries(allTemplates.map((t) => [t.id, t.rackUnits])), [allTemplates]);
  const typeCodeByTypeId = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t.code])), [types]);
  const like: PlacementLike[] = placements.map((p) => ({ id: p.id, deviceTemplateId: p.deviceTemplateId, code: p.code, startU: p.startU }));
  const minHeight = minRackHeight(like, ru); // highest occupied U — the shrink floor

  function changeHeight(v: number) {
    if (!Number.isFinite(v)) return;
    const clamped = Math.min(60, Math.max(Math.max(1, minHeight), Math.round(v)));
    setHeightU(clamped); // live canvas re-render
    setSaveState("saving"); setError(null);
    if (heightTimer.current) clearTimeout(heightTimer.current);
    heightTimer.current = setTimeout(async () => {
      const res = await updateRackAction(rack.id, { heightU: clamped });
      if (!res.ok) { setSaveState("error"); setError(res.error ?? "Save failed"); return; }
      setSaveState("saved");
    }, 600);
  }

  function queueSave(next: PlacementDraft[]) {
    setSaveState("saving"); setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const res = await saveRackLayoutAction(rack.id, next.map(toInput));
      if (!res.ok) { setSaveState("error"); setError(res.error ?? "Save failed"); return; }
      setSaveState("saved");
    }, 600);
  }
  // Skip the history push (and the save) when the patch didn't actually change anything — a
  // same-value edit (e.g. re-selecting the current status) would otherwise create a dead undo
  // step that visibly does nothing when the user hits ⌘Z.
  function commit(next: PlacementDraft[]) {
    if (next === placements) return;
    setHist((h) => push(h, next));
    queueSave(next);
  }

  // Undo/redo — buttons + keyboard.
  function doUndo() { setHist((h) => { const n = undo(h); if (n !== h) queueSave(n.present); return n; }); }
  function doRedo() { setHist((h) => { const n = redo(h); if (n !== h) queueSave(n.present); return n; }); }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function insertTemplate(t: PickerTemplate) {
    const at = picker?.atU ?? undefined;
    const slot = findFreeSlot(like, ru, t.rackUnits, heightU, at);
    if (slot === null) { setError("No free slot for that device height"); setPicker(null); return; }
    const typeCode = typeCodeByTypeId[t.deviceTypeId] ?? "DEV";
    const draft: PlacementDraft = {
      id: crypto.randomUUID(), deviceTemplateId: t.id, code: nextCode(like, typeCode), name: null,
      startU: slot, side: "front", status: "installed",
      manufacturer: null, modelName: null, serialNumber: null, purchaseDate: null, operationStart: null,
    };
    commit([...placements, draft]);
    setSelectedId(draft.id);
    setPicker(null);
  }

  const selected = placements.find((p) => p.id === selectedId) ?? null;
  const codeError = selected
    ? validateDeviceCode(selected.code) ??
      (placements.some((p) => p.id !== selected.id && p.code === selected.code) ? "That ID is already used in this rack" : null)
    : null;

  const canvasPlacements = placements
    .filter((p) => templatesById[p.deviceTemplateId])
    .map((p) => ({ id: p.id, startU: p.startU, code: p.code, template: templatesById[p.deviceTemplateId] }));

  return (
    <div className="flex gap-4">
      {/* Palette: rack device types */}
      <div className="w-48 shrink-0 space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Devices</p>
        {types.map((t) => (
          <button key={t.id} type="button" data-testid={`palette-type-${t.code}`}
            onClick={() => setPicker({ initialTypeId: t.id, atU: null })}
            className="block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm font-medium hover:bg-neutral-50">
            {t.name}
          </button>
        ))}
      </div>

      {/* Canvas + toolbar */}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-neutral-200 bg-white p-0.5 text-sm font-semibold">
            {(["FRONT", "BACK"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSide(s)}
                className={`rounded-md px-3 py-1 ${side === s ? "bg-neutral-900 text-white" : "text-neutral-600"}`}>
                {s === "FRONT" ? "Front" : "Back"}
              </button>
            ))}
          </div>
          <button type="button" data-testid="rack-undo" disabled={!canUndo(hist)} onClick={doUndo}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm disabled:opacity-40">↺</button>
          <button type="button" data-testid="rack-redo" disabled={!canRedo(hist)} onClick={doRedo}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm disabled:opacity-40">↻</button>
          <button type="button" aria-label="Zoom out" onClick={() => canvasRef.current?.zoomBy(0.8)}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm">−</button>
          <button type="button" aria-label="Zoom in" onClick={() => canvasRef.current?.zoomBy(1.25)}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm">+</button>
          <button type="button" aria-label="Fit" title={`Fit to ${fitMode === "height" ? "width" : "height"}`}
            onClick={() => setFitMode((m) => (m === "height" ? "width" : "height"))}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm">Fit</button>
          <span className={`ml-auto text-xs font-semibold ${saveState === "error" ? "text-red-600" : saveState === "saving" ? "text-amber-600" : "text-green-600"}`}>
            {saveState === "error" ? error : saveState === "saving" ? "Saving…" : "✓ Saved"}
          </span>
        </div>
        <div className="h-[72vh] overflow-hidden rounded-2xl border border-neutral-200 bg-white">
          <RackCanvas
            ref={canvasRef}
            heightU={heightU}
            placements={canvasPlacements}
            side={side}
            fitMode={fitMode}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAddAt={(u) => setPicker({ initialTypeId: null, atU: u })}
            onMove={(id, targetU) => {
              const resolved = resolveMove(like, ru, id, targetU, heightU);
              const cur = placements.find((p) => p.id === id);
              if (!cur || cur.startU === resolved) return;
              commit(placements.map((p) => (p.id === id ? { ...p, startU: resolved } : p)));
            }}
            onDelete={(id) => { commit(placements.filter((p) => p.id !== id)); setSelectedId(null); }}
          />
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-72 shrink-0 rounded-2xl border border-neutral-200 bg-white p-4">
        {selected ? (
          <RackDeviceSettings
            device={selected}
            templateName={templatesById[selected.deviceTemplateId]?.name ?? "Unknown template"}
            codeError={codeError}
            onChange={(patch) => {
              const next = placements.map((p) => (p.id === selected.id ? { ...p, ...patch } : p));
              const changed = (Object.keys(patch) as (keyof PlacementDraft)[])
                .some((k) => selected[k] !== patch[k]);
              if (!changed) return;
              commit(next);
            }}
            onDelete={() => { commit(placements.filter((p) => p.id !== selected.id)); setSelectedId(null); }}
          />
        ) : (
          <RackSettings rack={rack} minHeight={minHeight} heightU={heightU} onHeightChange={changeHeight} />
        )}
      </div>

      {picker && (
        <AddDevicePicker
          types={types}
          templatesByType={templatesByType}
          initialTypeId={picker.initialTypeId}
          onInsert={insertTemplate}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/** Rack settings when nothing is selected: name + height. Height is controlled by the parent so
 *  the canvas re-renders live as it changes; the name saves on blur (shrink guarded server-side). */
function RackSettings({ rack, minHeight, heightU, onHeightChange }: {
  rack: RackRow; minHeight: number; heightU: number; onHeightChange: (v: number) => void;
}) {
  const [name, setName] = useState(rack.name ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  async function saveName() {
    setMsg(null);
    const res = await updateRackAction(rack.id, { name: name === "" ? null : name });
    if (!res.ok) setMsg(res.error ?? "Save failed");
  }
  const input = "mt-1 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm font-normal focus:border-neutral-400 focus:outline-none";
  return (
    <div className="space-y-3" data-testid="rack-settings">
      <div className="text-xs font-bold text-neutral-800">Rack {rack.code}</div>
      <label className="block text-[11px] font-semibold text-neutral-600">Name
        <input value={name} className={input}
          onChange={(e) => setName(e.target.value)}
          onBlur={saveName} />
      </label>
      <label className="block text-[11px] font-semibold text-neutral-600">Rack units
        <input type="number" min={Math.max(1, minHeight)} max={60} value={heightU} className={input}
          onChange={(e) => onHeightChange(Number(e.target.value))} />
      </label>
      {msg && <p className="text-sm text-red-600">{msg}</p>}
      <p className="text-xs text-neutral-400">Select a device to edit its settings.</p>
    </div>
  );
}
