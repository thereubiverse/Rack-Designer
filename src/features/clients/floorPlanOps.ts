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

/** How deep into the pane the auto-scroll band reaches, and how fast it pans at full depth. */
export const EDGE_PAN_BAND_PX = 48;
export const EDGE_PAN_MAX_PX_PER_S = 900;

/**
 * How fast the plan should scroll while the cursor sits near the edge of the pane.
 *
 * Returns the velocity of the CONTENT, in screen px per second: near the LEFT edge the plan moves
 * right (positive x) so that more of its left-hand side comes into view.
 *
 * Speed ramps with depth into the band rather than switching on, so a cursor that merely strays
 * near the edge creeps instead of bolting. Past the edge entirely the ratio saturates at 1 — a
 * pointer dragged outside the pane keeps scrolling at full speed rather than stopping dead.
 */
export function edgePanVelocity(
  x: number,
  y: number,
  paneW: number,
  paneH: number,
  band = EDGE_PAN_BAND_PX,
  maxSpeed = EDGE_PAN_MAX_PX_PER_S
): [number, number] {
  if (band <= 0 || paneW <= 0 || paneH <= 0) return [0, 0];
  const axis = (v: number, size: number) => {
    // Only one side can be active unless the pane is narrower than two bands, where the nearer
    // edge should win rather than the two cancelling to zero.
    const fromStart = band - v;
    const fromEnd = v - (size - band);
    if (fromStart <= 0 && fromEnd <= 0) return 0;
    if (fromStart > fromEnd) return Math.min(1, fromStart / band) * maxSpeed;
    return -Math.min(1, fromEnd / band) * maxSpeed;
  };
  return [axis(x, paneW), axis(y, paneH)];
}

/**
 * Slide one WALL of a room in or out, keeping it parallel to itself.
 *
 * Both of the edge's endpoints move by the same amount along the edge's own normal, so the wall
 * stays straight and the two walls meeting it stretch or shrink to follow. Any component of `delta`
 * ALONG the wall is discarded — dragging a wall sideways is meaningless, and letting it through
 * would make the drag feel like it was sliding out from under the cursor.
 *
 * `aspect` is the plan's width/height. Normalized space is anisotropic (one unit of X is 2600px and
 * one of Y is 1733px on this drawing set), so the normal has to be computed in pixel proportions or
 * a dragged wall drifts off perpendicular on anything but a square plan.
 *
 * The offset is scaled back if it would push either endpoint outside the plan, rather than clamping
 * one endpoint — clamping just one would bend the wall.
 */
export function moveEdge(
  polygon: NormPoint[],
  edgeIndex: number,
  delta: NormPoint,
  aspect = 1
): NormPoint[] {
  if (polygon.length < 3) return polygon;
  if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= polygon.length) return polygon;
  const a = polygon[edgeIndex];
  const b = polygon[(edgeIndex + 1) % polygon.length];
  // Pixel proportions for the direction maths, normalized units for the result.
  const ex = (b[0] - a[0]) * aspect;
  const ey = b[1] - a[1];
  const len = Math.hypot(ex, ey);
  if (len < 1e-9) return polygon; // degenerate edge has no normal to move along
  const nx = -ey / len;
  const ny = ex / len;
  const t = delta[0] * aspect * nx + delta[1] * ny; // signed distance along the normal
  let sx = (t * nx) / aspect;
  let sy = t * ny;

  // Largest fraction of the offset that keeps BOTH endpoints on the plan.
  let scale = 1;
  for (const p of [a, b]) {
    for (const [v, s] of [
      [p[0], sx],
      [p[1], sy],
    ]) {
      if (s === 0) continue;
      const limit = s > 0 ? (1 - v) / s : -v / s;
      if (limit < scale) scale = limit;
    }
  }
  if (scale <= 0) return polygon;
  sx *= scale;
  sy *= scale;

  const next = polygon.slice();
  next[edgeIndex] = [a[0] + sx, a[1] + sy];
  next[(edgeIndex + 1) % polygon.length] = [b[0] + sx, b[1] + sy];
  return next;
}

/** The CSS cursor for a wall you can drag: arrows pointing along its normal, so the affordance says
 *  which way the wall will move. Bucketed to the four resize cursors CSS actually offers. */
export function edgeResizeCursor(a: NormPoint, b: NormPoint, aspect = 1): string {
  const ex = (b[0] - a[0]) * aspect;
  const ey = b[1] - a[1];
  if (Math.hypot(ex, ey) < 1e-9) return "grab";
  // Normal direction in SCREEN terms (x right, y down), folded to a half-turn.
  let deg = ((Math.atan2(ex, -ey) * 180) / Math.PI) % 180;
  if (deg < 0) deg += 180;
  if (deg < 22.5 || deg >= 157.5) return "ew-resize";
  if (deg < 67.5) return "nwse-resize";
  if (deg < 112.5) return "ns-resize";
  return "nesw-resize";
}

/** Ray casting, in normalized plan space. A point exactly on an edge is not guaranteed either way —
 *  callers here are testing device points against room outlines, where a tie is arbitrary anyway. */
export function pointInPolygon(point: NormPoint, polygon: NormPoint[]): boolean {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** THE both-non-null rule, in one place. `!= null`, never falsy — x === 0 is a real placement. */
export function partitionPlacement<T extends { x: number | null; y: number | null }>(
  items: T[]
): { placed: T[]; unplaced: T[] } {
  const placed = items.filter((d) => d.x != null && d.y != null);
  const unplaced = items.filter((d) => d.x == null || d.y == null);
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
