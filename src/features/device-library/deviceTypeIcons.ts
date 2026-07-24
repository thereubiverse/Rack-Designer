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
