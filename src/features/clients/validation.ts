import { isValidCode } from "@/domain/hierarchy";

export interface CascadeCounts { sites?: number; racks?: number; devices?: number }

/** Codes are stored one way — uppercase, trimmed — so URL matching can be case-insensitive. */
export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function validateCode(raw: string, kind: "client" | "site"): string | null {
  const label = kind === "client" ? "Client" : "Site";
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
  add(counts.racks, "rack", "racks");
  add(counts.devices, "device", "devices");
  if (parts.length === 0) return "nothing else";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Typing the code to confirm is only worth demanding when a delete actually destroys something. */
export function requiresTypedConfirm(counts: CascadeCounts): boolean {
  return (counts.sites ?? 0) + (counts.racks ?? 0) + (counts.devices ?? 0) > 0;
}
