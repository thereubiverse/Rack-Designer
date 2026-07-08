"use client";

import { useMemo, useState } from "react";
import type { DeviceTemplateListRow } from "./repository";

type SortKey = "name" | "brandName" | "typeName" | "rackUnits";
type SortDir = "asc" | "desc";

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "brandName", label: "Brand" },
  { key: "typeName", label: "Type" },
  { key: "rackUnits", label: "Rack units" },
];

const PAGE_SIZES = [10, 20, 50];

/** The Custom Rack Devices card: a search + Create toolbar, a sortable table, and a pagination
 *  footer — styled to match the device editor (light card, neutral borders, blue accent). */
export function RackDeviceTable({
  rows, onEdit, onCreate, title,
}: {
  rows: DeviceTemplateListRow[];
  onEdit?: (id: string) => void;
  onCreate?: () => void;
  title?: string;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" });
  const [pageSize, setPageSize] = useState(10);
  const [page, setPage] = useState(1);

  const filtered = useMemo(
    () => rows.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())),
    [rows, query],
  );

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
    });
  }, [filtered, sort]);

  const totalPages = Math.ceil(sorted.length / pageSize);
  const current = Math.min(page, Math.max(1, totalPages));
  const pageRows = sorted.slice((current - 1) * pageSize, current * pageSize);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    setPage(1);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        {title && <h2 className="text-lg font-bold text-neutral-900">{title}</h2>}
        <div className="ml-auto flex items-center gap-2">
          <input
            className="h-9 w-56 rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 placeholder:text-neutral-400 focus:border-neutral-400 focus:outline-none"
            placeholder="Search…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
          />
          {onCreate && (
            <button
              type="button"
              data-testid="table-create"
              onClick={onCreate}
              className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9]"
            >
              <PlusIcon /> Create
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-y border-neutral-200 bg-neutral-50">
            {COLUMNS.map((c) => (
              <th key={c.key} className="px-5 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleSort(c.key)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500 transition-colors hover:text-neutral-800"
                >
                  {c.label}
                  <SortIcon dir={sort.key === c.key ? sort.dir : null} />
                </button>
              </th>
            ))}
            <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Actions</th>
          </tr>
        </thead>
        <tbody>
          {pageRows.map((r) => (
            <tr key={r.id} className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50">
              <td className="px-5 py-3 font-medium text-neutral-900">{r.name}</td>
              <td className="px-5 py-3 text-neutral-600">{r.brandName ?? "—"}</td>
              <td className="px-5 py-3 text-neutral-600">{r.typeName}</td>
              <td className="px-5 py-3 text-neutral-600">{r.rackUnits} RU</td>
              <td className="px-5 py-3 text-right">
                {onEdit && (
                  <button
                    data-testid={`edit-${r.id}`}
                    onClick={() => onEdit(r.id)}
                    className="rounded-lg border border-neutral-200 px-3 py-1 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
                  >
                    Edit
                  </button>
                )}
              </td>
            </tr>
          ))}
          {pageRows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-5 py-14 text-center text-sm text-neutral-400">No results found.</td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-neutral-200 px-5 py-3 text-sm text-neutral-600">
        <div className="flex items-center gap-1">
          <PageBtn label="First page" onClick={() => setPage(1)} disabled={current <= 1}><DoubleChevron dir="left" /></PageBtn>
          <PageBtn label="Previous page" onClick={() => setPage(current - 1)} disabled={current <= 1}><Chevron dir="left" /></PageBtn>
          <PageBtn label="Next page" onClick={() => setPage(current + 1)} disabled={current >= totalPages}><Chevron dir="right" /></PageBtn>
          <PageBtn label="Last page" onClick={() => setPage(totalPages)} disabled={current >= totalPages}><DoubleChevron dir="right" /></PageBtn>
        </div>
        <span className="tabular-nums">Page {totalPages === 0 ? 1 : current} of {totalPages}</span>
        <select
          aria-label="Rows per page"
          value={pageSize}
          onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
          className="h-9 rounded-lg border border-neutral-200 bg-white px-2 text-sm text-neutral-700 focus:border-neutral-400 focus:outline-none"
        >
          {PAGE_SIZES.map((n) => <option key={n} value={n}>Show {n}</option>)}
        </select>
      </div>
    </div>
  );
}

function SortIcon({ dir }: { dir: SortDir | null }) {
  const up = dir === "asc" ? "#404040" : "#d4d4d4";
  const down = dir === "desc" ? "#404040" : "#d4d4d4";
  return (
    <svg width="9" height="13" viewBox="0 0 9 13" aria-hidden>
      <path d="M4.5 0.5 L8 4 H1 Z" fill={up} />
      <path d="M4.5 12.5 L1 9 H8 Z" fill={down} />
    </svg>
  );
}

function PageBtn({ children, label, onClick, disabled }: { children: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 items-center justify-center rounded-lg border border-neutral-200 text-neutral-600 transition-colors hover:bg-neutral-100 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={dir === "right" ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M10 3.5 L5.5 8 L10 12.5" />
    </svg>
  );
}

function DoubleChevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={dir === "right" ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M11 3.5 L6.5 8 L11 12.5 M6.5 3.5 L2 8 L6.5 12.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M7 2 V12 M2 7 H12" />
    </svg>
  );
}
