import { isValidCode } from "@/domain/hierarchy";

export interface CascadeCounts { sites?: number; rooms?: number; racks?: number; devices?: number }

/** Codes are stored one way — uppercase, trimmed — so URL matching can be case-insensitive. */
export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const CODE_LABEL = { client: "Client", site: "Site", floor: "Floor", room: "Room", device: "Device" } as const;

export function validateCode(raw: string, kind: keyof typeof CODE_LABEL): string | null {
  const label = CODE_LABEL[kind];
  const code = normaliseCode(raw);
  if (!code) return `${label} code is required`;
  if (!isValidCode(code)) return `${label} code can only use letters, numbers, - and _`;
  return null;
}

/** "3 sites, 7 racks and 41 devices" — only the parts that are actually non-zero. */
export function describeCascade(counts: CascadeCounts): string {
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, many: string) => {
    if (n && n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(counts.sites, "site", "sites");
  add(counts.rooms, "room", "rooms");
  add(counts.racks, "rack", "racks");
  add(counts.devices, "device", "devices");
  if (parts.length === 0) return "nothing else";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Typing the code to confirm is only worth demanding when a delete actually destroys something. */
export function requiresTypedConfirm(counts: CascadeCounts): boolean {
  return (counts.sites ?? 0) + (counts.rooms ?? 0) + (counts.racks ?? 0) + (counts.devices ?? 0) > 0;
}
