import { layoutPortGroup, CELL_W, ROW_H } from "@/domain/faceplate-geometry";
import type { Face, PortGroup } from "@/domain/faceplate";
import { CONNECTORS, type Media } from "@/domain/faceplate";

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

export function addPortGroup(face: Face, media: Media, pos: Pos, bounds: GridBounds): Face {
  const base: PortGroup = {
    id: crypto.randomUUID(),
    media,
    connectorType: CONNECTORS[media][0],
    idPrefix: "",
    countingDirection: "ltr",
    rows: 1, cols: 1,
    gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0,
    portOverrides: {},
  };
  const free = findFreePosition(face, base, pos, bounds);
  if (!free) return face;
  return { ...face, portGroups: [...face.portGroups, { ...base, gridX: free.x, gridY: free.y }] };
}

export function movePortGroup(face: Face, id: string, pos: Pos, bounds: GridBounds): Face {
  const g = face.portGroups.find((x) => x.id === id);
  if (!g) return face;
  const free = findFreePosition(face, g, pos, bounds, id);
  if (!free) return face;
  return {
    ...face,
    portGroups: face.portGroups.map((x) => (x.id === id ? { ...x, gridX: free.x, gridY: free.y } : x)),
  };
}

function grow(face: Face, id: string, bounds: GridBounds, delta: { cols?: number; rows?: number }): Face {
  const g = face.portGroups.find((x) => x.id === id);
  if (!g) return face;
  const grown: PortGroup = { ...g, cols: g.cols + (delta.cols ?? 0), rows: g.rows + (delta.rows ?? 0) };
  const b = groupBounds(grown);
  if (b.x + b.width > bounds.width || b.y + b.height > bounds.height) return face;
  if (wouldOverlap(face, grown, id)) return face;
  return { ...face, portGroups: face.portGroups.map((x) => (x.id === id ? grown : x)) };
}

export function addColumn(face: Face, id: string, bounds: GridBounds): Face {
  return grow(face, id, bounds, { cols: 1 });
}

export function addRow(face: Face, id: string, bounds: GridBounds): Face {
  return grow(face, id, bounds, { rows: 1 });
}

export function updatePortGroup(
  face: Face, id: string,
  patch: Partial<Pick<PortGroup, "idPrefix" | "countingDirection" | "connectorType">>,
): Face {
  return { ...face, portGroups: face.portGroups.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
}

export function deletePortGroup(face: Face, id: string): Face {
  return { ...face, portGroups: face.portGroups.filter((x) => x.id !== id) };
}

export function setPortOverride(
  face: Face, groupId: string, index: number, patch: { name?: string; flipped?: boolean },
): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) =>
      g.id === groupId
        ? { ...g, portOverrides: { ...g.portOverrides, [index]: { ...g.portOverrides[index], ...patch } } }
        : g,
    ),
  };
}

export function setSpacing(
  face: Face, groupId: string, spacing: { colSpacing?: number; rowSpacing?: number },
): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) => (g.id === groupId ? { ...g, ...spacing } : g)),
  };
}

export function maxSpacing(
  face: Face, group: PortGroup, bounds: GridBounds,
): { maxCol: number; maxRow: number } {
  // Neighbour clamp assumes no other group's bounds fall INSIDE this group's tight
  // (spacing-0) column/row span — guaranteed today because overlaps are always
  // prevented. If a future layout allows interleaved/gapped groups, the
  // `ob.x >= gridX + cols*CELL_W` / `ob.y >= gridY + rows*ROW_H` gates below must
  // also consider neighbours starting within the span.
  const gb = groupBounds(group);
  let maxCol = 0;
  if (group.cols > 1) {
    let limitRight = bounds.width;
    for (const other of face.portGroups) {
      if (other.id === group.id) continue;
      const ob = groupBounds(other);
      const vertOverlap = gb.y < ob.y + ob.height && gb.y + gb.height > ob.y;
      if (vertOverlap && ob.x >= group.gridX + group.cols * CELL_W) {
        limitRight = Math.min(limitRight, ob.x);
      }
    }
    maxCol = Math.max(0, (limitRight - group.gridX - group.cols * CELL_W) / (group.cols - 1));
  }
  let maxRow = 0;
  if (group.rows > 1) {
    let limitBottom = bounds.height;
    for (const other of face.portGroups) {
      if (other.id === group.id) continue;
      const ob = groupBounds(other);
      const horizOverlap = gb.x < ob.x + ob.width && gb.x + gb.width > ob.x;
      if (horizOverlap && ob.y >= group.gridY + group.rows * ROW_H) {
        limitBottom = Math.min(limitBottom, ob.y);
      }
    }
    maxRow = Math.max(0, (limitBottom - group.gridY - group.rows * ROW_H) / (group.rows - 1));
  }
  return { maxCol, maxRow };
}

export function wouldOverlapAt(
  face: Face, group: PortGroup, pos: Pos, bounds: GridBounds,
): boolean {
  const candidate: PortGroup = { ...group, gridX: pos.x, gridY: pos.y };
  const b = groupBounds(candidate);
  if (b.x < 0 || b.y < 0 || b.x + b.width > bounds.width || b.y + b.height > bounds.height) return true;
  return wouldOverlap(face, candidate, group.id);
}
