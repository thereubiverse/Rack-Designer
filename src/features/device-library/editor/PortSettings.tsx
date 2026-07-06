"use client";

export function PortSettings({
  portLabel, name, flipped, labelPos, onChange, embedded, typeLabel, connectorType, connectorOptions,
}: {
  portLabel: string;
  name: string;
  flipped: boolean;
  labelPos: "top" | "bottom";
  onChange: (patch: { name?: string; flipped?: boolean; labelPos?: "top" | "bottom"; connectorType?: string }) => void;
  embedded?: boolean;
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
  const flipBtn = (
    <button
      type="button"
      data-testid="port-flip"
      aria-pressed={flipped}
      onClick={() => onChange({ flipped: !flipped })}
      className="flex h-9 items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold"
    >
      Flip
      <span className={`inline-block h-4 w-8 rounded-full ${flipped ? "bg-blue-600" : "bg-neutral-300"}`} />
    </button>
  );
  const labelBtn = (
    <button
      type="button"
      data-testid="port-labelpos"
      onClick={() => onChange({ labelPos: labelPos === "top" ? "bottom" : "top" })}
      className="flex h-9 items-center justify-between gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold"
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
