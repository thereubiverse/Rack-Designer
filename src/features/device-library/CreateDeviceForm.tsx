"use client";

import { useState } from "react";
import type { DeviceTypeRow, BrandRow } from "./repository";
import { createDeviceTemplateAction } from "./actions";

export function CreateDeviceForm({ types, brands }: { types: DeviceTypeRow[]; brands: BrandRow[] }) {
  const [error, setError] = useState<string | null>(null);
  async function action(formData: FormData) {
    setError(null);
    const res = await createDeviceTemplateAction(formData);
    if (!res.ok) setError(res.error ?? "Failed");
  }
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input name="name" placeholder="Device name" className="input" required />
      <select name="deviceTypeId" className="input" required defaultValue="">
        <option value="" disabled>Device type…</option>
        {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select name="brandId" className="input" defaultValue="">
        <option value="">Brand (optional)</option>
        {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <input name="rackUnits" type="number" min={1} defaultValue={1} className="input w-20" title="Rack units" />
      <input name="widthIn" type="number" step="0.1" min={1} defaultValue={19} className="input w-24" title="Width (in)" />
      <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="rackMounted" defaultChecked /> Rack mounted</label>
      <button type="submit" className="rounded bg-blue-600 px-3 py-2 text-sm text-white">Create</button>
      {error && <span className="text-sm text-red-400">{error}</span>}
    </form>
  );
}
