// Pure placement math for the rack builder. Mirrors portGroupOps' style: no React, no I/O.
// RUs are numbered bottom-up (U1 at the bottom); a placement occupies startU .. startU+ru-1.

export interface PlacementLike { id: string; deviceTemplateId: string; code: string; startU: number; }
export type RuByTemplate = Record<string, number>;

export const DEVICE_CODE_RULE = /^[A-Z0-9_-]{1,10}$/;

export function spanOf(p: PlacementLike, ru: RuByTemplate): { bottom: number; top: number } {
  const h = ru[p.deviceTemplateId] ?? 1;
  return { bottom: p.startU, top: p.startU + h - 1 };
}

export function canPlace(
  placements: PlacementLike[], ru: RuByTemplate,
  startU: number, heightU: number, rackHeight: number, ignoreId?: string,
): boolean {
  const top = startU + heightU - 1;
  if (startU < 1 || top > rackHeight) return false;
  return placements.every((p) => {
    if (p.id === ignoreId) return true;
    const s = spanOf(p, ru);
    return top < s.bottom || startU > s.top;
  });
}

/** The preferred U if legal, else the nearest legal startU, else null (rack full for this height). */
export function findFreeSlot(
  placements: PlacementLike[], ru: RuByTemplate,
  heightU: number, rackHeight: number, preferredU = 1,
): number | null {
  const candidates = Array.from({ length: rackHeight }, (_, i) => i + 1)
    .filter((u) => canPlace(placements, ru, u, heightU, rackHeight))
    .sort((a, b) => Math.abs(a - preferredU) - Math.abs(b - preferredU) || a - b);
  return candidates[0] ?? null;
}

/** First free `typeCode + NN` (2 digits, reusing gaps; grows naturally past 99). */
export function nextCode(placements: PlacementLike[], typeCode: string): string {
  const used = new Set(placements.map((p) => p.code));
  for (let n = 1; ; n++) {
    const code = `${typeCode}${String(n).padStart(2, "0")}`;
    if (!used.has(code)) return code;
  }
}

/** Nearest legal startU to the drag target; falls back to the device's current position. */
export function resolveMove(
  placements: PlacementLike[], ru: RuByTemplate,
  id: string, targetU: number, rackHeight: number,
): number {
  const self = placements.find((p) => p.id === id);
  if (!self) return targetU;
  const h = ru[self.deviceTemplateId] ?? 1;
  const clamped = Math.max(1, Math.min(targetU, rackHeight - h + 1));
  if (canPlace(placements, ru, clamped, h, rackHeight, id)) return clamped;
  return self.startU;
}

export function validateDeviceCode(code: string): string | null {
  return DEVICE_CODE_RULE.test(code)
    ? null
    : "IDs are 1–10 characters: uppercase letters, numbers, _ or -";
}

/** Highest occupied U — the floor for shrinking the rack. */
export function minRackHeight(placements: PlacementLike[], ru: RuByTemplate): number {
  return placements.reduce((m, p) => Math.max(m, spanOf(p, ru).top), 0);
}
