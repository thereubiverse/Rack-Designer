import { layoutPortGroup } from "@/domain/faceplate-geometry";
import type { Face, PortGroup } from "@/domain/faceplate";

export interface Pos { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface GridBounds { width: number; height: number }

export const SNAP = 8;

export function groupBounds(group: PortGroup): Rect {
  const laid = layoutPortGroup(group);
  return { x: group.gridX, y: group.gridY, width: laid.width, height: laid.height };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function wouldOverlap(face: Face, candidate: PortGroup, excludeId?: string): boolean {
  const cb = groupBounds(candidate);
  return face.portGroups.some((g) => g.id !== excludeId && rectsOverlap(cb, groupBounds(g)));
}

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

function clamp(bounds: GridBounds, w: number, h: number, p: Pos): Pos {
  return {
    x: Math.max(0, Math.min(p.x, bounds.width - w)),
    y: Math.max(0, Math.min(p.y, bounds.height - h)),
  };
}

/** Nearest free, in-bounds, 8px-snapped position to `desired`; null if the grid is full. */
export function findFreePosition(
  face: Face, group: PortGroup, desired: Pos, bounds: GridBounds, excludeId?: string,
): Pos | null {
  const laid = layoutPortGroup(group);
  const w = laid.width, h = laid.height;
  const tryAt = (p: Pos): Pos | null => {
    const c = clamp(bounds, w, h, { x: snap(p.x), y: snap(p.y) });
    const candidate: PortGroup = { ...group, gridX: c.x, gridY: c.y };
    return wouldOverlap(face, candidate, excludeId) ? null : c;
  };
  const direct = tryAt(desired);
  if (direct) return direct;

  const maxR = Math.ceil(Math.max(bounds.width, bounds.height) / SNAP) + 1;
  const seen = new Set<string>();
  for (let r = 1; r <= maxR; r++) {
    const ring: { p: Pos; d: number }[] = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p = { x: snap(desired.x) + dx * SNAP, y: snap(desired.y) + dy * SNAP };
        ring.push({ p, d: Math.hypot(p.x - desired.x, p.y - desired.y) });
      }
    }
    ring.sort((a, b) => a.d - b.d || a.p.y - b.p.y || a.p.x - b.p.x);
    for (const { p } of ring) {
      const ok = tryAt(p);
      if (!ok) continue;
      const key = `${ok.x},${ok.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      return ok;
    }
  }
  return null;
}
