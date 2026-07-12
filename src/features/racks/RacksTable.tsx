"use client";

import Link from "next/link";
import type { RackWithPath } from "@/features/locations/repository";

export type RackListRow = RackWithPath & { deviceCount: number };

/** Card table of racks — same design language as RackDeviceTable (title/search live in page). */
export function RacksTable({ racks }: { racks: RackListRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50">
            {["Rack", "Path", "Height", "Devices"].map((h) => (
              <th key={h} className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {racks.map((r) => (
            <tr key={r.id} className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50">
              <td className="px-5 py-3 font-medium">
                <Link href={`/racks/${r.id}`} className="text-blue-700 hover:underline">{r.rackCode}</Link>
              </td>
              <td className="px-5 py-3 text-neutral-600">{r.label}</td>
              <td className="px-5 py-3 text-neutral-600">{r.heightU} U</td>
              <td className="px-5 py-3 text-neutral-600">{r.deviceCount}</td>
            </tr>
          ))}
          {racks.length === 0 && (
            <tr><td colSpan={4} className="px-5 py-14 text-center text-sm text-neutral-400">No racks yet. Create one to get started.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
