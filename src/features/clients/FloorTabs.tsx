"use client";

import type { FloorRow } from "@/lib/supabase/types";

/** Tab bar over a site's floors. Purely presentational — the repository already sorts floors by
 *  `sort_order`, so this renders them in exactly the order given and never re-sorts by code (a
 *  floor named "1F" can legitimately sit above "GF"). Selecting a floor and adding one are both
 *  left to the caller via callbacks. */
export function FloorTabs({
  floors,
  activeCode,
  onSelect,
  onAdd,
}: {
  floors: FloorRow[];
  activeCode: string;
  onSelect: (code: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-neutral-200">
      {floors.map((floor) => {
        const isActive = floor.code === activeCode;
        return (
          <button
            key={floor.id}
            type="button"
            data-testid={`floor-tab-${floor.code}`}
            aria-current={isActive ? "page" : undefined}
            onClick={() => {
              if (!isActive) onSelect(floor.code);
            }}
            className={
              isActive
                ? "border-b-2 border-blue-600 px-3 py-2 text-sm font-semibold text-blue-700"
                : "border-b-2 border-transparent px-3 py-2 text-sm text-neutral-500 hover:text-neutral-900"
            }
          >
            {floor.name ? `${floor.code} — ${floor.name}` : floor.code}
          </button>
        );
      })}
      <button
        type="button"
        data-testid="add-floor"
        onClick={onAdd}
        className="ml-2 px-3 py-2 text-sm font-semibold text-blue-700 hover:text-blue-800"
      >
        + Add floor
      </button>
    </div>
  );
}
