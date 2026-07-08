"use client";

export interface PlacementDraft {
  id: string; deviceTemplateId: string; code: string; name: string | null;
  startU: number; side: "front"; status: "planned" | "installed" | "verified";
  manufacturer: string | null; modelName: string | null; serialNumber: string | null;
  purchaseDate: string | null; operationStart: string | null;
}

const input = "mt-1 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm font-normal focus:border-neutral-400 focus:outline-none";
const label = "block text-[11px] font-semibold text-neutral-600";

/** Selected-device settings: ID (auto SW01, editable), status, inventory. Emits partial patches. */
export function RackDeviceSettings({ device, templateName, codeError, onChange, onDelete }: {
  device: PlacementDraft;
  templateName: string;
  codeError: string | null;
  onChange: (patch: Partial<PlacementDraft>) => void;
  onDelete: () => void;
}) {
  const text = (key: keyof PlacementDraft, lbl: string, type = "text") => (
    <label className={label}>{lbl}
      <input type={type} value={(device[key] as string | null) ?? ""} className={input}
        onChange={(e) => onChange({ [key]: e.target.value === "" ? null : e.target.value } as Partial<PlacementDraft>)} />
    </label>
  );
  return (
    <div className="space-y-3" data-testid="rack-device-settings">
      <div className="text-xs font-bold text-neutral-800">{templateName}</div>
      <label className={label}>ID *
        <input value={device.code} className={input}
          onChange={(e) => onChange({ code: e.target.value.toUpperCase() })} />
      </label>
      {codeError && <p className="text-sm text-red-600">{codeError}</p>}
      {text("name", "Name")}
      <label className={label}>Status
        <select aria-label="Status" value={device.status} className={input}
          onChange={(e) => onChange({ status: e.target.value as PlacementDraft["status"] })}>
          <option value="planned">planned</option>
          <option value="installed">installed</option>
          <option value="verified">verified</option>
        </select>
      </label>
      {text("manufacturer", "Manufacturer")}
      {text("modelName", "Model name")}
      {text("serialNumber", "Serial number")}
      {text("purchaseDate", "Purchase date", "date")}
      {text("operationStart", "Operation start", "date")}
      <button type="button" data-testid="device-delete" onClick={onDelete}
        className="text-left text-xs font-semibold text-red-600 hover:text-red-700">🗑 Remove from rack</button>
    </div>
  );
}
