"use client";

export function TextSettings({
  count, content, alignment, fontSize, color,
  onContent, onAlignment, onFontSize, onColor, onDelete,
}: {
  count: number;
  content: string;
  alignment: "left" | "center" | "right";
  fontSize: number;
  color?: string;
  onContent: (v: string) => void;
  onAlignment: (v: "left" | "center" | "right") => void;
  onFontSize: (v: number) => void;
  onColor: (v: string) => void;
  onDelete: () => void;
}) {
  const aligns: ("left" | "center" | "right")[] = ["left", "center", "right"];
  return (
    <div data-testid="text-settings" className="flex w-full flex-col text-left">
      <div className="mb-2 text-xs font-bold text-neutral-800">{count > 1 ? `${count} text elements` : "Text"}</div>
      {count === 1 && (
        <label className="flex flex-col text-[11px] font-semibold text-neutral-600">Content
          <input data-testid="text-content" value={content} onChange={(e) => onContent(e.target.value)}
            className="mt-1 h-9 rounded-lg border border-neutral-200 px-2 text-sm font-normal" />
        </label>
      )}
      <div className="mt-2 flex gap-2">
        <div className="flex flex-1 rounded-lg border border-neutral-200 p-0.5">
          {aligns.map((a) => (
            <button key={a} type="button" data-testid={`text-align-${a}`} onClick={() => onAlignment(a)}
              className={`flex-1 rounded-md py-1 text-xs font-semibold capitalize ${alignment === a ? "bg-neutral-900 text-white" : "text-neutral-500"}`}>{a}</button>
          ))}
        </div>
      </div>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Size
        <input data-testid="text-size" type="number" min={6} max={48} value={fontSize}
          onChange={(e) => onFontSize(Number(e.target.value))}
          className="ml-2 h-8 w-16 rounded-lg border border-neutral-200 px-2 text-sm font-normal [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
      </label>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Colour
        <input data-testid="text-color" type="color" value={color ?? "#4b5563"} onChange={(e) => onColor(e.target.value)}
          className="ml-2 h-8 w-10 rounded border border-neutral-200" />
      </label>
      <button type="button" data-testid="text-delete" onClick={onDelete} className="mt-3 text-left text-xs text-red-600">🗑 Delete</button>
    </div>
  );
}
