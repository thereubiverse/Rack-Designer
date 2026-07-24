"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import type { DeviceTypeRow } from "./repository";
import { createDeviceTypeAction, saveDeviceTypesAction, deleteDeviceTypeAction } from "./typeActions";
import type { DeviceTypeChange } from "./typeActions";
import { normalizeCode, validateCode, validateTypeName, CODE_HELP } from "./deviceTypeRules";
import { deviceTypeColor, deviceTypeIcon, DEFAULT_DEVICE_COLOR, DEFAULT_DEVICE_ICON } from "./deviceTypeIcons";
import { IconPicker } from "./editor/IconPicker";

type Category = "floor" | "rack";

export function DeviceTypesManager({ floor, rack }: { floor: DeviceTypeRow[]; rack: DeviceTypeRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <DeviceTypeColumn title="Floor Device Types" category="floor" types={floor} />
      <DeviceTypeColumn title="Rack Device Types" category="rack" types={rack} />
    </div>
  );
}

function DeviceTypeColumn({ title, category, types }: { title: string; category: Category; types: DeviceTypeRow[] }) {
  const router = useRouter();
  const standard = types.filter((t) => t.is_standard);
  const customs = types.filter((t) => !t.is_standard);

  // Draft edits keyed by row id; absent key = unchanged. Codes are normalized as typed.
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [colors, setColors] = useState<Record<string, string>>({});
  const [icons, setIcons] = useState<Record<string, string>>({});
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Effective values shown in the row: draft override -> stored override -> built-in default.
  const effColor = (t: DeviceTypeRow) => colors[t.id] ?? t.color ?? deviceTypeColor(t.code);
  const effIcon = (t: DeviceTypeRow) => icons[t.id] ?? t.icon ?? deviceTypeIcon(t.code);

  const changes: DeviceTypeChange[] = types
    .map((t) => {
      const code = codes[t.id] !== undefined && codes[t.id] !== t.code ? codes[t.id] : undefined;
      const name = names[t.id] !== undefined && names[t.id] !== t.name ? names[t.id] : undefined;
      const color = colors[t.id] !== undefined && colors[t.id] !== t.color ? colors[t.id] : undefined;
      const icon = icons[t.id] !== undefined && icons[t.id] !== t.icon ? icons[t.id] : undefined;
      return {
        id: t.id,
        ...(name !== undefined ? { name } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(color !== undefined ? { color } : {}),
        ...(icon !== undefined ? { icon } : {}),
      };
    })
    .filter((c) => "name" in c || "code" in c || "color" in c || "icon" in c);
  const dirty = changes.length > 0;

  async function save() {
    setSaving(true); setError(null);
    const res = await saveDeviceTypesAction(changes);
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Save failed"); return; }
    setCodes({}); setNames({}); setColors({}); setIcons({});
    router.refresh();
  }

  async function remove(id: string) {
    setError(null);
    const res = await deleteDeviceTypeAction(id);
    if (!res.ok) { setError(res.error ?? "Delete failed"); return; }
    router.refresh();
  }

  const appearance = (t: DeviceTypeRow) => (
    <Appearance
      id={t.id}
      color={effColor(t)}
      icon={effIcon(t)}
      onColor={(hex) => setColors((c) => ({ ...c, [t.id]: hex }))}
      onOpenPicker={() => setPickerFor(t.id)}
    />
  );

  return (
    <section className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-5">
      <h2 className="text-xl font-bold text-neutral-900">{title}</h2>

      {/* Standard */}
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm font-semibold text-neutral-700">
          Standard Device Types
        </div>
        <div className="space-y-2 p-4">
          {standard.map((t) => (
            <div key={t.id} className="flex items-center gap-3">
              {appearance(t)}
              <span className="flex-1 text-sm font-semibold text-neutral-800">{t.name}</span>
              <input
                value={codes[t.id] ?? t.code}
                onChange={(e) => setCodes((c) => ({ ...c, [t.id]: normalizeCode(e.target.value) }))}
                className="h-9 w-20 rounded-lg border border-neutral-200 px-2 text-sm text-neutral-600 focus:border-neutral-400 focus:outline-none"
              />
            </div>
          ))}
          <button
            type="button"
            data-testid={`save-${category}`}
            disabled={!dirty || saving}
            onClick={save}
            className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9] disabled:opacity-40 disabled:hover:bg-blue-600"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {/* Custom */}
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-4 py-2.5">
          <span className="text-sm font-semibold text-neutral-700">Custom Device Types</span>
          <button
            type="button"
            data-testid={`add-type-${category}`}
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 2v10M2 7h10" /></svg>
            Add
          </button>
        </div>
        <div className="p-4">
          {customs.length === 0 ? (
            <p className="py-6 text-center text-sm text-neutral-400">Click &quot;Add&quot; to create your first custom device type.</p>
          ) : (
            <div className="space-y-2">
              {customs.map((t) => (
                <div key={t.id} className="flex items-center gap-2">
                  {appearance(t)}
                  <input
                    value={names[t.id] ?? t.name}
                    onChange={(e) => setNames((n) => ({ ...n, [t.id]: e.target.value }))}
                    className="h-9 flex-1 rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
                  />
                  <input
                    value={codes[t.id] ?? t.code}
                    onChange={(e) => setCodes((c) => ({ ...c, [t.id]: normalizeCode(e.target.value) }))}
                    className="h-9 w-24 rounded-lg border border-neutral-200 px-2 text-sm text-neutral-600 focus:border-neutral-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="Delete type"
                    data-testid={`delete-type-${t.id}`}
                    onClick={() => remove(t.id)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {pickerFor && (
        <IconPicker
          onPick={(name) => { setIcons((i) => ({ ...i, [pickerFor]: name })); setPickerFor(null); }}
          onClose={() => setPickerFor(null)}
        />
      )}

      {modalOpen && (
        <CreateTypeModal
          category={category}
          onClose={() => setModalOpen(false)}
          onCreated={() => { setModalOpen(false); router.refresh(); }}
        />
      )}
    </section>
  );
}

/** Per-type appearance: icon button (opens the icon picker), a colour swatch (native `<input
 *  type="color">` — the OS colour wheel with RGB/hex fields), and a hex text field. The icon shows
 *  in the type's colour so the pairing is obvious. */
function Appearance({
  id,
  color,
  icon,
  onColor,
  onOpenPicker,
}: {
  id: string;
  color: string;
  icon: string;
  onColor: (hex: string) => void;
  onOpenPicker: () => void;
}) {
  const validHex = /^#[0-9a-fA-F]{6}$/.test(color);
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        data-testid={`type-icon-${id}`}
        onClick={onOpenPicker}
        title="Change icon"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 transition-colors hover:bg-neutral-100"
        style={{ color }}
      >
        <Icon icon={icon} width={18} height={18} />
      </button>
      <label className="relative h-9 w-9 shrink-0 cursor-pointer" title="Change colour (wheel + RGB/hex)">
        <span className="block h-full w-full rounded-lg border border-neutral-200" style={{ background: validHex ? color : "#ffffff" }} />
        <input
          type="color"
          data-testid={`type-color-${id}`}
          value={validHex ? color : "#000000"}
          onChange={(e) => onColor(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </label>
    </div>
  );
}

function CreateTypeModal({ category, onClose, onCreated }: {
  category: Category; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [color, setColor] = useState(DEFAULT_DEVICE_COLOR);
  const [icon, setIcon] = useState(DEFAULT_DEVICE_ICON);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = category === "floor" ? "Floor" : "Rack";

  async function create() {
    const err = validateTypeName(name) ?? validateCode(code);
    if (err) { setError(err); return; }
    setBusy(true); setError(null);
    const res = await createDeviceTypeAction({ name: name.trim(), code, category, color, icon });
    setBusy(false);
    if (!res.ok) { setError(res.error ?? "Create failed"); return; }
    onCreated();
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label={`Create ${label} Device Type`}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
        <h3 className="text-base font-bold">Create {label} Device Type</h3>
        <p className="mt-1 text-sm text-neutral-500">Create a custom device type with its own colour and icon.</p>
        <label className="mt-4 block text-[11px] font-semibold text-neutral-600">
          Name *
          <input
            data-testid="new-type-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm font-normal focus:border-neutral-400 focus:outline-none"
          />
        </label>
        <label className="mt-3 block text-[11px] font-semibold text-neutral-600">
          ID prefix *
          <input
            data-testid="new-type-code"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            className="mt-1 h-9 w-24 rounded-lg border border-neutral-200 px-2 text-sm font-normal focus:border-neutral-400 focus:outline-none"
          />
        </label>
        <p className="mt-1 text-xs text-neutral-500">{CODE_HELP}</p>
        <div className="mt-3 text-[11px] font-semibold text-neutral-600">
          Appearance
          <div className="mt-1 flex items-center gap-1.5">
            <button
              type="button"
              data-testid="new-type-icon"
              onClick={() => setPickerOpen(true)}
              title="Choose icon"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 transition-colors hover:bg-neutral-100"
              style={{ color }}
            >
              <Icon icon={icon} width={18} height={18} />
            </button>
            <label className="relative h-9 w-9 shrink-0 cursor-pointer" title="Choose colour (wheel + RGB/hex)">
              <span className="block h-full w-full rounded-lg border border-neutral-200" style={{ background: color }} />
              <input
                type="color"
                data-testid="new-type-color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              />
            </label>
            <span className="font-mono text-sm font-normal text-neutral-500">{color}</span>
          </div>
        </div>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold transition-colors hover:bg-neutral-100">Cancel</button>
          <button type="button" data-testid="new-type-create" disabled={busy} onClick={create}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9] disabled:opacity-40">
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
      {pickerOpen && (
        <IconPicker
          onPick={(n) => { setIcon(n); setPickerOpen(false); }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
