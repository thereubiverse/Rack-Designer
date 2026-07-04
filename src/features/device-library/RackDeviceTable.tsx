"use client";

import { useMemo, useState } from "react";
import type { DeviceTemplateListRow } from "./repository";

export function RackDeviceTable({ rows }: { rows: DeviceTemplateListRow[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => rows.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())),
    [rows, query],
  );
  return (
    <div className="space-y-3">
      <input
        className="w-full max-w-sm rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        placeholder="Search devices…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <table className="w-full text-left text-sm">
        <thead className="text-neutral-400">
          <tr><th className="p-2">Name</th><th className="p-2">Brand</th><th className="p-2">Type</th><th className="p-2">Rack units</th></tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.id} className="border-t border-neutral-800">
              <td className="p-2 font-medium">{r.name}</td>
              <td className="p-2">{r.brandName ?? "—"}</td>
              <td className="p-2">{r.typeName}</td>
              <td className="p-2">{r.rackUnits} RU</td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && <p className="text-sm text-neutral-500">No devices yet. Create one above.</p>}
    </div>
  );
}
