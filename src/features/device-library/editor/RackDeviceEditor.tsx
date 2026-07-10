"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { MEDIA, MAX_BODY_WIDTH_IN, CONNECTORS, type Media, type IconElement } from "@/domain/faceplate";
import { PortGlyph } from "@/features/device-library/faceplate/portGlyphs";
import type { DeviceTypeRow, BrandRow } from "../repository";
import { useDeviceDraft, type DeviceDraft } from "./useDeviceDraft";
import { DeviceWizard, type WizardApply } from "./DeviceWizard";
import { layoutDetectedFace } from "../ai/layoutDetectedFace";
import { EditorCanvas } from "./EditorCanvas";
import { frameDims, layoutPortGroup, GRID_PX } from "@/domain/faceplate-geometry";
import { PortGroupSettings } from "./PortGroupSettings";
import { PortSettings, BatchSettings } from "./PortSettings";
import { BrandPicker } from "./BrandPicker";
import { Select } from "./Select";
import { IconPicker } from "./IconPicker";
import { IconSettings } from "./IconSettings";
import { addIconElement, resizeElements, deleteElement, resolveIconDrop, duplicateElements, placeElements, setElementsColor, setElementsOpacity, setElementsIcon, ICON_DEFAULT_SIZE } from "./elementOps";
import {
  addPortGroup, movePortGroup, moveGroups, duplicateGroups, addColumn, addRow, removeColumn, removeRow, updatePortGroup, deletePortGroup,
  setPortOverride, setPortMedia, setSpacing, patchPorts, rotatePorts, deletePortGroups, allPortIndices, setGroupYOffset, setRowLabels,
  type GridBounds, type PortRef,
} from "./portGroupOps";

// The seeded default brand — always available, never deletable.
const PROTECTED_BRAND_NAME = "Generic";

// The Icon element chip's glyph — shared by the palette chip and its drag ghost.
const ELEMENT_ICON_GLYPH = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6.5" cy="6.5" r="3.5" /><path d="M2.5 21h8l-4 -7z" /><path d="M14 3l7 7" /><path d="M14 14h7v7h-7z" /></svg>
);

const MEDIA_LABELS: Record<Media, string> = {
  copper: "Copper", fiber: "Fiber", sfp: "SFP", usb_a: "USB-A", usb_c: "USB-C",
  hdmi: "HDMI", dp: "DP", vga: "VGA", ps2: "PS/2", audio: "Audio",
};

export interface RackDeviceEditorProps {
  mode: "create" | "edit";
  initial?: Partial<DeviceDraft>;
  types: DeviceTypeRow[];
  brands: BrandRow[];
  wizardEnabled: boolean;
  wizardHasKey: boolean;
  saving?: boolean;
  error?: string | null;
  readOnly?: boolean;
  onSave: (draft: DeviceDraft) => void;
  onCancel: () => void;
  onCreateBrand?: (name: string) => Promise<BrandRow | null>;
  onDeleteBrand?: (id: string) => Promise<boolean>;
}

export function RackDeviceEditor(props: RackDeviceEditorProps) {
  const ro = props.readOnly === true;
  const { draft, activeFace, setField, setActiveSide, setActiveFace, errors, isValid, isDirty } = useDeviceDraft(props.initial);
  // Shown when the user tries to close a device that has unsaved work (Cancel / ✕ / Escape).
  const [confirmClose, setConfirmClose] = useState(false);
  // Every close path routes through here: warn first if there's unsaved work, else close.
  function attemptClose() { if (isDirty) setConfirmClose(true); else props.onCancel(); }
  const [brands, setBrands] = useState(props.brands);

  // Applies a wizard result to the draft: replaces the current side's face outright,
  // but only pre-fills metadata that's still empty/default — never overwrites work
  // the user already entered, and never shrinks a device they already sized.
  function applyWizard(a: WizardApply) {
    // Resolve final dimensions BEFORE laying out, so a multi-U device gets the right frame
    // height and its detected vertical layout isn't collapsed. Only adopt dims when the draft
    // is still at defaults (never shrink a user-sized device), from what detection read.
    const finalRackUnits = draft.rackUnits === 1 ? (a.detected.rackUnits ?? 1) : draft.rackUnits;
    const finalWidthIn = draft.widthIn === 17.5 ? (a.detected.widthIn ?? 17.5) : draft.widthIn;
    if (finalRackUnits !== draft.rackUnits) setField("rackUnits", finalRackUnits);
    if (finalWidthIn !== draft.widthIn) setField("widthIn", finalWidthIn);
    setActiveFace(layoutDetectedFace(a.detected, { widthIn: finalWidthIn, rackUnits: finalRackUnits }));
    const suggestedName = a.detected.modelText;
    if (!draft.name.trim() && suggestedName) setField("name", suggestedName);
    const brandName = a.detected.brand;
    if (draft.brandId === null && brandName) {
      const hit = brands.find((b) => b.name.toLowerCase() === brandName.toLowerCase());
      if (hit) setField("brandId", hit.id);
    }
  }
  // Selection is a set of groups; ports are a set within a SINGLE selected group.
  // Port-multi and group-multi are mutually exclusive.
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [selectedPortIndices, setSelectedPortIndices] = useState<number[]>([]);
  const [snapToGrid, setSnapToGrid] = useState(false); // toggle only for now; snapping wired in a later slice
  // Where the Icon chip was dropped (device coords) — non-null while the icon picker is open.
  const [iconPickerAt, setIconPickerAt] = useState<{ x: number; y: number } | null>(null);
  // When true the icon picker is open to REPLACE the icon on the current selection (vs. place a new one).
  const [iconReplaceOpen, setIconReplaceOpen] = useState(false);
  const [selectedElementIds, setSelectedElementIds] = useState<string[]>([]);
  // Live palette drag: a full-size, blue-bordered clone of the chip that follows the cursor
  // (the native drag image is suppressed). It's anchored to where the cursor grabbed it
  // (grabDX/grabDY) and matches the source chip's size so it doesn't appear to shrink.
  const [paletteDrag, setPaletteDrag] = useState<
    { id: string; content: ReactNode; media?: Media; x: number; y: number; grabDX: number; grabDY: number; width: number; height: number } | null
  >(null);
  const dragImgRef = useRef<HTMLImageElement | null>(null);
  function transparentDragImage(): HTMLImageElement {
    if (!dragImgRef.current) {
      const img = new Image();
      img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      dragImgRef.current = img;
    }
    return dragImgRef.current;
  }
  // While a palette drag is active, keep the clone under the cursor.
  const paletteDragging = paletteDrag !== null;
  useEffect(() => {
    if (!paletteDragging) return;
    function onDragOver(e: DragEvent) {
      setPaletteDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    }
    document.addEventListener("dragover", onDragOver);
    return () => document.removeEventListener("dragover", onDragOver);
  }, [paletteDragging]);
  const dims = frameDims({
    widthIn: draft.widthIn > 0 ? draft.widthIn : 1,
    rackUnits: draft.rackUnits >= 1 ? draft.rackUnits : 1,
    rackMounted: draft.rackMounted,
  });
  const bounds: GridBounds = { width: dims.bodyWidthPx, height: dims.heightPx };
  // The single selected group (group settings + port targets only exist in single-group mode).
  const singleGroupId = selectedGroupIds.length === 1 ? selectedGroupIds[0] : null;
  const selectedGroup = activeFace.portGroups.find((g) => g.id === singleGroupId) ?? null;
  const multiGroup = selectedGroupIds.length >= 2;
  // Exactly one port selected in one group → the full single-port panel + palette retype.
  const singlePortIndex = singleGroupId !== null && selectedPortIndices.length === 1 ? selectedPortIndices[0] : null;
  // The selected icon elements → drive the icon-settings panel. Colour/opacity are the selection's
  // common value, or null when it disagrees (the panel then falls back to the defaults).
  const selectedIcons = activeFace.elements.filter(
    (e): e is IconElement => e.kind === "icon" && selectedElementIds.includes(e.id),
  );
  const common = <T,>(vals: T[]): T | null => (vals.length > 0 && vals.every((v) => v === vals[0]) ? vals[0] : null);
  const iconColor = common(selectedIcons.map((e) => e.color ?? null));
  const iconOpacity = common(selectedIcons.map((e) => e.opacity ?? null));

  function clearSelection() {
    setSelectedGroupIds([]);
    setSelectedPortIndices([]);
    setSelectedElementIds([]);
  }

  // Click a group box → just that group; shift+click → toggle it in the set (group-multi).
  function selectGroup(id: string | null, additive = false) {
    if (id === null) return clearSelection();
    setSelectedElementIds([]); // groups and icon elements are mutually-exclusive selections
    setSelectedPortIndices([]);
    setSelectedGroupIds((prev) =>
      additive ? (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]) : [id]);
  }

  // Click a port → that one port in its group; shift+click within the same single group
  // → toggle it (port-multi). Shift+click elsewhere resets to that port's group.
  function selectPort(index: number, additive = false) {
    if (additive && singleGroupId !== null) {
      setSelectedPortIndices((prev) =>
        prev.includes(index) ? prev.filter((x) => x !== index) : [...prev, index]);
    } else {
      setSelectedPortIndices([index]);
    }
  }

  // Ports the batch controls act on: the selected ports (single-group) or every port in
  // each selected group (multi-group).
  function targetRefs(): PortRef[] {
    if (multiGroup) {
      return selectedGroupIds.map((gid) => {
        const g = activeFace.portGroups.find((x) => x.id === gid);
        return { groupId: gid, indices: g ? allPortIndices(g) : [] };
      });
    }
    if (singleGroupId !== null && selectedPortIndices.length > 0) {
      return [{ groupId: singleGroupId, indices: selectedPortIndices }];
    }
    return [];
  }

  // Effective rotation + label position of every target port (label pos is derived when
  // not overridden, so read it from the layout the same way the single-port panel does).
  function targetState(): { rotations: number[]; labels: ("top" | "bottom")[] } {
    const rotations: number[] = [];
    const labels: ("top" | "bottom")[] = [];
    for (const ref of targetRefs()) {
      const g = activeFace.portGroups.find((x) => x.id === ref.groupId);
      if (!g) continue;
      const cells = layoutPortGroup(g, dims.heightPx).cells;
      for (const i of ref.indices) {
        rotations.push(g.portOverrides[i]?.rotation ?? 0);
        labels.push(cells.find((c) => c.index === i)?.labelPos ?? "top");
      }
    }
    return { rotations, labels };
  }

  function stepWidth(delta: number) {
    const next = Math.round((draft.widthIn + delta) * 10) / 10; // avoid float drift
    setField("widthIn", Math.min(MAX_BODY_WIDTH_IN, Math.max(0.1, next)));
  }

  function switchSide(next: "front" | "back") {
    clearSelection();
    setActiveSide(next);
  }

  const side = draft.activeSide === "front" ? "FRONT" : "BACK";

  // Rotate the current selection 180° per click — one port, many ports, or every port in
  // the selected groups. Disabled when nothing rotatable is selected.
  const canRotate = targetRefs().some((r) => r.indices.length > 0);
  function rotateSelection() {
    const refs = targetRefs();
    if (refs.every((r) => r.indices.length === 0)) return;
    setActiveFace(rotatePorts(activeFace, refs, 180));
  }

  // "Other" always sits at the bottom of the device-type list.
  const orderedTypes = [
    ...props.types.filter((t) => t.name !== "Other"),
    ...props.types.filter((t) => t.name === "Other"),
  ];

  // Escape asks to close (behaves like Cancel) — guarded so unsaved work can't vanish.
  // Delete/Backspace removes the selected group(s) — but not while typing in a field
  // (on macOS the "delete" key reports as Backspace, so handle both).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (ro) { if (e.key === "Escape") props.onCancel(); return; }
      if (e.key === "Escape") { if (isDirty) setConfirmClose(true); else props.onCancel(); return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
        if (selectedGroupIds.length > 0) {
          e.preventDefault();
          setActiveFace(deletePortGroups(activeFace, selectedGroupIds));
          clearSelection();
        } else if (selectedElementIds.length > 0) {
          e.preventDefault();
          setActiveFace((prev) => selectedElementIds.reduce((f, id) => deleteElement(f, id), prev));
          clearSelection();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props, ro, isDirty, selectedGroupIds, selectedElementIds, activeFace, setActiveFace]);

  return (
    <div
      data-testid="rack-device-editor"
      role="dialog"
      aria-label="Rack Device Editor"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-[6vh]"
    >
      <div className="no-select-ui w-full max-w-[1000px] rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold">Rack Device Editor</h2>
            {!ro && <DeviceWizard enabled={props.wizardEnabled} hasKey={props.wizardHasKey} widthIn={draft.widthIn} rackUnits={draft.rackUnits} onApply={applyWizard} />}
          </div>
          <button aria-label="Close" onClick={ro ? props.onCancel : attemptClose} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100">✕</button>
        </div>

        {ro && (
          <div data-testid="readonly-banner" className="mb-4 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg>
            You are viewing this custom rack device in read-only mode.
          </div>
        )}

        {/* Header fields — Rack units + Width kept narrow so the wider Name/Brand/
            Device type columns have room (e.g. the brand "＋" edit row). */}
        <fieldset disabled={ro} className="contents">
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
                  className="flex flex-1 items-center justify-center text-neutral-500 transition-colors hover:bg-neutral-100"
                  onClick={() => stepWidth(0.1)}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6 -6l6 6" /></svg>
                </button>
                <button type="button" tabIndex={-1} aria-label="Decrease width by 0.1"
                  className="flex flex-1 items-center justify-center border-t border-neutral-200 text-neutral-500 transition-colors hover:bg-neutral-100"
                  onClick={() => stepWidth(-0.1)}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6l6 -6" /></svg>
                </button>
              </div>
            </div>
          </label>
        </div>
        </fieldset>

        {/* Canvas + palette + toggles. Clicking any empty space here deselects the
            current group/port — group boxes and port targets stopPropagation so
            selecting them isn't undone by this. */}
        <div
          className={`rounded-xl border border-neutral-100 bg-neutral-100 p-4 ${ro ? "pointer-events-none opacity-70" : ""}`}
          onClick={() => clearSelection()}
          inert={ro || undefined}
        >
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-stretch gap-2">
              <span className="flex items-center justify-center text-[10px] font-medium text-neutral-400" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Port Types</span>
              <div className="grid grid-cols-5 gap-2 rounded-lg border border-neutral-200 bg-white p-2">
                {MEDIA.map((m) => {
                  const portSelected = singleGroupId != null && singlePortIndex !== null;
                  return (
                    <span key={m} draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", m);
                        e.dataTransfer.effectAllowed = "move"; // "move" so dropEffect can suppress the "+" badge
                        e.dataTransfer.setDragImage(transparentDragImage(), 0, 0); // hide the default ghost
                        const rect = e.currentTarget.getBoundingClientRect();
                        setPaletteDrag({
                          id: m, media: m,
                          content: <><span className="text-neutral-900"><PortGlyph media={m} /></span>{MEDIA_LABELS[m]}</>,
                          x: e.clientX, y: e.clientY,
                          grabDX: e.clientX - rect.left, grabDY: e.clientY - rect.top,
                          width: rect.width, height: rect.height,
                        });
                      }}
                      onDragEnd={() => setPaletteDrag(null)}
                      onClick={(e) => {
                        if (!portSelected) return;
                        e.stopPropagation(); // keep the port selected so its settings stay shown
                        setActiveFace(setPortMedia(activeFace, singleGroupId!, singlePortIndex!, m));
                      }}
                      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-neutral-800 transition-colors ${paletteDrag?.id === m ? "opacity-40" : ""} ${portSelected ? "cursor-pointer border-neutral-200 hover:border-blue-400 hover:bg-blue-50" : "cursor-grab border-neutral-200 hover:bg-neutral-100"}`}
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
                <span
                  data-testid="element-icon"
                  draggable
                  title="Drag onto the device to place an icon"
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/plain", "element:icon");
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setDragImage(transparentDragImage(), 0, 0); // hide the default ghost
                    const rect = e.currentTarget.getBoundingClientRect();
                    setPaletteDrag({
                      id: "element:icon",
                      content: <><span className="text-neutral-900">{ELEMENT_ICON_GLYPH}</span>Icon</>,
                      x: e.clientX, y: e.clientY,
                      grabDX: e.clientX - rect.left, grabDY: e.clientY - rect.top,
                      width: rect.width, height: rect.height,
                    });
                  }}
                  onDragEnd={() => setPaletteDrag(null)}
                  className={`flex cursor-grab items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-700 transition-colors hover:bg-neutral-100 ${paletteDrag?.id === "element:icon" ? "opacity-40" : ""}`}
                >
                  {ELEMENT_ICON_GLYPH}
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
                className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${snapToGrid ? "border-blue-600 bg-blue-50 text-blue-600" : "border-neutral-200 bg-white text-neutral-400 hover:bg-neutral-100"}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></svg>
              </button>
              <button type="button" data-testid="rotate-element" aria-label="Rotate clockwise" title="Rotate clockwise"
                disabled={!canRotate}
                onClick={rotateSelection}
                className={`flex h-9 w-9 items-center justify-center rounded-lg border transition-colors ${canRotate ? "border-neutral-300 bg-white text-neutral-700 hover:bg-neutral-100" : "border-neutral-200 bg-white text-neutral-300"}`}>
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
                className="flex h-9 items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-2.5 text-xs font-medium transition-colors hover:bg-neutral-100"
                onClick={() => setField("rackMounted", !draft.rackMounted)}>
                Rack Mounted
                <span className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${draft.rackMounted ? "bg-blue-600" : "bg-neutral-300"}`}>
                  <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all ${draft.rackMounted ? "left-3.5" : "left-0.5"}`} />
                </span>
              </button>
            </div>
          </div>

          <div className={`mt-2 overflow-auto ${ro ? "pointer-events-none" : ""}`} inert={ro || undefined}>
            <EditorCanvas
              face={activeFace}
              widthIn={draft.widthIn > 0 ? draft.widthIn : 1}
              rackUnits={draft.rackUnits >= 1 ? draft.rackUnits : 1}
              rackMounted={draft.rackMounted}
              side={side}
              selectedGroupIds={selectedGroupIds}
              onSelect={selectGroup}
              onMarqueeSelect={(groupIds, elementIds, additive) => {
                setSelectedPortIndices([]);
                setSelectedGroupIds((prev) => (additive ? [...new Set([...prev, ...groupIds])] : groupIds));
                setSelectedElementIds((prev) => (additive ? [...new Set([...prev, ...elementIds])] : elementIds));
              }}
              onCreate={(media, pos) => {
                const before = activeFace.portGroups.length;
                const next = addPortGroup(activeFace, media, pos, bounds, snapToGrid ? GRID_PX : 1);
                setActiveFace(next);
                if (next.portGroups.length > before) selectGroup(next.portGroups[next.portGroups.length - 1].id);
              }}
              snapToGrid={snapToGrid}
              paletteDragMedia={paletteDrag?.media ?? null}
              onMove={(id, target) => setActiveFace(movePortGroup(activeFace, id, target, bounds, { snap: false, allowVertical: (draft.rackUnits >= 1 ? draft.rackUnits : 1) >= 2 }))}
              onMoveGroups={(ids, delta) => setActiveFace(moveGroups(activeFace, ids, delta, bounds))}
              onDropIcon={(pos) => setIconPickerAt(pos)}
              paletteDragIcon={paletteDrag?.id === "element:icon"}
              selectedElementIds={selectedElementIds}
              onSelectElement={(id, additive) => {
                if (additive) { setSelectedElementIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]); return; }
                setSelectedElementIds([id]); setSelectedGroupIds([]); setSelectedPortIndices([]);
              }}
              onMoveElements={(moves) => setActiveFace((prev) => placeElements(prev, moves))}
              onResizeElements={(sizes) => setActiveFace((prev) => resizeElements(prev, sizes))}
              onDuplicateElements={(ids) => {
                const { face: nf, newIds } = duplicateElements(activeFace, ids);
                setActiveFace(nf);
                setSelectedElementIds(newIds); // drag the copies
                return newIds;
              }}
              onVerticalMove={(id, yOffset, labelPos) => setActiveFace((prev) => {
                // Snap the row's offset and set every port's label to the side the snapped position
                // implies. Functional update so it composes with the spacing commit fired in the
                // same drag move.
                const g = prev.portGroups.find((x) => x.id === id);
                const refs = g ? [{ groupId: id, indices: allPortIndices(g) }] : [];
                return patchPorts(setGroupYOffset(prev, id, yOffset), refs, { labelPos });
              })}
              onDuplicate={(ids) => {
                const { face: nf, newIds } = duplicateGroups(activeFace, ids);
                setActiveFace(nf);
                setSelectedPortIndices([]);
                setSelectedGroupIds(newIds);
                return newIds;
              }}
              onDuplicateDrop={(newIds, delta) => {
                // Discard the copies on a no-move or an overlapping drop; otherwise place them.
                setActiveFace((prev) => {
                  if (!delta) return deletePortGroups(prev, newIds);
                  const moved = moveGroups(prev, newIds, delta, bounds);
                  return moved === prev ? deletePortGroups(prev, newIds) : moved;
                });
              }}
              onAddColumn={(id) => setActiveFace((prev) => addColumn(prev, id, bounds))}
              onAddRow={(id) => setActiveFace((prev) => addRow(prev, id, bounds))}
              onRemoveColumn={(id) => setActiveFace((prev) => removeColumn(prev, id))}
              onRemoveRow={(id) => setActiveFace((prev) => removeRow(prev, id))}
              selectedPortIndices={singleGroupId !== null ? selectedPortIndices : []}
              onSelectPort={selectPort}
              onPortMedia={(gid, index, media) => {
                setActiveFace(setPortMedia(activeFace, gid, index, media));
                setSelectedGroupIds([gid]);
                setSelectedPortIndices([index]); // select the changed port so its settings show
              }}
              onSpacing={(id, spacing) => setActiveFace((prev) => setSpacing(prev, id, spacing))}
              onRowSnap={(id, colSpacing, rowSpacing, labels) => setActiveFace((prev) =>
                setRowLabels(setSpacing(prev, id, { colSpacing, rowSpacing }), id, labels))}
              highlight={singleGroupId !== null ? selectedPortIndices.map((i) => ({ groupId: singleGroupId, portIndex: i })) : []}
            />
          </div>
        </div>

        {selectedIcons.length > 0 ? (
          <div className="mt-4 rounded-xl border border-neutral-200 p-4">
            <IconSettings
              count={selectedIcons.length}
              color={iconColor}
              opacity={iconOpacity}
              onColor={(c) => setActiveFace((prev) => setElementsColor(prev, selectedElementIds, c))}
              onOpacity={(o) => setActiveFace((prev) => setElementsOpacity(prev, selectedElementIds, o))}
              onSelectIcon={() => setIconReplaceOpen(true)}
              onDelete={() => { setActiveFace((prev) => selectedElementIds.reduce((f, id) => deleteElement(f, id), prev)); setSelectedElementIds([]); }}
            />
          </div>
        ) : multiGroup ? (() => {
          const { rotations, labels } = targetState();
          const rotated = rotations.length && rotations.every((r) => r % 360 !== 0) ? "on"
            : rotations.every((r) => r % 360 === 0) ? "off" : "mixed";
          const labelPos = labels.length && labels.every((l) => l === "bottom") ? "bottom"
            : labels.every((l) => l === "top") ? "top" : "mixed";
          return (
            <div className="mt-4 rounded-xl border border-neutral-200 p-4">
              <BatchSettings
                title={`${selectedGroupIds.length} groups selected`}
                rotated={rotated}
                labelPos={labelPos}
                // Labels are owned by each group's left up/down handle, so hide the batch toggle.
                hideLabel
                onFlip={() => setActiveFace(patchPorts(activeFace, targetRefs(), { rotation: rotated === "on" ? 0 : 180 }))}
                onLabel={() => setActiveFace(patchPorts(activeFace, targetRefs(), { labelPos: labelPos === "bottom" ? "top" : "bottom" }))}
                onDelete={() => { setActiveFace(deletePortGroups(activeFace, selectedGroupIds)); clearSelection(); }}
                deleteLabel="Delete groups"
              />
            </div>
          );
        })() : selectedGroup ? (
          <div className="mt-4 flex flex-wrap gap-5 rounded-xl border border-neutral-200 p-4">
            <div className="min-w-0 flex-1">
              <PortGroupSettings
                embedded
                group={selectedGroup}
                onChange={(patch) => setActiveFace(updatePortGroup(activeFace, selectedGroup.id, patch))}
                onDelete={() => { setActiveFace(deletePortGroup(activeFace, selectedGroup.id)); clearSelection(); }}
              />
            </div>
            <div className="flex w-full flex-col rounded-lg border border-dashed border-neutral-300 p-3 sm:w-[230px]">
              {selectedPortIndices.length >= 2 ? (() => {
                const { rotations, labels } = targetState();
                const rotated = rotations.length && rotations.every((r) => r % 360 !== 0) ? "on"
                  : rotations.every((r) => r % 360 === 0) ? "off" : "mixed";
                const labelPos = labels.length && labels.every((l) => l === "bottom") ? "bottom"
                  : labels.every((l) => l === "top") ? "top" : "mixed";
                return (
                  <BatchSettings
                    title={`${selectedPortIndices.length} ports selected`}
                    rotated={rotated}
                    labelPos={labelPos}
                    hideLabel
                    onFlip={() => setActiveFace(patchPorts(activeFace, targetRefs(), { rotation: rotated === "on" ? 0 : 180 }))}
                    onLabel={() => setActiveFace(patchPorts(activeFace, targetRefs(), { labelPos: labelPos === "bottom" ? "top" : "bottom" }))}
                  />
                );
              })() : singlePortIndex !== null ? (() => {
                const cell = layoutPortGroup(selectedGroup, undefined).cells.find((c) => c.index === singlePortIndex);
                const ov = selectedGroup.portOverrides[singlePortIndex] ?? {};
                return (
                  <PortSettings
                    embedded
                    hideLabel
                    portLabel={cell ? cell.label : String(singlePortIndex + 1)}
                    name={ov.name ?? ""}
                    rotation={ov.rotation ?? 0}
                    labelPos={cell ? cell.labelPos : "top"}
                    typeLabel={ov.media ? MEDIA_LABELS[ov.media] : undefined}
                    connectorType={cell?.connectorType}
                    connectorOptions={ov.media ? CONNECTORS[ov.media] : undefined}
                    onChange={(patch) => setActiveFace(setPortOverride(activeFace, selectedGroup.id, singlePortIndex, patch))}
                  />
                );
              })() : (
                <span className="m-auto text-center text-xs text-neutral-400">Select a port to edit its name. Shift+click to select several.</span>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-neutral-200 p-6 text-center text-xs text-neutral-400">
            Drag a port type onto the grid to add a group. Select a group to edit it; shift+click to select several.
          </div>
        )}

        {props.error && <p className="mt-3 text-sm text-red-600">{props.error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          {ro ? (
            <button type="button" data-testid="editor-close" onClick={props.onCancel}
              className="rounded-lg border border-neutral-200 px-5 py-2 text-sm font-semibold transition-colors hover:bg-neutral-100">Close</button>
          ) : (
            <>
              <button type="button" data-testid="editor-cancel" onClick={attemptClose}
                className="rounded-lg border border-neutral-200 px-5 py-2 text-sm font-semibold transition-colors hover:bg-neutral-100">Cancel</button>
              <button
                type="button"
                data-testid="editor-save"
                disabled={!isValid || props.saving}
                onClick={() => onSaveGuard(isValid, props.saving, () => props.onSave(draft))}
                className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9] disabled:opacity-40 disabled:hover:bg-blue-600"
              >
                {props.saving ? "Saving…" : props.mode === "create" ? "Create" : "Save"}
              </button>
            </>
          )}
        </div>

        {/* consumed so errors object isn't flagged as unused when wired in 3b */}
        <span className="hidden">{Object.values(errors).join("")}</span>
      </div>

      {/* Full-size, blue-bordered clone of the dragged palette chip, anchored to the cursor's
          grab point so it doesn't jump or shrink when picked up. */}
      {paletteDrag && (
        <div
          data-testid="palette-drag-ghost"
          className="pointer-events-none fixed z-[1000] flex items-center gap-1 rounded-md border border-blue-500 bg-white px-2 py-1 text-xs text-neutral-800 opacity-80 shadow-md"
          style={{ left: paletteDrag.x - paletteDrag.grabDX, top: paletteDrag.y - paletteDrag.grabDY, width: paletteDrag.width, height: paletteDrag.height }}
        >
          {paletteDrag.content}
        </div>
      )}
      {(iconPickerAt || iconReplaceOpen) && (
        <IconPicker
          onClose={() => { setIconPickerAt(null); setIconReplaceOpen(false); }}
          onPick={(iconName) => {
            if (iconReplaceOpen) {
              const ids = selectedElementIds;
              setActiveFace((prev) => setElementsIcon(prev, ids, iconName)); // swap the icon on the selection
              setIconReplaceOpen(false);
              return;
            }
            // land exactly where the drop-preview box showed (centred on the drop point, clamped)
            const { gridX, gridY } = resolveIconDrop(iconPickerAt!.x, iconPickerAt!.y, ICON_DEFAULT_SIZE, bounds);
            setActiveFace((prev) => addIconElement(prev, { gridX, gridY, iconName }));
            setIconPickerAt(null);
          }}
        />
      )}
      {confirmClose && (
        <div
          data-testid="discard-confirm"
          role="alertdialog"
          aria-label="Discard changes"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
        >
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
            <h3 className="text-base font-bold">Discard this device?</h3>
            <p className="mt-2 text-sm text-neutral-600">
              You have unsaved changes. If you close now, your progress will be lost.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="discard-cancel"
                onClick={() => setConfirmClose(false)}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold transition-colors hover:bg-neutral-100"
              >
                Keep editing
              </button>
              <button
                type="button"
                data-testid="discard-confirm-btn"
                onClick={() => { setConfirmClose(false); props.onCancel(); }}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700"
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function onSaveGuard(isValid: boolean, saving: boolean | undefined, run: () => void) {
  if (isValid && !saving) run();
}
