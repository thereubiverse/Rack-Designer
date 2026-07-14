"use client";

export function LineSettings({
  count, stroke, strokeWidth, opacity, onStroke, onStrokeWidth, onOpacity, onDelete,
}: {
  count: number;
  stroke: string;
  strokeWidth: number;
  opacity?: number;
  onStroke: (v: string) => void;
  onStrokeWidth: (v: number) => void;
  onOpacity: (v: number) => void;
  onDelete: () => void;
}) {
  return (
    <div data-testid="line-settings" className="flex w-full flex-col text-left">
      <div className="mb-2 text-xs font-bold text-neutral-800">{count > 1 ? `${count} lines` : "Line"}</div>
      <label className="flex items-center justify-between text-[11px] font-semibold text-neutral-600">Colour
        <input data-testid="line-color" type="color" value={stroke} onChange={(e) => onStroke(e.target.value)} className="ml-2 h-8 w-10 rounded border border-neutral-200" />
      </label>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Thickness
        <input data-testid="line-width" type="number" min={0.5} max={8} step={0.5} value={strokeWidth} onChange={(e) => onStrokeWidth(Number(e.target.value))} className="ml-2 h-8 w-16 rounded-lg border border-neutral-200 px-2 text-sm font-normal [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
      </label>
      <label className="mt-2 flex flex-col text-[11px] font-semibold text-neutral-600">
        <span className="flex items-center justify-between">Opacity<span className="tabular-nums text-neutral-400">{Math.round((opacity ?? 1) * 100)}%</span></span>
        <input data-testid="line-opacity" type="range" min={0} max={100} value={Math.round((opacity ?? 1) * 100)}
          onChange={(e) => onOpacity(Number(e.target.value) / 100)} className="mt-1 w-full accent-blue-600" />
      </label>
      <button type="button" data-testid="line-delete" onClick={onDelete} className="mt-3 text-left text-xs text-red-600">🗑 Delete</button>
    </div>
  );
}
