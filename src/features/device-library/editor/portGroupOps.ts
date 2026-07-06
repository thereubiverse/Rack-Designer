import { layoutPortGroup, CELL_W, ROW_H, LABEL_H, U_HEIGHT_IN, PX_PER_IN, GRID_PX } from "@/domain/faceplate-geometry";
import type { Face, PortGroup } from "@/domain/faceplate";
import { CONNECTORS, type Media } from "@/domain/faceplate";

export interface Pos { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface GridBounds { width: number; height: number }

export const SNAP = 8;
// Padding the selection box keeps around the ports; groups are placed/spread so this
// padding always stays inside the device body (the box never touches the edge/ears
// and single-column ports stay centered in their box).
export const SEL_PAD = 6;

export function groupBounds(group: PortGroup): Rect {
  const laid = layoutPortGroup(group);
  return { x: group.gridX, y: group.gridY, width: laid.width, height: laid.height };
}

function groupWidth(g: PortGroup): number {
  return g.cols * CELL_W + Math.max(0, g.cols - 1) * g.colSpacing;
}

/** A group's laid-out rectangle (x/width from gridX, y/height from its centered+offset top). */
function groupRect(g: PortGroup, bounds: GridBounds): Rect {
  const laid = layoutPortGroup(g, bounds.height);
  return { x: g.gridX, y: laid.top, width: laid.width, height: laid.height };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 2D overlap: two groups collide only if they overlap both horizontally AND vertically, so
 *  vertically-separated groups may share an X column on 2RU+ devices. */
export function wouldOverlap(face: Face, candidate: PortGroup, bounds: GridBounds, excludeId?: string): boolean {
  const cr = groupRect(candidate, bounds);
  return face.portGroups.some((g) => g.id !== excludeId && rectsOverlap(cr, groupRect(g, bounds)));
}

/** Nearest free, in-bounds x position to `desired`, snapped to `step` px (step<=1 = free).
 *  Nudges horizontally to avoid a 2D overlap. null if the row is full. */
export function findFreePosition(
  face: Face, group: PortGroup, desired: Pos, bounds: GridBounds, excludeId?: string, step: number = SNAP,
): Pos | null {
  const w = groupWidth(group);
  const lo = SEL_PAD;
  const hi = bounds.width - w - SEL_PAD;
  const snapX = (x: number) => (step > 1 ? Math.round(x / step) * step : Math.round(x));
  const tryAt = (x: number): number | null => {
    // Keep SEL_PAD of the body free on each side so the box never touches the edge.
    const cx = hi < lo ? Math.max(0, (bounds.width - w) / 2) : Math.max(lo, Math.min(snapX(x), hi));
    const candidate: PortGroup = { ...group, gridX: cx };
    return wouldOverlap(face, candidate, bounds, excludeId) ? null : cx;
  };
  const direct = tryAt(desired.x);
  if (direct !== null) return { x: direct, y: desired.y };
  const inc = step > 1 ? step : SNAP; // search increment
  const maxR = Math.ceil(bounds.width / inc) + 1;
  for (let r = 1; r <= maxR; r++) {
    for (const x of [snapX(desired.x) - r * inc, snapX(desired.x) + r * inc]) {
      const ok = tryAt(x);
      if (ok !== null) return { x: ok, y: desired.y };
    }
  }
  return null;
}

export function addPortGroup(face: Face, media: Media, pos: Pos, bounds: GridBounds, step: number = SNAP): Face {
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
  const free = findFreePosition(face, base, pos, bounds, undefined, step);
  if (!free) return face;
  return { ...face, portGroups: [...face.portGroups, { ...base, gridX: free.x, gridY: free.y }] };
}

/** Snap+clamp a desired vertical offset so the port-icon top lands on the grid and the port
 *  stack stays inside the device. Returns the resolved offset (px from the centered top). */
export function resolveYOffset(g: PortGroup, desiredOffset: number, bounds: GridBounds, step: number): number {
  const laid = layoutPortGroup({ ...g, yOffset: 0 }, bounds.height);
  const center = laid.top; // centered top
  let top = center + desiredOffset;
  if (step > 1) top = Math.round(top / step) * step; // snap the ICON top, not the box
  top = Math.max(0, Math.min(top, Math.max(0, bounds.height - laid.height)));
  return top - center;
}

export function movePortGroup(
  face: Face, id: string, target: { x: number; yOffset?: number }, bounds: GridBounds,
  opts?: { snap?: boolean; allowVertical?: boolean },
): Face {
  const g = face.portGroups.find((x) => x.id === id);
  if (!g) return face;
  const step = opts?.snap ? GRID_PX : 1;
  let yOffset = g.yOffset ?? 0;
  if (opts?.allowVertical && target.yOffset !== undefined) {
    yOffset = resolveYOffset(g, target.yOffset, bounds, step);
  }
  const moved: PortGroup = { ...g, yOffset };
  const free = findFreePosition(face, moved, { x: target.x, y: g.gridY }, bounds, id, step);
  if (!free) return face;
  return { ...face, portGroups: face.portGroups.map((x) => (x.id === id ? { ...moved, gridX: free.x } : x)) };
}

/** Max rows a group may have — 2 per rack unit. */
export function maxRows(bounds: GridBounds): number {
  const rackUnits = Math.max(1, Math.round(bounds.height / (U_HEIGHT_IN * PX_PER_IN)));
  return 2 * rackUnits;
}

type PortOverride = PortGroup["portOverrides"][number];

/** The parts of a port override that propagate to newly-added ports: orientation
 *  (flip + rotation), label position, and the port type (media + its connector) so a
 *  chevron duplicates whatever port is currently in the row/column — but NOT the
 *  per-port name (that stays unique to the original port). */
function shapeOf(ov: PortOverride | undefined): PortOverride {
  const shape: PortOverride = {};
  if (ov?.flipped !== undefined) shape.flipped = ov.flipped;
  if (ov?.labelPos !== undefined) shape.labelPos = ov.labelPos;
  if (ov?.rotation !== undefined) shape.rotation = ov.rotation;
  if (ov?.media !== undefined) shape.media = ov.media;
  if (ov?.connectorType !== undefined) shape.connectorType = ov.connectorType;
  return shape;
}
const isEmpty = (o: PortOverride): boolean => Object.keys(o).length === 0;

/** Overrides are keyed row-major (row*cols+col). When the grid grows we remap the
 *  existing ports to their new indices, then copy the orientation/label of the
 *  adjacent existing column/row onto the new ports so the pattern repeats. */
function growOverrides(g: PortGroup, dCols: number, dRows: number): PortGroup["portOverrides"] {
  const C = g.cols, R = g.rows, newC = C + dCols, newR = R + dRows;
  const ov = g.portOverrides;
  const next: PortGroup["portOverrides"] = {};
  for (let row = 0; row < R; row++) {
    for (let col = 0; col < C; col++) {
      const o = ov[row * C + col];
      if (o) next[row * newC + col] = o;
    }
  }
  if (dCols > 0) {
    for (let row = 0; row < R; row++) {
      const shape = shapeOf(ov[row * C + (C - 1)]); // last existing column in this row
      if (!isEmpty(shape)) for (let col = C; col < newC; col++) next[row * newC + col] = { ...shape };
    }
  }
  if (dRows > 0) {
    for (let col = 0; col < newC; col++) {
      const shape = shapeOf(next[(R - 1) * newC + col]); // last existing row in this column
      if (!isEmpty(shape)) for (let row = R; row < newR; row++) next[row * newC + col] = { ...shape };
    }
  }
  return next;
}

/** Remap overrides when the grid shrinks (drop the removed row/column, reindex). */
function shrinkOverrides(g: PortGroup, dCols: number, dRows: number): PortGroup["portOverrides"] {
  const C = g.cols, newC = C - dCols, newR = g.rows - dRows;
  const next: PortGroup["portOverrides"] = {};
  for (let row = 0; row < newR; row++) {
    for (let col = 0; col < newC; col++) {
      const o = g.portOverrides[row * C + col];
      if (o) next[row * newC + col] = o;
    }
  }
  return next;
}

function grow(face: Face, id: string, bounds: GridBounds, delta: { cols?: number; rows?: number }): Face {
  const g = face.portGroups.find((x) => x.id === id);
  if (!g) return face;
  const grown: PortGroup = {
    ...g,
    cols: g.cols + (delta.cols ?? 0),
    rows: g.rows + (delta.rows ?? 0),
    portOverrides: growOverrides(g, delta.cols ?? 0, delta.rows ?? 0),
  };
  if (grown.rows > maxRows(bounds)) return face; // cap at 2 rows per rack unit
  const b = groupBounds(grown);
  // Horizontal grows from gridX, so guard on the real x-extent. Vertically the stack
  // is auto-centered (gridY is not used for layout), so only require it to FIT the
  // device height — never gate on gridY, or a group dropped mid-height couldn't grow.
  if (b.x + b.width > bounds.width) return face;
  if (b.height > bounds.height) return face;
  if (wouldOverlap(face, grown, bounds, id)) return face;
  return { ...face, portGroups: face.portGroups.map((x) => (x.id === id ? grown : x)) };
}

export function addColumn(face: Face, id: string, bounds: GridBounds): Face {
  return grow(face, id, bounds, { cols: 1 });
}

export function addRow(face: Face, id: string, bounds: GridBounds): Face {
  const grown = grow(face, id, bounds, { rows: 1 });
  const g = grown.portGroups.find((x) => x.id === id);
  // A dense (3+ row) group needs a little row spacing so its (all-bottom) labels have
  // room to show. Seed a sensible default the first time we cross into 3 rows; the
  // user can still adjust it with the spacing handle afterwards.
  if (g && g.rows >= 3 && g.rowSpacing === 0) {
    const desired = Math.min(LABEL_H, maxSpacing(grown, g, bounds).maxRow);
    if (desired > 0) {
      return { ...grown, portGroups: grown.portGroups.map((x) => (x.id === id ? { ...x, rowSpacing: desired } : x)) };
    }
  }
  return grown;
}

/** Remove one column, floored at 1 (the original single column). */
export function removeColumn(face: Face, id: string): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) =>
      g.id === id && g.cols > 1 ? { ...g, cols: g.cols - 1, portOverrides: shrinkOverrides(g, 1, 0) } : g),
  };
}

/** Remove one row, floored at 1. */
export function removeRow(face: Face, id: string): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) =>
      g.id === id && g.rows > 1 ? { ...g, rows: g.rows - 1, portOverrides: shrinkOverrides(g, 0, 1) } : g),
  };
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
  face: Face, groupId: string, index: number,
  patch: { name?: string; flipped?: boolean; labelPos?: "top" | "bottom"; rotation?: number; media?: Media; connectorType?: string },
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

/** Override a single port's media (type). When it matches the group's own media the
 *  override is cleared; otherwise it also seeds that media's default connector type. */
export function setPortMedia(face: Face, groupId: string, index: number, media: Media): Face {
  const group = face.portGroups.find((g) => g.id === groupId);
  if (!group) return face;
  if (media === group.media) {
    // back to the group default → drop the per-port media/connector override
    return setPortOverride(face, groupId, index, { media: undefined, connectorType: undefined });
  }
  return setPortOverride(face, groupId, index, { media, connectorType: CONNECTORS[media][0] });
}

/** A set of port indices within one group — the unit batch edits operate on. */
export interface PortRef { groupId: string; indices: number[] }

/** Every port index in a group (row-major), used to target a whole group in a batch. */
export function allPortIndices(group: PortGroup): number[] {
  return Array.from({ length: group.rows * group.cols }, (_, i) => i);
}

/** Merge `patch` into every referenced port's override (multi-port / multi-group batch). */
export function patchPorts(
  face: Face, refs: PortRef[],
  patch: { rotation?: number; labelPos?: "top" | "bottom"; flipped?: boolean },
): Face {
  const byId = new Map(refs.map((r) => [r.groupId, r.indices]));
  return {
    ...face,
    portGroups: face.portGroups.map((g) => {
      const idxs = byId.get(g.id);
      if (!idxs || idxs.length === 0) return g;
      const po = { ...g.portOverrides };
      for (const i of idxs) po[i] = { ...po[i], ...patch };
      return { ...g, portOverrides: po };
    }),
  };
}

/** Rotate every referenced port by `delta` degrees (mod 360, kept non-negative). */
export function rotatePorts(face: Face, refs: PortRef[], delta: number): Face {
  const byId = new Map(refs.map((r) => [r.groupId, r.indices]));
  return {
    ...face,
    portGroups: face.portGroups.map((g) => {
      const idxs = byId.get(g.id);
      if (!idxs || idxs.length === 0) return g;
      const po = { ...g.portOverrides };
      for (const i of idxs) po[i] = { ...po[i], rotation: ((((po[i]?.rotation ?? 0) + delta) % 360) + 360) % 360 };
      return { ...g, portOverrides: po };
    }),
  };
}

/** Remove several groups at once. */
export function deletePortGroups(face: Face, ids: string[]): Face {
  const set = new Set(ids);
  return { ...face, portGroups: face.portGroups.filter((g) => !set.has(g.id)) };
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
  // Horizontal spread is clamped to the grid edge and to the nearest neighbour to
  // the right. Under the derived-centering model every group shares the vertical
  // center, so collision is purely horizontal — any group whose tight (spacing-0)
  // block sits to the right constrains the spread, regardless of row count.
  let maxCol = 0;
  if (group.cols > 1) {
    // Reserve SEL_PAD at the body's right edge so the spread box keeps its margin.
    let limitRight = bounds.width - SEL_PAD;
    const tightRight = group.gridX + group.cols * CELL_W;
    for (const other of face.portGroups) {
      if (other.id === group.id) continue;
      if (other.gridX >= tightRight) limitRight = Math.min(limitRight, other.gridX);
    }
    maxCol = Math.max(0, (limitRight - tightRight) / (group.cols - 1));
  }
  let maxRow = 0;
  if (group.rows > 1) {
    // Reserve the label strip AND SEL_PAD top & bottom so the box stays inside the device.
    maxRow = Math.max(0, (bounds.height - 2 * (LABEL_H + SEL_PAD) - group.rows * ROW_H) / (group.rows - 1));
  }
  return { maxCol, maxRow };
}

export function wouldOverlapAt(
  face: Face, group: PortGroup, pos: Pos, bounds: GridBounds,
): boolean {
  const w = groupWidth(group);
  if (pos.x < 0 || pos.x + w > bounds.width) return true;
  return wouldOverlap(face, { ...group, gridX: pos.x }, bounds, group.id);
}
