"use client";

import { useState } from "react";
import type { DeviceTypeRow } from "./repository";
import { createDeviceTypeAction, deleteDeviceTypeAction } from "./typeActions";

export function DeviceTypesPanel({ types }: { types: DeviceTypeRow[] }) {
  const [error, setError] = useState<string | null>(null);
  async function add(formData: FormData) {
    setError(null);
    const res = await createDeviceTypeAction(formData);
    if (!res.ok) setError(res.error ?? "Failed");
  }
  return (
    <div className="space-y-4">
      <form action={add} className="flex items-end gap-2">
        <input name="name" placeholder="New device type…" className="input" required />
        <button type="submit" className="rounded bg-blue-600 px-3 py-2 text-sm text-white">Add</button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </form>
      <ul className="divide-y divide-neutral-800">
        {types.map((t) => (
          <li key={t.id} className="flex items-center justify-between py-2 text-sm">
            <span>{t.name}</span>
            <button
              onClick={() => deleteDeviceTypeAction(t.id)}
              className="text-xs text-red-400"
              title="Delete (blocked if in use)"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
