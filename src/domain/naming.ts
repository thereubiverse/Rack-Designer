export interface HierarchyCodes {
  site: string;
  floor?: string;
  room?: string;
  rack?: string;
  device?: string;
  port?: number;
}

const LEVEL_ORDER = ["site", "floor", "room", "rack", "device"] as const;

export function buildLabel(codes: HierarchyCodes): string {
  const parts: string[] = [];
  for (const level of LEVEL_ORDER) {
    const value = codes[level];
    if (value === undefined || value === null || value === "") break;
    parts.push(String(value));
  }
  if (codes.device !== undefined && codes.device !== "" && codes.port !== undefined) {
    parts.push(String(codes.port));
  }
  return parts.join("/");
}
