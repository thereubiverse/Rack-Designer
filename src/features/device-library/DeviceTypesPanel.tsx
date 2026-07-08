"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DeviceTypeRow } from "./repository";
import { createDeviceTypeAction, deleteDeviceTypeAction } from "./typeActions";

export function DeviceTypesPanel({ types }: { types: DeviceTypeRow[] }) {
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  async function add(formData: FormData) {
    setError(null);
    const res = await createDeviceTypeAction(formData);
    if (!res.ok) setError(res.error ?? "Failed");
    else router.refresh();
  }
  async function remove(id: string) {
    setError(null);
    try {
      await deleteDeviceTypeAction(id);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }
  return (
    <div className="space-y-4">
      <form action={add} className="flex items-center gap-2">
        <input
          name="name"
          placeholder="New device type…"
          required
          className="h-9 w-64 rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
        />
        <button type="submit" className="h-9 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9]">Add</button>
        {error && <span className="text-sm text-red-600">{error}</span>}
      </form>
      <ul className="divide-y divide-neutral-100 rounded-xl border border-neutral-200">
        {types.length === 0 && <li className="px-4 py-8 text-center text-sm text-neutral-400">No device types yet.</li>}
        {types.map((t) => (
          <li key={t.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
            <span className="font-medium text-neutral-800">{t.name}</span>
            <button
              onClick={() => remove(t.id)}
              className="text-xs font-semibold text-red-600 transition-colors hover:text-red-700"
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
