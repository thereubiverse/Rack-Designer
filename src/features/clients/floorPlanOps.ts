import type { FloorDeviceRow } from "@/lib/supabase/types";

export type NormPoint = [number, number];

export interface PlanView { panX: number; panY: number; zoom: number; imgW: number; imgH: number }

export function isNorm(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

/** ≥3 vertices, every entry a [0..1, 0..1] pair. Never throws — Slice C will feed this
 *  model-generated JSON, so it must shrug at any shape. */
export function isValidPolygon(p: unknown): p is NormPoint[] {
  if (!Array.isArray(p) || p.length < 3) return false;
  return p.every(
    (pt) => Array.isArray(pt) && pt.length === 2 &&
      typeof pt[0] === "number" && typeof pt[1] === "number" && isNorm(pt[0]) && isNorm(pt[1])
  );
}

/** Midpoint insertion on edge i -> i+1 (wrapping), returning a new array. */
export function insertVertexOnEdge(polygon: NormPoint[], edgeIndex: number): NormPoint[] {
  const a = polygon[edgeIndex];
  const b = polygon[(edgeIndex + 1) % polygon.length];
  const mid: NormPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const out = [...polygon];
  out.splice(edgeIndex + 1, 0, mid);
  return out;
}

/** A polygon must keep ≥3 vertices; below that, the removal is refused (same polygon back). */
export function removeVertex(polygon: NormPoint[], index: number): NormPoint[] {
  if (polygon.length <= 3) return polygon;
  return polygon.filter((_, i) => i !== index);
}

function dist(a: NormPoint, b: NormPoint): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Collapses CONSECUTIVE vertices closer than `epsilon` (normalized-space distance) into one,
 *  then drops a trailing vertex that duplicates the first (wrap-around close). Pure — never
 *  mutates `points` — and does NOT enforce a minimum vertex count on its own: a heavily
 *  duplicated input can legitimately come back with fewer than 3 points, and it is the caller's
 *  job to treat that exactly like any other invalid (<3) polygon and refuse to save it.
 *
 *  Exists to fix a real bug: a native double-click gesture fires two `click` events (each of
 *  which appends a draw point) before `dblclick` ever runs, so without this the LAST TWO points
 *  saved from a dblclick-close are byte-identical while an Enter-close of the same drawing never
 *  has the problem. Calling this once, in the one place both closing gestures funnel through,
 *  keeps their saved output identical. */
export function dedupePolygon(points: NormPoint[], epsilon: number): NormPoint[] {
  const out: NormPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev || dist(prev, p) >= epsilon) {
      out.push(p);
    }
  }
  if (out.length > 1 && dist(out[0], out[out.length - 1]) < epsilon) {
    out.pop();
  }
  return out;
}

/** Arithmetic mean — a stable, cheap label anchor (not the area centroid; labels don't care). */
export function polygonCentroid(polygon: NormPoint[]): NormPoint {
  const n = polygon.length;
  return [
    polygon.reduce((s, p) => s + p[0], 0) / n,
    polygon.reduce((s, p) => s + p[1], 0) / n,
  ];
}

/** THE both-non-null rule, in one place. `!= null`, never falsy — x === 0 is a real placement. */
export function partitionPlacement(devices: FloorDeviceRow[]): {
  placed: FloorDeviceRow[]; unplaced: FloorDeviceRow[];
} {
  const placed = devices.filter((d) => d.x != null && d.y != null);
  const unplaced = devices.filter((d) => d.x == null || d.y == null);
  return { placed, unplaced };
}

export function normToScreen(p: NormPoint, view: PlanView): { x: number; y: number } {
  return { x: view.panX + p[0] * view.imgW * view.zoom, y: view.panY + p[1] * view.imgH * view.zoom };
}

export function screenToNorm(screen: { x: number; y: number }, view: PlanView): NormPoint | null {
  const nx = (screen.x - view.panX) / (view.imgW * view.zoom);
  const ny = (screen.y - view.panY) / (view.imgH * view.zoom);
  if (!isNorm(nx) || !isNorm(ny)) return null;
  return [nx, ny];
}
