"use client";

export function ShapeSettings({
  count, shape, fill, stroke, strokeWidth, opacity,
  onShape, onFill, onStroke, onStrokeWidth, onOpacity, onDelete,
}: {
  count: number;
  shape: "rect" | "ellipse";
  fill?: string;
  stroke?: string;
  strokeWidth: number;
  opacity?: number;
  onShape: (s: "rect" | "ellipse") => void;
  onFill: (v: string | undefined) => void;
  onStroke: (v: string) => void;
  onStrokeWidth: (v: number) => void;
  onOpacity: (v: number) => void;
  onDelete: () => void;
}) {
  return (
    <div data-testid="shape-settings" className="flex w-full flex-col text-left">
      <div className="mb-2 text-xs font-bold text-neutral-800">{count > 1 ? `${count} shapes` : "Shape"}</div>
      <div className="flex rounded-lg border border-neutral-200 p-0.5">
        {(["rect", "ellipse"] as const).map((s) => (
          <button key={s} type="button" data-testid={`shape-${s}`} onClick={() => onShape(s)}
            className={`flex-1 rounded-md py-1 text-xs font-semibold capitalize ${shape === s ? "bg-neutral-900 text-white" : "text-neutral-500"}`}>{s}</button>
        ))}
      </div>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">
        <span className="flex items-center gap-2"><input data-testid="shape-fill-on" type="checkbox" checked={fill != null && fill !== "none"} onChange={(e) => onFill(e.target.checked ? "#e5e7eb" : undefined)} />Fill</span>
        <input data-testid="shape-fill" type="color" value={fill && fill !== "none" ? fill : "#e5e7eb"} onChange={(e) => onFill(e.target.value)} className="ml-2 h-8 w-10 rounded border border-neutral-200" />
      </label>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Stroke
        <input data-testid="shape-stroke" type="color" value={stroke ?? "#111418"} onChange={(e) => onStroke(e.target.value)} className="ml-2 h-8 w-10 rounded border border-neutral-200" />
      </label>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Width
        <input data-testid="shape-width" type="number" min={0.5} max={8} step={0.5} value={strokeWidth} onChange={(e) => onStrokeWidth(Number(e.target.value))} className="ml-2 h-8 w-16 rounded-lg border border-neutral-200 px-2 text-sm font-normal [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
      </label>
      <label className="mt-2 flex flex-col text-[11px] font-semibold text-neutral-600">
        <span className="flex items-center justify-between">Opacity<span className="tabular-nums text-neutral-400">{Math.round((opacity ?? 1) * 100)}%</span></span>
        <input data-testid="shape-opacity" type="range" min={0} max={100} value={Math.round((opacity ?? 1) * 100)}
          onChange={(e) => onOpacity(Number(e.target.value) / 100)} className="mt-1 w-full accent-blue-600" />
      </label>
      <button type="button" data-testid="shape-delete" onClick={onDelete} className="mt-3 text-left text-xs text-red-600">🗑 Delete</button>
    </div>
  );
}
