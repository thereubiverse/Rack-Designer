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
} from "../actions";

type EditingState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; id: string; initial: Partial<DeviceDraft> };

export function EditorLauncher({
  rows, types, brands,
}: { rows: DeviceTemplateListRow[]; types: DeviceTypeRow[]; brands: BrandRow[] }) {
  const router = useRouter();
  const [state, setState] = useState<EditingState>({ mode: "closed" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <div className="space-y-4">
      <div>
        <button
          onClick={() => { setError(null); setState({ mode: "create" }); }}
          className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
        >Create device</button>
      </div>

      {state.mode === "closed" && error && <p className="text-sm text-red-500">{error}</p>}

      <RackDeviceTable rows={rows} onEdit={openEdit} />

      {state.mode !== "closed" && (
        <RackDeviceEditor
          mode={state.mode}
          initial={state.mode === "edit" ? state.initial : undefined}
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
    </div>
  );
}
