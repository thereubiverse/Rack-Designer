// Device type -> Tabler (iconify) icon, keyed by the type's stable CODE. Covers the standard set;
// any custom or unmapped type falls back to a neutral device glyph. No schema change — the mapping
// lives in code, so pins/menus/lists can all show a type's icon without an `icon` column.

const DEVICE_TYPE_ICON: Record<string, string> = {
  // Floor device types (placed on floor plans)
  CAM: "tabler:camera", // Camera
  AP: "tabler:wifi", // Access Point
  ACP: "tabler:lock", // Access Control Panel
  DP: "tabler:device-desktop", // Desktop
  ISP: "tabler:world", // ISP Uplink
  LP: "tabler:device-laptop", // Laptop
  PH: "tabler:phone", // Phone
  PR: "tabler:printer", // Printer
  "3DP": "tabler:cube", // 3D Printer
  RK: "tabler:server", // Rack
  SCR: "tabler:device-tv", // Screen
  TO: "tabler:plug", // Telecommunications Outlet

  // Rack device types (shown wherever a rack device type is listed)
  SW: "tabler:switch-horizontal", // Switch
  RT: "tabler:router", // Router
  GW: "tabler:router", // Gateway
  FW: "tabler:shield", // Firewall
  SRV: "tabler:server-2", // Server
  PP: "tabler:layout-grid", // Patch Panel
  PDU: "tabler:plug-connected", // PDU
  UPS: "tabler:battery", // UPS
  KVM: "tabler:device-desktop-analytics", // KVM
  CM: "tabler:layout-list", // Cable Manager
  ST: "tabler:layout-board-split", // Shelf/Tray
};

export const DEFAULT_DEVICE_ICON = "tabler:cpu";

/** Icon name for a device type's code (case-insensitive); the default glyph for unmapped codes. */
export function deviceTypeIcon(code: string | null | undefined): string {
  if (!code) return DEFAULT_DEVICE_ICON;
  return DEVICE_TYPE_ICON[code.toUpperCase()] ?? DEFAULT_DEVICE_ICON;
}

// A distinct fill per device type so pins/racks are colour-coded by type at a glance. Chosen at the
// ~600 tailwind level so a white icon and label read clearly on top. Unmapped types get a neutral.
const DEVICE_TYPE_COLOR: Record<string, string> = {
  // Floor device types
  CAM: "#dc2626", // red
  AP: "#2563eb", // blue
  ACP: "#d97706", // amber
  DP: "#475569", // slate
  ISP: "#7c3aed", // violet
  LP: "#0d9488", // teal
  PH: "#0891b2", // cyan
  PR: "#4f46e5", // indigo
  "3DP": "#db2777", // pink
  RK: "#0f172a", // near-black (racks)
  SCR: "#16a34a", // green
  TO: "#ea580c", // orange

  // Rack device types
  SW: "#2563eb",
  RT: "#0891b2",
  GW: "#0891b2",
  FW: "#dc2626",
  SRV: "#475569",
  PP: "#7c3aed",
  PDU: "#ea580c",
  UPS: "#16a34a",
  KVM: "#4f46e5",
  CM: "#64748b",
  ST: "#64748b",
};

export const DEFAULT_DEVICE_COLOR = "#525252";

/** Fill colour for a device type's code (case-insensitive); the default for unmapped codes. */
export function deviceTypeColor(code: string | null | undefined): string {
  if (!code) return DEFAULT_DEVICE_COLOR;
  return DEVICE_TYPE_COLOR[code.toUpperCase()] ?? DEFAULT_DEVICE_COLOR;
}

type TypeAppearance = { code: string; color?: string | null; icon?: string | null };

/** A type's effective icon: its stored override if set, else the built-in default for its code. */
export function resolveTypeIcon(type: TypeAppearance | null | undefined): string {
  return type?.icon ?? deviceTypeIcon(type?.code);
}

/** A type's effective colour: its stored override if set, else the built-in default for its code. */
export function resolveTypeColor(type: TypeAppearance | null | undefined): string {
  return type?.color ?? deviceTypeColor(type?.code);
}
