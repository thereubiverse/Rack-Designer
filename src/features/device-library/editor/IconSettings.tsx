"use client";

const DEFAULT_COLOR = "#111418"; // matches FaceIcon's default ink colour

/** Settings panel shown when one or more icon elements are selected. Repurposes the group-settings
 *  slot: colour, opacity, a button to swap the icon, and delete — each applied to the whole
 *  selection. `color`/`opacity` are the selection's common value, or null when the selection
 *  disagrees (rendered as the default so the control still reads sensibly). */
export function IconSettings({
  count, color, opacity, onColor, onOpacity, onSelectIcon, onDelete,
}: {
  count: number;
  color: string | null;
  opacity: number | null;
  onColor: (color: string) => void;
  onOpacity: (opacity: number) => void;
  onSelectIcon: () => void;
  onDelete: () => void;
}) {
  const pct = Math.round((opacity ?? 1) * 100);
  return (
    <div data-testid="icon-settings" className="flex w-full flex-col text-left">
      <div className="mb-3 text-xs font-bold text-neutral-800">
        {count > 1 ? `${count} icons selected` : "Icon"}
      </div>
      <div className="flex flex-col gap-3">
        <label className="flex items-center justify-between text-[11px] font-semibold text-neutral-600">
          Color
          <input
            data-testid="icon-color"
            type="color"
            value={color ?? DEFAULT_COLOR}
            onChange={(e) => onColor(e.target.value)}
            className="h-8 w-12 cursor-pointer rounded border border-neutral-200 bg-white p-0.5"
          />
        </label>
        <label className="flex flex-col text-[11px] font-semibold text-neutral-600">
          <span className="flex items-center justify-between">Opacity<span className="tabular-nums text-neutral-400">{pct}%</span></span>
          <input
            data-testid="icon-opacity"
            type="range"
            min={0}
            max={100}
            value={pct}
            onChange={(e) => onOpacity(Number(e.target.value) / 100)}
            className="mt-1 w-full accent-blue-600"
          />
        </label>
        <button
          type="button"
          data-testid="icon-select"
          onClick={onSelectIcon}
          className="flex h-9 items-center justify-center gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold transition-colors hover:bg-neutral-100"
        >
          Select Icon
        </button>
        <button type="button" data-testid="icon-delete" onClick={onDelete} className="mt-1 text-left text-xs text-red-600">
          🗑 {count > 1 ? "Delete icons" : "Delete icon"}
        </button>
      </div>
    </div>
  );
}
