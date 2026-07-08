"use client";

import { useState } from "react";

// PREVIEW ONLY: standard lists live here so the page renders without a DB migration. When we wire
// persistence these become the seed, and edits/customs go through server actions. Rack types are
// our existing device types; floor types are seeded from the reference design.
type Category = "floor" | "rack";
type TypeRow = { name: string; code: string };

const STANDARD: Record<Category, TypeRow[]> = {
  floor: [
    { name: "Access Control Panel", code: "ACP" },
    { name: "Access Point", code: "AP" },
    { name: "Camera", code: "CAM" },
    { name: "Desktop", code: "DP" },
    { name: "Telecommunications Outlet", code: "TO" },
    { name: "ISP Uplink", code: "ISP" },
    { name: "Laptop", code: "LP" },
    { name: "Phone", code: "PH" },
    { name: "Printer", code: "PR" },
    { name: "3D Printer", code: "3DP" },
    { name: "Rack", code: "RK" },
    { name: "Screen", code: "SCR" },
  ],
  rack: [
    { name: "Switch", code: "SW" },
    { name: "Router", code: "RT" },
    { name: "Firewall", code: "FW" },
    { name: "Gateway", code: "GW" },
    { name: "Patch Panel", code: "PP" },
    { name: "Server", code: "SRV" },
    { name: "UPS", code: "UPS" },
    { name: "PDU", code: "PDU" },
    { name: "KVM", code: "KVM" },
    { name: "Cable Manager", code: "CM" },
    { name: "Shelf/Tray", code: "ST" },
    { name: "Other", code: "OTH" },
  ],
};

export function DeviceTypesManager() {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <DeviceTypeColumn title="Floor Device Types" standard={STANDARD.floor} />
      <DeviceTypeColumn title="Rack Device Types" standard={STANDARD.rack} />
    </div>
  );
}

let customSeq = 0;
type Custom = { id: number; name: string; code: string };

function DeviceTypeColumn({ title, standard }: { title: string; standard: TypeRow[] }) {
  const [codes, setCodes] = useState<Record<string, string>>(() =>
    Object.fromEntries(standard.map((t) => [t.name, t.code])),
  );
  const [customs, setCustoms] = useState<Custom[]>([]);
  const dirty = standard.some((t) => codes[t.name] !== t.code);

  const half = Math.ceil(standard.length / 2);
  const columns = [standard.slice(0, half), standard.slice(half)];

  return (
    <section className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-5">
      <h2 className="text-xl font-bold text-neutral-900">{title}</h2>

      {/* Standard */}
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm font-semibold text-neutral-700">
          Standard Device Types
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {columns.map((col, ci) => (
              <div key={ci} className="space-y-3">
                {col.map((t) => (
                  <div key={t.name} className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-neutral-800">{t.name}</span>
                    <input
                      value={codes[t.name]}
                      onChange={(e) => setCodes((c) => ({ ...c, [t.name]: e.target.value.toUpperCase().slice(0, 8) }))}
                      className="h-9 w-20 rounded-lg border border-neutral-200 px-2 text-sm text-neutral-600 focus:border-neutral-400 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={!dirty}
            className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9] disabled:opacity-40 disabled:hover:bg-blue-600"
          >
            Save changes
          </button>
        </div>
      </div>

      {/* Custom */}
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-4 py-2.5">
          <span className="text-sm font-semibold text-neutral-700">Custom Device Types</span>
          <button
            type="button"
            onClick={() => setCustoms((cs) => [...cs, { id: ++customSeq, name: "", code: "" }])}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 2v10M2 7h10" /></svg>
            Add
          </button>
        </div>
        <div className="p-4">
          {customs.length === 0 ? (
            <p className="py-6 text-center text-sm text-neutral-400">Click &quot;Add&quot; to create your first custom device type.</p>
          ) : (
            <div className="space-y-2">
              {customs.map((c) => (
                <div key={c.id} className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={c.name}
                    placeholder="Device type name"
                    onChange={(e) => setCustoms((cs) => cs.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))}
                    className="h-9 flex-1 rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
                  />
                  <input
                    value={c.code}
                    placeholder="CODE"
                    onChange={(e) => setCustoms((cs) => cs.map((x) => (x.id === c.id ? { ...x, code: e.target.value.toUpperCase().slice(0, 8) } : x)))}
                    className="h-9 w-24 rounded-lg border border-neutral-200 px-2 text-sm text-neutral-600 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="Remove"
                    onClick={() => setCustoms((cs) => cs.filter((x) => x.id !== c.id))}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
