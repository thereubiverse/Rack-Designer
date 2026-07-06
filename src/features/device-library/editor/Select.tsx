"use client";

import { useState, useRef, useEffect } from "react";

export interface SelectOption { value: string; label: string }

/**
 * Custom single-select dropdown matching the BrandPicker styling — replaces native
 * <select> so the whole app's dropdowns look consistent (no system-styled menus).
 */
export function Select({
  options, value, onChange, placeholder = "—", testId, ariaLabel,
}: {
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const selected = options.find((o) => o.value === value) ?? null;

  return (
    <div ref={rootRef} className="relative mt-1">
      <button
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 text-sm font-normal text-neutral-800"
      >
        <span className={`truncate ${selected ? "" : "text-neutral-400"}`}>{selected ? selected.label : placeholder}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-neutral-400"><path d="M6 9l6 6l6 -6" /></svg>
      </button>

      {open && (
        <div role="listbox" className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-neutral-50 ${o.value === value ? "font-semibold text-blue-600" : "text-neutral-800"}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
