"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DeviceTemplateListRow, DeviceTypeRow, BrandRow } from "../repository";
import { RackDeviceTable } from "../RackDeviceTable";
import { RackDeviceEditor } from "./RackDeviceEditor";
import type { DeviceDraft } from "./useDeviceDraft";
import {
  saveNewDeviceTemplateAction, saveDeviceTemplateAction,
  getDeviceTemplateAction, createBrandAction, deleteBrandAction,
  duplicateDeviceTemplateAction, deleteDeviceTemplateAction,
} from "../actions";

type EditingState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; id: string; initial: Partial<DeviceDraft> }
  | { mode: "view"; id: string; initial: Partial<DeviceDraft> };

export function EditorLauncher({
  rows, types, brands,
}: { rows: DeviceTemplateListRow[]; types: DeviceTypeRow[]; brands: BrandRow[] }) {
  const router = useRouter();
  const [state, setState] = useState<EditingState>({ mode: "closed" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  function toInput(draft: DeviceDraft) {
    return {
      name: draft.name, brandId: draft.brandId, deviceTypeId: draft.deviceTypeId,
      rackUnits: draft.rackUnits, widthIn: draft.widthIn, rackMounted: draft.rackMounted,
      frontFace: draft.frontFace, backFace: draft.backFace,
    };
  }

  async function openEdit(id: string) {
    setError(null);
    const res = await getDeviceTemplateAction(id);
    if (!res.ok || !res.template) { setError(res.error ?? "Failed to load"); return; }
    const t = res.template;
    setState({
      mode: "edit", id,
      initial: {
        name: t.name, brandId: t.brandId, deviceTypeId: t.deviceTypeId,
        rackUnits: t.rackUnits, widthIn: t.widthIn, rackMounted: t.rackMounted,
        frontFace: t.frontFace, backFace: t.backFace,
      },
    });
  }

  async function openView(id: string) {
    setError(null);
    const res = await getDeviceTemplateAction(id);
    if (!res.ok || !res.template) { setError(res.error ?? "Failed to load"); return; }
    const t = res.template;
    setState({
      mode: "view", id,
      initial: {
        name: t.name, brandId: t.brandId, deviceTypeId: t.deviceTypeId,
        rackUnits: t.rackUnits, widthIn: t.widthIn, rackMounted: t.rackMounted,
        frontFace: t.frontFace, backFace: t.backFace,
      },
    });
  }

  async function duplicate(id: string) {
    setError(null);
    const res = await duplicateDeviceTemplateAction(id);
    if (!res.ok) { setError(res.error ?? "Duplicate failed"); return; }
    router.refresh();
  }

  async function confirmDeleteNow() {
    if (!confirmDelete) return;
    setError(null);
    try {
      await deleteDeviceTemplateAction(confirmDelete.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
    setConfirmDelete(null);
    router.refresh();
  }

  async function save(draft: DeviceDraft) {
    setSaving(true);
    setError(null);
    const res = state.mode === "edit"
      ? await saveDeviceTemplateAction(state.id, toInput(draft))
      : await saveNewDeviceTemplateAction(toInput(draft));
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Save failed"); return; }
    setState({ mode: "closed" });
    router.refresh();
  }

  return (
    <div className="space-y-3">
      {state.mode === "closed" && error && <p className="text-sm text-red-600">{error}</p>}

      <RackDeviceTable
        rows={rows}
        title="Custom Rack Devices"
        onEdit={openEdit}
        onView={openView}
        onDuplicate={duplicate}
        onDelete={(id) => setConfirmDelete({ id, name: rows.find((r) => r.id === id)?.name ?? "" })}
        onCreate={() => { setError(null); setState({ mode: "create" }); }}
      />

      {state.mode !== "closed" && (
        <RackDeviceEditor
          mode={state.mode === "create" ? "create" : "edit"}
          readOnly={state.mode === "view"}
          initial={state.mode === "edit" || state.mode === "view" ? state.initial : undefined}
          types={types}
          brands={brands}
          saving={saving}
          error={error}
          onSave={save}
          onCancel={() => { setState({ mode: "closed" }); setError(null); }}
          onCreateBrand={async (name) => {
            const res = await createBrandAction(name);
            return res.ok && res.brand ? res.brand : null;
          }}
          onDeleteBrand={async (id) => {
            const res = await deleteBrandAction(id);
            return res.ok;
          }}
        />
      )}

      {confirmDelete && (
        <div data-testid="delete-template-confirm" role="alertdialog" aria-label="Delete device"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
            <h3 className="text-base font-bold">Delete “{confirmDelete.name}”?</h3>
            <p className="mt-2 text-sm text-neutral-600">This custom device will be permanently removed from the library.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(null)}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold transition-colors hover:bg-neutral-100">Cancel</button>
              <button type="button" data-testid="delete-template-confirm-btn" onClick={confirmDeleteNow}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
