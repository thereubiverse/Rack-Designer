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
