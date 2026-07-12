"use client";

export function LineSettings({
  count, stroke, strokeWidth, onStroke, onStrokeWidth, onDelete,
}: {
  count: number;
  stroke: string;
  strokeWidth: number;
  onStroke: (v: string) => void;
  onStrokeWidth: (v: number) => void;
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
      <button type="button" data-testid="line-delete" onClick={onDelete} className="mt-3 text-left text-xs text-red-600">🗑 Delete</button>
    </div>
  );
}
