"use client";

export function PortSettings({
  portLabel, name, rotation, labelPos, onChange, embedded, hideLabel, typeLabel, connectorType, connectorOptions,
}: {
  portLabel: string;
  name: string;
  rotation: number;
  labelPos: "top" | "bottom";
  onChange: (patch: { name?: string; rotation?: number; labelPos?: "top" | "bottom"; connectorType?: string }) => void;
  embedded?: boolean;
  /** Hide the label-side toggle — used for single-row groups, whose label is owned by the
   *  vertical snap so it can never sit out of bounds. */
  hideLabel?: boolean;
  /** Set when this port's type differs from its group — shows the type + a connector picker. */
  typeLabel?: string;
  connectorType?: string;
  connectorOptions?: string[];
}) {
  const connectorControl = typeLabel && connectorOptions && connectorOptions.length > 0 ? (
    <label className="flex flex-col text-[11px] font-semibold text-neutral-600">
      Connector ({typeLabel})
      <select data-testid="port-connector"
        className="mt-1 h-9 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
        value={connectorType ?? connectorOptions[0]}
        onChange={(e) => onChange({ connectorType: e.target.value })}>
        {connectorOptions.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    </label>
  ) : null;
  const nameInput = (
    <input
      className={`mt-1 h-9 rounded-lg border border-neutral-200 px-2 text-sm font-normal ${embedded ? "w-full" : "w-40"}`}
      value={name}
      onChange={(e) => onChange({ name: e.target.value || undefined })}
    />
  );
  // "Flip" rotates the glyph 180° (same behavior as the top Rotate button); ports only
  // ever sit at 0° or 180°, so this reads as a toggle.
  const rotated = rotation % 360 !== 0;
  const flipBtn = (
    <button
      type="button"
      data-testid="port-flip"
      aria-pressed={rotated}
      onClick={() => onChange({ rotation: (rotation + 180) % 360 })}
      className="flex h-9 items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold transition-colors hover:bg-neutral-100"
    >
      Flip
      <span className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${rotated ? "bg-blue-600" : "bg-neutral-300"}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all ${rotated ? "left-3.5" : "left-0.5"}`} />
      </span>
    </button>
  );
  const labelBtn = hideLabel ? null : (
    <button
      type="button"
      data-testid="port-labelpos"
      onClick={() => onChange({ labelPos: labelPos === "top" ? "bottom" : "top" })}
      className="flex h-9 items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold transition-colors hover:bg-neutral-100"
    >
      Label: {labelPos === "top" ? "Top" : "Bottom"}
    </button>
  );

  if (embedded) {
    return (
      <div data-testid="port-settings" className="flex w-full flex-col text-left">
        <div className="mb-2 text-xs font-bold text-neutral-800">Port {portLabel}</div>
        <label className="flex flex-col text-[11px] font-semibold text-neutral-600">Port name{nameInput}</label>
        {connectorControl && <div className="mt-2">{connectorControl}</div>}
        <div className="mt-3 flex flex-col gap-2">{flipBtn}{labelBtn}</div>
      </div>
    );
  }

  return (
    <div data-testid="port-settings" className="mt-4 rounded-xl border border-neutral-200 p-4">
      <div className="mb-3 text-sm font-bold">Port {portLabel}</div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col text-xs font-semibold text-neutral-600">Port name{nameInput}</label>
        {connectorControl}
        {flipBtn}
        {labelBtn}
      </div>
    </div>
  );
}

/** Batch panel for a multi-selection (several ports, or several whole groups). Only the
 *  controls that make sense to apply uniformly: Flip (180° rotation) and Label position.
 *  A "mixed" summary means the targets currently disagree; clicking converges them. */
export function BatchSettings({
  title, rotated, labelPos, onFlip, onLabel, onDelete, deleteLabel, hideLabel,
}: {
  title: string;
  rotated: "on" | "off" | "mixed";
  labelPos: "top" | "bottom" | "mixed";
  onFlip: () => void;
  onLabel: () => void;
  onDelete?: () => void;
  deleteLabel?: string;
  /** Hide the label-side toggle when the selection includes a single-row group (label owned by
   *  the vertical snap). */
  hideLabel?: boolean;
}) {
  const knobOn = rotated === "on";
  const labelText = labelPos === "mixed" ? "Mixed" : labelPos === "top" ? "Top" : "Bottom";
  return (
    <div data-testid="batch-settings" className="flex w-full flex-col text-left">
      <div className="mb-2 text-xs font-bold text-neutral-800">{title}</div>
      <div className="flex flex-col gap-2">
        <button
          type="button"
          data-testid="batch-flip"
          aria-pressed={knobOn}
          onClick={onFlip}
          className="flex h-9 items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold transition-colors hover:bg-neutral-100"
        >
          Flip{rotated === "mixed" ? " (mixed)" : ""}
          <span className={`relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors ${knobOn ? "bg-blue-600" : "bg-neutral-300"}`}>
            <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all ${knobOn ? "left-3.5" : "left-0.5"}`} />
          </span>
        </button>
        {!hideLabel && (
          <button
            type="button"
            data-testid="batch-labelpos"
            onClick={onLabel}
            className="flex h-9 items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold transition-colors hover:bg-neutral-100"
          >
            Label: {labelText}
          </button>
        )}
        {onDelete && (
          <button type="button" data-testid="batch-delete" onClick={onDelete} className="mt-1 text-left text-xs text-red-600">
            🗑 {deleteLabel ?? "Delete groups"}
          </button>
        )}
      </div>
    </div>
  );
}
