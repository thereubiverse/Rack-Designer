"use client";

import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";

const COLLECTION_URL = "https://api.iconify.design/collection?prefix=tabler";
const searchUrl = (q: string) => `https://api.iconify.design/search?query=${encodeURIComponent(q)}&limit=120`;
const DEFAULT_LIMIT = 150;

/** Modal icon picker over all of Iconify. Empty query browses the Tabler set (matches the app's
 *  line-icon style); typing searches every set (debounced). Picking returns a "prefix:name" id. */
export function IconPicker({ onPick, onClose }: { onPick: (iconName: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [icons, setIcons] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const q = query.trim();
    const t = setTimeout(() => {
      fetch(q ? searchUrl(q) : COLLECTION_URL)
        .then((r) => r.json())
        .then((data) => {
          if (!alive) return;
          let names: string[];
          if (q) {
            names = (data.icons as string[]) ?? [];
          } else {
            const flat = [
              ...((data.uncategorized as string[]) ?? []),
              ...(Object.values(data.categories ?? {}).flat() as string[]),
            ];
            names = flat.slice(0, DEFAULT_LIMIT).map((n) => `tabler:${n}`);
          }
          setIcons(names);
          setLoading(false);
        })
        .catch(() => { if (alive) { setIcons([]); setLoading(false); } });
    }, q ? 250 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  return (
    <div
      data-testid="icon-picker"
      className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-[6vh]"
      onClick={onClose}
    >
      <div className="w-full max-w-[560px] rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-neutral-900">Select Icon</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100"
          >✕</button>
        </div>
        <label className="relative mb-3 flex items-center">
          <svg className="pointer-events-none absolute left-3 h-4 w-4 text-neutral-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3 -4.3" /></svg>
          <input
            data-testid="icon-search"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search icons…"
            className="h-11 w-full rounded-xl border border-neutral-200 bg-neutral-50 pl-9 pr-3 text-sm outline-none focus:border-neutral-300 focus:bg-white"
          />
        </label>
        <div className="mb-2 text-xs text-neutral-400">{loading ? "Loading…" : `${icons.length} icons`}</div>
        <div className="grid max-h-[52vh] grid-cols-8 gap-2 overflow-y-auto">
          {icons.map((name) => (
            <button
              key={name}
              type="button"
              data-testid="icon-cell"
              title={name}
              onClick={() => onPick(name)}
              className="flex aspect-square items-center justify-center rounded-lg border border-neutral-100 text-neutral-800 transition-colors hover:bg-neutral-100"
            >
              <Icon icon={name} width={22} height={22} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
