"use client";

export function PortSettings({
  portLabel, name, flipped, onChange,
}: {
  portLabel: string;
  name: string;
  flipped: boolean;
  onChange: (patch: { name?: string; flipped?: boolean }) => void;
}) {
  return (
    <div data-testid="port-settings" className="mt-4 rounded-xl border border-neutral-200 p-4">
      <div className="mb-3 text-sm font-bold">Port {portLabel}</div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col text-xs font-semibold text-neutral-600">
          Port name
          <input
            className="mt-1 h-9 w-40 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
            value={name}
            onChange={(e) => onChange({ name: e.target.value || undefined })}
          />
        </label>
        <button
          type="button"
          data-testid="port-flip"
          aria-pressed={flipped}
          onClick={() => onChange({ flipped: !flipped })}
          className="flex h-9 items-center gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold"
        >
          Flip
          <span className={`inline-block h-4 w-8 rounded-full ${flipped ? "bg-blue-600" : "bg-neutral-300"}`} />
        </button>
      </div>
    </div>
  );
}
