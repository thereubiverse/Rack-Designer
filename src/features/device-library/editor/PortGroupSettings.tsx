"use client";

import { CONNECTORS, type PortGroup, type CountingDirection, type Media } from "@/domain/faceplate";
import { PortGroupLayout } from "./PortGroupLayout";

export interface PortGroupLayoutProps {
  activeRow: number | null;
  labelPos: "top" | "bottom" | null;
  onSelectRow: (row: number) => void;
  onToggleLabel: () => void;
}

const MEDIA_LABELS: Record<Media, string> = {
  copper: "Copper", fiber: "Fiber", sfp: "SFP", usb_a: "USB-A", usb_c: "USB-C",
  hdmi: "HDMI", dp: "DP", vga: "VGA", ps2: "PS/2", audio: "Audio",
};

const DIRECTIONS: { value: CountingDirection; label: string }[] = [
  { value: "ttb", label: "Top-to-bottom" },
  { value: "btt", label: "Bottom-to-top" },
  { value: "ltr", label: "Left-to-right" },
  { value: "rtl", label: "Right-to-left" },
];

export function PortGroupSettings({
  group, onChange, onDelete, embedded, layout,
}: {
  group: PortGroup;
  onChange: (patch: Partial<Pick<PortGroup, "idPrefix" | "countingDirection" | "connectorType">>) => void;
  onDelete: () => void;
  embedded?: boolean;
  layout?: PortGroupLayoutProps;
}) {
  return (
    <div data-testid="pg-settings" className={embedded ? "" : "mt-4 rounded-xl border border-neutral-200 p-4"}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-bold">Port Group Settings — {MEDIA_LABELS[group.media]}</span>
        <button type="button" data-testid="pg-delete" onClick={onDelete} className="text-xs text-red-600">
          🗑 Delete port group
        </button>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col text-xs font-semibold text-neutral-600">
          ID prefix
          <input
            className="mt-1 h-9 w-28 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
            value={group.idPrefix}
            onChange={(e) => onChange({ idPrefix: e.target.value })}
          />
        </label>
        <label className="flex flex-col text-xs font-semibold text-neutral-600">
          Counting Direction
          <select
            className="mt-1 h-9 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
            value={group.countingDirection}
            onChange={(e) => onChange({ countingDirection: e.target.value as CountingDirection })}
          >
            {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs font-semibold text-neutral-600">
          Connector type
          <select
            className="mt-1 h-9 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
            value={group.connectorType}
            onChange={(e) => onChange({ connectorType: e.target.value })}
          >
            {CONNECTORS[group.media].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        {layout && <PortGroupLayout media={group.media} rows={group.rows} {...layout} />}
      </div>
    </div>
  );
}
