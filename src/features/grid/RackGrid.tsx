"use client";

import { useMemo, useState } from "react";
import type { RackWithPath } from "@/features/locations/repository";

type SortKey = "label" | "roomType" | "heightU";

export function RackGrid({ racks }: { racks: RackWithPath[] }) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("label");

  const rows = useMemo(() => {
    const filtered = racks.filter((r) =>
      r.label.toLowerCase().includes(query.toLowerCase())
    );
    return [...filtered].sort((a, b) => {
      if (sortKey === "heightU") return a.heightU - b.heightU;
      return String(a[sortKey]).localeCompare(String(b[sortKey]));
    });
  }, [racks, query, sortKey]);

  return (
    <div className="space-y-3">
      <input
        className="w-full max-w-sm rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        placeholder="Search racks…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <table className="w-full text-left text-sm">
        <thead className="text-neutral-400">
          <tr>
            <th className="p-2">
              <button type="button" onClick={() => setSortKey("label")}>Label</button>
            </th>
            <th className="p-2">
              <button type="button" onClick={() => setSortKey("roomType")}>Room type</button>
            </th>
            <th className="p-2">
              <button type="button" onClick={() => setSortKey("heightU")}>Height (U)</button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-neutral-800">
              <td className="p-2 font-mono">{r.label}</td>
              <td className="p-2">{r.roomType}</td>
              <td className="p-2">{r.heightU}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p className="text-sm text-neutral-500">No racks yet. Create one above.</p>
      )}
    </div>
  );
}
