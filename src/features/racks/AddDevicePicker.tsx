"use client";

import { useState } from "react";
import Link from "next/link";
import { Faceplate } from "@/features/device-library/faceplate/Faceplate";
import type { PickerTemplate } from "@/features/device-library/repository";

/** PatchDocs-style Add-device modal: templates of one type on the left, faceplate previews +
 *  Insert on the right. The caller decides where the insert lands. */
export function AddDevicePicker({ typeName, templates, onInsert, onClose }: {
  typeName: string;
  templates: PickerTemplate[];
  onInsert: (t: PickerTemplate) => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = templates.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Add device">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold">Add device</h3>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100">✕</button>
        </div>
        <p className="mt-0.5 text-sm text-neutral-500">{typeName}</p>
        <div className="mt-4 grid grid-cols-[240px_1fr] gap-4">
          <div className="max-h-72 space-y-1.5 overflow-y-auto rounded-xl border border-neutral-200 p-2">
            {templates.length === 0 && (
              <p className="p-4 text-center text-sm text-neutral-400">No {typeName} templates yet.</p>
            )}
            {templates.map((t) => (
              <button key={t.id} type="button" onClick={() => setSelectedId(t.id)}
                className={`block w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  t.id === selectedId ? "border-blue-500 bg-blue-50" : "border-neutral-200 hover:bg-neutral-50"}`}>
                {t.name}
              </button>
            ))}
          </div>
          <div className="flex min-h-72 flex-col rounded-xl border border-neutral-200 p-3">
            {selected ? (
              <>
                <div className="min-h-0 flex-1 space-y-2 overflow-auto">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Front</p>
                  <div className="[&_svg]:h-auto [&_svg]:max-w-full"><Faceplate face={selected.frontFace} side="FRONT" widthIn={selected.widthIn} rackUnits={selected.rackUnits} rackMounted={selected.rackMounted} /></div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Back</p>
                  <div className="[&_svg]:h-auto [&_svg]:max-w-full"><Faceplate face={selected.backFace} side="BACK" widthIn={selected.widthIn} rackUnits={selected.rackUnits} rackMounted={selected.rackMounted} /></div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-neutral-200 pt-3 text-sm text-neutral-600">
                  <span>{selected.rackUnits} RU · Brand: {selected.brandName ?? "—"}</span>
                  <button type="button" data-testid="picker-insert" onClick={() => onInsert(selected)}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Insert device</button>
                </div>
              </>
            ) : (
              <p className="m-auto text-sm text-neutral-400">Select a device to see its details.</p>
            )}
          </div>
        </div>
        <div className="mt-4">
          <Link href="/device-library" className="text-sm font-semibold text-blue-700 hover:underline">+ Create Custom Device</Link>
        </div>
      </div>
    </div>
  );
}
