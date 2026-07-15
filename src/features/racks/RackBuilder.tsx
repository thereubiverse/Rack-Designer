"use client";

import { useMemo, useRef, useState, useEffect, useCallback } from "react";
import { flushSync } from "react-dom";
import type { RackRow, RackDeviceRow, RackDeviceInput } from "./repository";
import type { DeviceTypeRow, PickerTemplate } from "@/features/device-library/repository";
import { emptyFace, type Face } from "@/domain/faceplate";
import { RackCanvas, type RackCanvasHandle } from "./RackCanvas";
import { AddDevicePicker } from "./AddDevicePicker";
import { PalettePullLayer, type PullState } from "./PalettePullLayer";
import { SNAP_MS, pullProgress } from "./palettePull";
import { RackDeviceSettings, type PlacementDraft } from "./RackDeviceSettings";
import { saveRackLayoutAction, saveConnectionsAction, saveEndpointsAction, updateRackAction } from "./actions";
import { nextCode, resolveMove, findFreeSlot, validateDeviceCode, minRackHeight, type PlacementLike, type FitMode } from "./rackOps";
import { createHistory, push, undo, redo, canUndo, canRedo, type History } from "./history";
import { validatePatch, addConnection, removeConnection, portsOf, type Connection, type PortRef } from "./connectionOps";
import { upsertEndpoint, removeEndpoint, type PortEndpoint } from "./endpointOps";
import type { SiteScope } from "./siteScope";
import { ConnectionDetails } from "./ConnectionDetails";

function fromRow(r: RackDeviceRow): PlacementDraft {
  return {
    id: r.id, deviceTemplateId: r.device_template_id, code: r.code, name: r.name,
    startU: r.start_u, side: "front", status: r.status,
    manufacturer: r.manufacturer, modelName: r.model_name, serialNumber: r.serial_number,
    purchaseDate: r.purchase_date, operationStart: r.operation_start,
    frontFace: (r.front_face as Face | null) ?? emptyFace(),
    backFace: (r.back_face as Face | null) ?? emptyFace(),
    heightU: r.height_u,
  };
}
function toInput(d: PlacementDraft): RackDeviceInput {
  return {
    id: d.id, device_template_id: d.deviceTemplateId, code: d.code, name: d.name,
    start_u: d.startU, side: d.side, status: d.status,
    manufacturer: d.manufacturer, model_name: d.modelName, serial_number: d.serialNumber,
    purchase_date: d.purchaseDate, operation_start: d.operationStart,
    front_face: d.frontFace, back_face: d.backFace, height_u: d.heightU,
  };
}

type RackState = { placements: PlacementDraft[]; connections: Connection[]; endpoints: PortEndpoint[] };

export function RackBuilder({ rack, initialDevices, initialConnections, initialEndpoints, siteScope, floorTypes, types, templatesByType }: {
  rack: RackRow;
  initialDevices: RackDeviceRow[];
  initialConnections: Connection[];
  initialEndpoints: PortEndpoint[];
  siteScope: SiteScope;
  floorTypes: DeviceTypeRow[];
  types: DeviceTypeRow[];
  templatesByType: Record<string, PickerTemplate[]>;
}) {
  const [hist, setHist] = useState<History<RackState>>(() =>
    createHistory({ placements: initialDevices.map(fromRow), connections: initialConnections, endpoints: initialEndpoints }));
  const { placements, connections, endpoints } = hist.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [side, setSide] = useState<"FRONT" | "BACK">("FRONT");
  // initialTypeId null → picker opens at the "Select type" list (free-RU click); a type id →
  // opens straight to that type's templates (palette click). atU is the RU the insert lands on.
  const [picker, setPicker] = useState<{ initialTypeId: string | null; atU: number | null } | null>(null);
  const canvasRef = useRef<RackCanvasHandle>(null); // zoom in/out drive the canvas imperatively

  // Palette -> rack pull. The live values are a REF (mutated per frame, no re-render); React state
  // is only `pullMounted` (mount the overlay) and `dropArmed` (latched once, when it goes solid).
  const pullRef = useRef<PullState | null>(null);
  const [pullMounted, setPullMounted] = useState(false);
  const [dropArmed, setDropArmed] = useState(false);
  // The pending snap-back timer, held so a NEW pull can cancel it. Without this, abandoning a pull
  // and immediately grabbing another chip lets the old timer fire and kill the new pull mid-gesture.
  const snapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSnapTimer = useCallback(() => {
    if (snapTimerRef.current !== null) { clearTimeout(snapTimerRef.current); snapTimerRef.current = null; }
  }, []);

  const endPull = useCallback(() => {
    clearSnapTimer();
    pullRef.current = null;
    setPullMounted(false);
    setDropArmed(false);
  }, [clearSnapTimer]);

  const beginSnapBack = useCallback(() => {
    const p = pullRef.current;
    if (!p || p.phase === "snapback") return;
    // Pull progress at the moment of abandon — the snap-back shrinks from the box's actual size,
    // not from full RU size. Read BEFORE flipping phase to "snapback".
    p.snapT = p.phase === "solid" ? 1 : pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y));
    p.snapFrom = { x: p.x, y: p.y };
    p.snapStart = performance.now();
    p.phase = "snapback";
    setDropArmed(false);                  // a retreating box must not be droppable
    clearSnapTimer();
    snapTimerRef.current = setTimeout(endPull, SNAP_MS); // the layer animates; this owns when it's over
  }, [endPull, clearSnapTimer]);

  function startPull(e: React.PointerEvent, typeId: string) {
    if (e.button !== 0) return;
    clearSnapTimer(); // a previous pull may still be snapping back — its timer must not end THIS one
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    pullRef.current = {
      typeId,
      chip: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      chipSize: { w: r.width, h: r.height },
      x: e.clientX, y: e.clientY,
      phase: "pulling", snapFrom: null, snapStart: 0, snapT: 0,
    };
    setPullMounted(true);
    setDropArmed(false);
  }

  useEffect(() => {
    if (!pullMounted) return;
    const onMove = (e: PointerEvent) => {
      const p = pullRef.current;
      if (!p || p.phase === "snapback") return;
      p.x = e.clientX; p.y = e.clientY;   // per-frame: mutate the ref, never setState
      // Latch solid HERE, not in the layer's rAF loop: the drop must not depend on a frame having
      // fired, and the phase machine belongs with the state's owner. This setState runs once.
      if (p.phase === "pulling" && pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y)) >= 1) {
        p.phase = "solid";
        p.snapStart = performance.now();  // the latch spring's clock
        // flushSync, not a plain setState: pointermove is continuous priority, so React would
        // otherwise schedule this render through the Scheduler instead of flushing it inline. The
        // strip gates the drop on props.dropArmed (not on the ref write above, which IS
        // synchronous), so a pointerup arriving before that scheduled render still sees
        // dropArmed=false and silently loses the drop. Only runs once per gesture, so the
        // flushSync cost is nil. Raising PULL_DIST (a tuning knob, see palettePull.ts) moves the
        // latch point closer to the rack, WIDENING this window rather than narrowing it — so this
        // guards against a regression the next tuning pass could otherwise introduce.
        flushSync(() => setDropArmed(true));
      }
    };
    const onUp = () => {
      // A drop on a strip already cleared pullRef (its React onPointerUp runs first — the React root
      // is inside body, so it sees the event before this window listener). Nothing left to do.
      if (!pullRef.current) return;
      beginSnapBack();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") beginSnapBack(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [pullMounted, beginSnapBack]);
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

  function queueSave(next: RackState) {
    setSaveState("saving"); setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      // The layout save must land FIRST and be awaited: saveConnectionsAction and
      // saveEndpointsAction both re-read the rack's devices from the DB to validate ports, so
      // running them concurrently with the layout write is a race — they can see a device row
      // BEFORE saveRackLayoutAction re-inserts it (e.g. undoing a device deletion restores the
      // device + its cable + its endpoint all in one commit) and reject with "That port no
      // longer exists". Endpoints and connections don't depend on each other, so they stay
      // parallel once the layout is settled.
      const layout = await saveRackLayoutAction(rack.id, next.placements.map(toInput));
      const [conns, eps] = await Promise.all([
        saveConnectionsAction(rack.id, next.connections),
        saveEndpointsAction(rack.id, next.endpoints),
      ]);
      const bad = !layout.ok ? layout : !conns.ok ? conns : !eps.ok ? eps : null;
      if (bad) { setSaveState("error"); setError(bad.error ?? "Save failed"); return; }
      setSaveState("saved");
    }, 600);
  }
  // Skip the history push (and the save) when the patch didn't actually change anything — a
  // same-value edit (e.g. re-selecting the current status) would otherwise create a dead undo
  // step that visibly does nothing when the user hits ⌘Z.
  function commitState(next: RackState) {
    if (next.placements === placements && next.connections === connections && next.endpoints === endpoints) return;
    setHist((h) => push(h, next));
    queueSave(next);
  }
  // Keep the placement-only helper for the many existing call sites.
  function commit(nextPlacements: PlacementDraft[]) {
    if (nextPlacements === placements) return;
    commitState({ placements: nextPlacements, connections, endpoints });
  }
  function commitConnections(nextConns: Connection[]) {
    if (nextConns === connections) return;
    commitState({ placements, connections: nextConns, endpoints });
  }
  function commitEndpoints(nextEps: PortEndpoint[]) {
    if (nextEps === endpoints) return;
    commitState({ placements, connections, endpoints: nextEps });
  }

  // Undo/redo — buttons + keyboard.
  function doUndo() { const n = undo(hist); if (n !== hist) { setHist(n); queueSave(n.present); } }
  function doRedo() { const n = redo(hist); if (n !== hist) { setHist(n); queueSave(n.present); } }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hist]);

  function insertTemplate(t: PickerTemplate) {
    const at = picker?.atU ?? undefined;
    const slot = findFreeSlot(like, ru, t.rackUnits, heightU, at);
    if (slot === null) { setError("No free slot for that device height"); setPicker(null); return; }
    const typeCode = typeCodeByTypeId[t.deviceTypeId] ?? "DEV";
    const draft: PlacementDraft = {
      id: crypto.randomUUID(), deviceTemplateId: t.id, code: nextCode(like, typeCode), name: null,
      startU: slot, side: "front", status: "installed",
      manufacturer: null, modelName: null, serialNumber: null, purchaseDate: null, operationStart: null,
      frontFace: t.frontFace, backFace: t.backFace, heightU: t.rackUnits,
    };
    commit([...placements, draft]);
    selectDevice(draft.id);
    setPicker(null);
  }

  // Slice 1 port label: "<deviceCode>/<portIndex+1>" — index+1 is sufficient for now; a richer
  // per-group port number can reuse layoutPortGroup's labels later.
  function labelForPort(p: PortRef): string {
    const code = placements.find((pl) => pl.id === p.rackDeviceId)?.code ?? "?";
    return `${code}/${p.portIndex + 1}`;
  }

  const selected = placements.find((p) => p.id === selectedId) ?? null;
  // Derived once so the sidebar can never strand on a stale id (e.g. the connection's device was
  // deleted, or an endpoint's target device vanished): a missing match just falls through to
  // RackSettings instead of rendering nothing.
  const selectedConnection = connections.find((c) => c.id === selectedConnectionId) ?? null;
  // Device selection and connection selection are mutually exclusive in the sidebar (and in the
  // Delete-key handler in RackCanvas), so picking a device always clears any selected connection,
  // and vice versa. The `if (id)` guards preserve the "click empty canvas clears everything" path
  // (RackCanvas calls onSelect(null) then onSelectConnection(null)) — neither clear should
  // resurrect the other selection.
  function selectDevice(id: string | null) {
    setSelectedId(id);
    if (id) setSelectedConnectionId(null);
  }
  function selectConnection(id: string | null) {
    setSelectedConnectionId(id);
    if (id) setSelectedId(null);
  }
  const codeError = selected
    ? validateDeviceCode(selected.code) ??
      (placements.some((p) => p.id !== selected.id && p.code === selected.code) ? "That ID is already used in this rack" : null)
    : null;

  const faceSide = (): "front" | "back" => (side === "FRONT" ? "front" : "back");

  const canvasPlacements = placements
    .filter((p) => templatesById[p.deviceTemplateId])
    .map((p) => ({
      id: p.id, startU: p.startU, code: p.code,
      template: {
        rackUnits: templatesById[p.deviceTemplateId].rackUnits,
        widthIn: templatesById[p.deviceTemplateId].widthIn,
        rackMounted: templatesById[p.deviceTemplateId].rackMounted,
        frontFace: p.frontFace, backFace: p.backFace,
      },
    }));

  return (
    <div className="flex gap-4">
      {/* Palette: rack device types */}
      <div className="w-48 shrink-0 space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Devices</p>
        {types.map((t) => (
          <button key={t.id} type="button" data-testid={`palette-type-${t.code}`}
            onPointerDown={(e) => startPull(e, t.id)}
            onClick={() => setPicker({ initialTypeId: t.id, atU: null })}
            style={{ touchAction: "none" }}
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
            onSelect={selectDevice}
            onAddAt={(u) => setPicker({ initialTypeId: null, atU: u })}
            onMove={(id, targetU) => {
              const resolved = resolveMove(like, ru, id, targetU, heightU);
              const cur = placements.find((p) => p.id === id);
              if (!cur || cur.startU === resolved) return;
              commit(placements.map((p) => (p.id === id ? { ...p, startU: resolved } : p)));
            }}
            onDelete={(id) => {
              commitState({
                placements: placements.filter((p) => p.id !== id),
                connections: connections.filter((c) => c.a.rackDeviceId !== id && c.b.rackDeviceId !== id),
                // A cross-rack target device's deletion is handled by target_rack_device_id's
                // ON DELETE CASCADE — `id` here is always a device in THIS rack, so it can only
                // ever match an endpoint's own port, never a "device"-kind endpoint's target.
                endpoints: endpoints.filter((e) => e.port.rackDeviceId !== id),
              });
              setSelectedId(null);
              setSelectedConnectionId(null);
            }}
            connections={connections}
            selectedConnectionId={selectedConnectionId}
            onSelectConnection={selectConnection}
            onDisconnect={(id) => { commitConnections(removeConnection(connections, id)); setSelectedConnectionId(null); }}
            onPatch={(a, b) => {
              const fs = faceSide();
              const portsByDevice = Object.fromEntries(canvasPlacements.map((p) => [p.id,
                [...portsOf(fs === "front" ? p.template.frontFace : p.template.backFace, p.id, fs)]]));
              const err = validatePatch(connections, portsByDevice, a, b);
              if (err) { setSaveState("error"); setError(err); return; }
              commitConnections(addConnection(connections, a, b));
            }}
            onReplace={(existingIds, a, b) => {
              // Drop every connection blocking either end, then patch the new one — one commit, so
              // it is a single undo step. Both ends can be busy, hence a list.
              const freed = existingIds.reduce((cs, id) => removeConnection(cs, id), connections);
              commitConnections(addConnection(freed, a, b));
            }}
            portLabel={labelForPort}
            dropArmed={dropArmed}
            onDropAt={(u) => {
              const typeId = pullRef.current?.typeId;
              endPull();                                  // clears pullRef before window's pointerup
              if (typeId) setPicker({ initialTypeId: typeId, atU: u });
            }}
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
            onDelete={() => {
              commitState({
                placements: placements.filter((p) => p.id !== selected.id),
                connections: connections.filter((c) => c.a.rackDeviceId !== selected.id && c.b.rackDeviceId !== selected.id),
                // See the RackCanvas onDelete comment: a cross-rack target's deletion is handled
                // by the ON DELETE CASCADE on target_rack_device_id, so this only needs to drop
                // endpoints on the deleted device's own ports.
                endpoints: endpoints.filter((e) => e.port.rackDeviceId !== selected.id),
              });
              setSelectedId(null);
              setSelectedConnectionId(null);
            }}
          />
        ) : null}
        {selected && connections.filter((c) => c.a.rackDeviceId === selected.id || c.b.rackDeviceId === selected.id).map((c) => (
          <div key={c.id} className="mt-2 flex items-center justify-between rounded-md border border-neutral-200 px-2 py-1 text-xs">
            <span>{labelForPort(c.a)} ↔ {labelForPort(c.b)}</span>
            <button type="button" className="text-red-600" onClick={() => {
              commitConnections(removeConnection(connections, c.id)); setSelectedConnectionId(null);
            }}>Disconnect</button>
          </div>
        ))}
        {!selected && selectedConnection && (
          <ConnectionDetails
            connection={selectedConnection}
            endpoints={endpoints}
            floorTypes={floorTypes}
            siteScope={siteScope}
            portLabel={labelForPort}
            onChange={(ep) => commitEndpoints(upsertEndpoint(endpoints, ep))}
            onRemove={(id) => commitEndpoints(removeEndpoint(endpoints, id))}
          />
        )}
        {!selected && !selectedConnection && (
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

      {pullMounted && (
        <PalettePullLayer pullRef={pullRef} scaleOf={() => canvasRef.current?.getScale() ?? 1} />
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
