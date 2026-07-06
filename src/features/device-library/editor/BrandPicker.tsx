"use client";

import { useState, useRef, useEffect } from "react";
import type { BrandRow } from "../repository";

/**
 * Custom brand dropdown — replaces the native <select> so the list rows can carry
 * per-brand delete (✕) and an inline "Add brand" affordance inside the menu itself.
 */
export function BrandPicker({
  brands, value, onChange, onCreate, onDelete, canDelete,
}: {
  brands: BrandRow[];
  value: string | null;
  onChange: (id: string | null) => void;
  onCreate?: (name: string) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
  /** When provided, a brand only shows a delete ✕ if this returns true. */
  canDelete?: (brand: BrandRow) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = brands.find((b) => b.id === value) ?? null;

  async function confirmAdd() {
    const trimmed = name.trim();
    if (!trimmed || !onCreate) return;
    await onCreate(trimmed);
    setName("");
    setAdding(false);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative mt-1">
      <button
        type="button"
        data-testid="brand-trigger"
        aria-label="Brand"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 text-sm font-normal text-neutral-800"
      >
        <span className={`truncate ${selected ? "" : "text-neutral-400"}`}>{selected ? selected.name : "—"}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-neutral-400"><path d="M6 9l6 6l6 -6" /></svg>
      </button>

      {open && (
        <div data-testid="brand-menu" role="listbox" className="absolute z-30 mt-1 w-full overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg">
          <ul className="max-h-48 overflow-auto py-1">
            <li>
              <button type="button"
                className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-50"
                onClick={() => { onChange(null); setOpen(false); }}>—</button>
            </li>
            {brands.map((b) => (
              <li key={b.id} className="flex items-center">
                <button type="button" role="option" aria-selected={b.id === value}
                  className={`min-w-0 flex-1 truncate px-3 py-1.5 text-left text-sm hover:bg-neutral-50 ${b.id === value ? "font-semibold text-blue-600" : "text-neutral-800"}`}
                  onClick={() => { onChange(b.id); setOpen(false); }}>{b.name}</button>
                {onDelete && (canDelete ? canDelete(b) : true) && (
                  <button type="button" aria-label={`Delete ${b.name}`} title="Delete brand"
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-600"
                    onClick={(e) => { e.stopPropagation(); onDelete(b.id); }}>✕</button>
                )}
              </li>
            ))}
          </ul>

          {onCreate && (
            <div className="border-t border-neutral-100 p-1">
              {adding ? (
                <div className="flex gap-1 p-1">
                  <input autoFocus data-testid="brand-add-input" value={name} placeholder="New brand"
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirmAdd(); } if (e.key === "Escape") setAdding(false); }}
                    className="h-8 min-w-0 flex-1 rounded border border-neutral-200 px-2 text-sm font-normal" />
                  <button type="button" data-testid="brand-add-confirm" onClick={confirmAdd}
                    className="h-8 shrink-0 rounded bg-blue-600 px-2 text-sm font-medium text-white">Add</button>
                </div>
              ) : (
                <button type="button" data-testid="brand-add"
                  onClick={() => setAdding(true)}
                  className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm font-medium text-blue-600 hover:bg-neutral-50">
                  <span className="text-base leading-none">＋</span> Add brand
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
