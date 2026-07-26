/**
 * Structural symbol matching — find a symbol by its GEOMETRY, not its pixels.
 *
 * Raster correlation (symbolMatch) cannot find this drawing set's telecom outlet. Measured against
 * the real sheets: the one verified half-shaded triangle scores 0.719 while hundreds of unrelated
 * blobs reach 0.60-0.83, and nothing separates them — not a scale ladder (saturates at every rung),
 * not resolution (2600 -> 7800px moves the top score 0.823 -> 0.80), not masking the correlation to
 * template ink (0.598, worse). The symbol is ~10px of anti-aliased ink drawn hard against the wall
 * it mounts on, and NCC correlates the whole window, wall included.
 *
 * The geometry was in the PDF the whole time, and TWO facts hid it:
 *
 *  1. The symbol is not one path. Cellar has exactly ONE 2-3-segment small path among 83,023 — CAD
 *     emitted each triangle side as its own single-segment path (there are 1,005 of those). Every
 *     earlier search looked per-path and therefore found nothing at all.
 *  2. A "half-shaded" triangle is TWO overlapping triangles: an 8-8-8 equilateral outline plus a
 *     4-7-8 right triangle forming the filled half. That is why click-to-pick could never select
 *     "only the triangle" — there was never a single object to select.
 *
 * Assembling segments ACROSS paths and clustering the parts finds them exactly: 44 / 28 / 4 / 20
 * outlets on E-101P / E-102P / E-103P / Cellar, each verified on a rendered overlay by eye.
 *
 * This module is PURE — no I/O, no pdf.js, no database. It takes the paths `decodePlanPage` already
 * produces and returns geometry, so all of it is testable without a PDF or a DB.
 */

/** A path as `decodePlanPage` returns it. Declared structurally rather than imported so this module
 *  stays free of `server-only` — the same reason `symbolMatch` declares its own `GreyImage`. */
export interface StructPath {
  segs: { a: [number, number]; b: [number, number] }[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Screened-back background architecture rather than the sheet's own subject. */
  grey: boolean;
}

export interface GreyImageLike {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export type Box = { minX: number; minY: number; maxX: number; maxY: number };

/**
 * A closed polygon assembled from segments, or a circle.
 *
 * `sides` is SORTED, which is what makes a polygon's description rotation- and translation-
 * invariant: an 8-8-8 triangle is the same signature whichever way the wall turned it. There is
 * deliberately no `rect` kind — a rectangle is a 4-sided polygon and assembles through exactly the
 * same chaining, so a separate kind would be two code paths for one shape.
 */
export type Primitive =
  | { kind: "polygon"; sides: number[]; cx: number; cy: number; r: number; verts: [number, number][] }
  | { kind: "circle"; radius: number; cx: number; cy: number; r: number; verts: [number, number][] };

// ---- Tuning ---------------------------------------------------------------------------------
//
// ALL of these are in PAGE PIXELS at the 2600-long-edge render (planPaths.RENDER_LONG_EDGE), and
// ALL were tuned on ONE architect's drawing set (Magnolia Gardens). A set drawn finer or coarser is
// the case that needs them changed, so they live together here rather than inline.

export interface PrimitiveOpts {
  /** Shortest segment that can be a polygon side. Below this it is a join artefact, not an edge. */
  minSidePx?: number;
  /** Longest segment that can be a polygon side. Above this it is a wall or a leader, not a symbol. */
  maxSidePx?: number;
  /** How close two endpoints must be to count as joined. */
  joinPx?: number;
  /** Most sides a polygon may have. Kept low: the cost of the walk grows with it and no symbol on
   *  this sheet needs more. */
  maxSides?: number;
  /** Area bounds, in px^2. Below `minArea` a "triangle" is three nearly-collinear segments. */
  minAreaPx?: number;
  maxAreaPx?: number;
  /** How square a curve-only path's bbox must be to count as a circle (min/max side ratio). */
  circleSquareness?: number;
}

const DEF: Required<PrimitiveOpts> = {
  minSidePx: 2.5,
  maxSidePx: 32,
  joinPx: 1.4,
  maxSides: 4,
  minAreaPx: 4,
  maxAreaPx: 200,
  circleSquareness: 0.75,
};

/** Cell size for the endpoint hash. Must be >= joinPx so a join can never span more than the 3x3
 *  neighbourhood the lookup scans. */
const HASH_CELL_PX = 1.2;

/** Parts of ONE symbol sit within this of each other — it is what merges a triangle's outline with
 *  its shaded half into a single proposal instead of two. Measured: the outline and half share a
 *  centroid to within ~1px, while the next symbol along is tens of pixels away. */
export const CLUSTER_PX = 4.5;

/** Length comparisons are relative with an absolute floor, so a 1px rasterisation wobble never
 *  fails a genuinely equal 8px side, and a 12px triangle never passes as an 8px one. */
const LEN_TOL_FRAC = 0.1;
const LEN_TOL_FLOOR_PX = 1.5;

const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);
const segLen = (s: { a: [number, number]; b: [number, number] }) =>
  dist(s.a[0], s.a[1], s.b[0], s.b[1]);

/** True if two lengths are equal within the relative tolerance and its absolute floor. */
export function lenEq(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(LEN_TOL_FLOOR_PX, LEN_TOL_FRAC * Math.max(a, b));
}

/** Ray casting. Used to reject a ring that merely encloses faces already found. */
function pointInPolygon(x: number, y: number, verts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const [xi, yi] = verts[i];
    const [xj, yj] = verts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Every primitive on a page.
 *
 * FOREGROUND ONLY, and that filter is load-bearing rather than tidiness: the screened-back
 * architectural layer draws X-braced boxes (closets, shafts, appliances) whose diagonals close
 * perfectly good triangles. Measured on E-102P — without this filter the page yields 122 "symbols"
 * of which 89 are those background braces. It was caught by looking at a montage of the results, not
 * by reading the count.
 */
export function extractPrimitives(paths: StructPath[], opts: PrimitiveOpts = {}): Primitive[] {
  const o = { ...DEF, ...opts };
  const out: Primitive[] = [];

  // --- circles: a path with NO straight runs at all ------------------------------------------
  // pdf.js emits a circle as pure curve operators, so `decodePlanPage` records no segments for it
  // but still grows its bbox from the curve endpoints. That "zero segments, square bbox" shape is
  // the only circle evidence available without re-walking the operator list.
  for (const p of paths) {
    if (p.grey || p.segs.length > 0) continue;
    const w = p.maxX - p.minX;
    const h = p.maxY - p.minY;
    if (w < o.minSidePx || h < o.minSidePx || w > o.maxSidePx * 2 || h > o.maxSidePx * 2) continue;
    if (Math.min(w, h) / Math.max(w, h) < o.circleSquareness) continue;
    const radius = (w + h) / 4;
    const ccx = p.minX + w / 2;
    const ccy = p.minY + h / 2;
    out.push({ kind: "circle", radius, cx: ccx, cy: ccy, r: radius, verts: [[ccx, ccy]] });
  }

  // --- polygons: chains of segments gathered from ANY path ------------------------------------
  const segs: { a: [number, number]; b: [number, number]; len: number }[] = [];
  for (const p of paths) {
    if (p.grey) continue;
    for (const s of p.segs) {
      const len = segLen(s);
      if (len >= o.minSidePx && len <= o.maxSidePx) segs.push({ a: s.a, b: s.b, len });
    }
  }

  const cell = (x: number, y: number) =>
    `${Math.round(x / HASH_CELL_PX)},${Math.round(y / HASH_CELL_PX)}`;
  const at = new Map<string, number[]>();
  segs.forEach((s, i) => {
    for (const [x, y] of [s.a, s.b]) {
      // Registered across the 3x3 neighbourhood so a lookup is a single map hit, not nine.
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const k = `${Math.round(x / HASH_CELL_PX) + dx},${Math.round(y / HASH_CELL_PX) + dy}`;
          let arr = at.get(k);
          if (!arr) at.set(k, (arr = []));
          arr.push(i);
        }
      }
    }
  });

  const joined = (p: [number, number], q: [number, number]) =>
    dist(p[0], p[1], q[0], q[1]) <= o.joinPx;
  const far = (s: { a: [number, number]; b: [number, number] }, p: [number, number]) =>
    joined(s.a, p) ? s.b : s.a;

  const seen = new Set<string>();
  /**
   * Walk from `tip` looking for a chain that closes back on `home`.
   *
   * `verts` accumulates the vertices IN WALK ORDER, which is the only way to get them: a chain's
   * segments are not consistently oriented (each was drawn as its own path, in whatever direction
   * the CAD emitted it), so neither `.a` nor `.b` is reliably "the next corner". Taking `.a` from
   * each segment instead gives a scrambled ring and a meaningless shoelace area.
   */
  const walk = (
    home: [number, number],
    tip: [number, number],
    used: number[],
    sides: number[],
    verts: [number, number][]
  ): void => {
    for (const i of at.get(cell(tip[0], tip[1])) ?? []) {
      if (used.includes(i)) continue;
      const s = segs[i];
      if (!joined(s.a, tip) && !joined(s.b, tip)) continue;
      const next = far(s, tip);
      const nextSides = [...sides, s.len];
      if (nextSides.length >= 3 && joined(next, home)) {
        record(nextSides, verts, [...used, i]);
        continue; // a closed chain is a polygon; do not walk on THROUGH the closure
      }
      if (nextSides.length < o.maxSides) {
        walk(home, next, [...used, i], nextSides, [...verts, next]);
      }
    }
  };

  type Cand = {
    sides: number[];
    cx: number;
    cy: number;
    r: number;
    area: number;
    used: number[];
    verts: [number, number][];
  };
  const cands: Cand[] = [];
  const record = (sides: number[], verts: [number, number][], used: number[]) => {
    const cx = verts.reduce((t, p) => t + p[0], 0) / verts.length;
    const cy = verts.reduce((t, p) => t + p[1], 0) / verts.length;
    const r = Math.max(...verts.map((p) => dist(p[0], p[1], cx, cy)));
    let area2 = 0;
    for (let k = 0; k < verts.length; k++) {
      const [x1, y1] = verts[k];
      const [x2, y2] = verts[(k + 1) % verts.length];
      area2 += x1 * y2 - x2 * y1;
    }
    const area = Math.abs(area2) / 2;
    if (area < o.minAreaPx || area > o.maxAreaPx) return;
    // Rounded centroid + side count: the same ring found from a different starting segment, or in
    // the opposite direction, lands on the same key and is recorded once.
    const key = `${Math.round(cx)},${Math.round(cy)},${sides.length}`;
    if (seen.has(key)) return;
    seen.add(key);
    cands.push({ sides: [...sides].sort((a, b) => a - b), cx, cy, r, area, used, verts });
  };

  for (let i = 0; i < segs.length; i++) {
    walk(segs[i].a, segs[i].b, [i], [segs[i].len], [segs[i].a, segs[i].b]);
  }

  // --- keep only the MINIMAL faces --------------------------------------------------------------
  //
  // The walk finds every closed ring, and a symbol made of two adjoining triangles also contains
  // larger rings that traverse both. Measured on E-102P: the telecom outlet came back as SIX
  // polygons — the two real triangles (8-8-8 outline, 4-7-8 shaded half) plus quads like 4-7-8-8
  // and 4-4-7-7 that ring through both. Instances decomposed slightly differently from one another,
  // so exact signature matching found 10 of 28.
  //
  // The rule is CONTAINMENT: take rings smallest-first, and reject any that encloses a face already
  // accepted. A composite ring is by definition the union of the faces inside it, so it always
  // contains one of their centroids, while two genuine neighbouring faces never contain each other.
  //
  // An edge-use cap was tried first and is NOT sufficient, which a unit test caught: for a square
  // split by its diagonal, the two triangles spend the diagonal twice but leave each of the four
  // outer sides with a spare use, so the square's own ring still came through.
  cands.sort((a, b) => a.area - b.area || a.sides.length - b.sides.length);
  const kept: Cand[] = [];
  for (const c of cands) {
    if (kept.some((k) => pointInPolygon(k.cx, k.cy, c.verts))) continue;
    kept.push(c);
    out.push({ kind: "polygon", sides: c.sides, cx: c.cx, cy: c.cy, r: c.r, verts: c.verts });
  }

  return out;
}

/**
 * A symbol's rotation-invariant description: its VERTEX CONSTELLATION.
 *
 * Not its faces. Faces were tried first and measured wrong: the outlet decomposes into two 4-7-8
 * halves plus, on some instances, extra rings — and instances differ from one another in exactly
 * that decomposition, so exact face matching found 22 of 28 on E-102P. The corner POINTS do not
 * differ; only the way rings are drawn through them does. Describing the symbol by the distances
 * between its distinct corners is therefore stable where the face list is not, and is still
 * rotation- and translation-invariant because only relative distances are used.
 */
export interface SymbolSignature {
  /** How many distinct corners the symbol has. */
  points: number;
  /** Sorted pairwise distances between those corners. */
  spans: number[];
  /** Sorted descriptors of the group's circles — a circle contributes a centre but no corners, so
   *  without this a lone circle would be indistinguishable from any other single point. */
  circles: string[];
}

/** Single-linkage clustering by centroid distance: parts of one symbol travel together. */
export function clusterPrimitives(prims: Primitive[], withinPx = CLUSTER_PX): Primitive[][] {
  const groups: Primitive[][] = [];
  const taken = new Array(prims.length).fill(false);
  for (let i = 0; i < prims.length; i++) {
    if (taken[i]) continue;
    taken[i] = true;
    const group = [prims[i]];
    // Breadth-first over the transitive neighbourhood, so a chain A-B-C stays one symbol.
    for (let g = 0; g < group.length; g++) {
      for (let j = 0; j < prims.length; j++) {
        if (taken[j]) continue;
        if (dist(group[g].cx, group[g].cy, prims[j].cx, prims[j].cy) <= withinPx) {
          taken[j] = true;
          group.push(prims[j]);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

/** The group's distinct corners. Two vertices closer than the join tolerance are the same corner
 *  reached from different faces — the shared chord endpoints of the outlet's two halves, typically. */
function distinctVerts(group: Primitive[], joinPx: number): [number, number][] {
  const pts: [number, number][] = [];
  for (const p of group) {
    if (p.kind === "circle") continue; // a centre is not a corner
    for (const v of p.verts) {
      if (!pts.some((q) => dist(q[0], q[1], v[0], v[1]) <= joinPx)) pts.push(v);
    }
  }
  return pts;
}

function signatureOf(group: Primitive[], joinPx = DEF.joinPx): SymbolSignature {
  const pts = distinctVerts(group, joinPx);
  const spans: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      spans.push(dist(pts[i][0], pts[i][1], pts[j][0], pts[j][1]));
    }
  }
  return {
    points: pts.length,
    spans: spans.sort((a, b) => a - b),
    circles: group
      .filter((p): p is Extract<Primitive, { kind: "circle" }> => p.kind === "circle")
      .map((p) => `c${Math.round(p.radius)}`)
      .sort(),
  };
}

/**
 * The signature of whatever the user picked: the ONE symbol nearest the middle of the seed box.
 *
 * Not every primitive inside the box. `pickSymbolAction` deliberately over-selects — its groups run
 * 15-70px and routinely carry the symbol PLUS the tag box or assembly beside it — so "everything
 * whose centroid is in the box" describes a neighbourhood, not a symbol. Measured on the real sheet,
 * against a verified telecom outlet:
 *
 *   box +-9px   -> 5 corners  -> 19 matches
 *   box +-20px  -> 5 corners  -> 19 matches
 *   box +-30px  -> 15 corners -> 0 matches   <- a real pick is this size
 *
 * Past ~20px the signature acquires the neighbours' corners and then nothing on the page matches it,
 * so discovery silently fell back to correlation and returned two proposals instead of nineteen.
 * Clustering first and taking the cluster nearest the box centre is what makes the pick's
 * over-selection genuinely harmless.
 */
export function signatureFor(prims: Primitive[], box: Box): SymbolSignature | null {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  let best: Primitive[] | null = null;
  let bestDist = Infinity;
  for (const group of clusterPrimitives(prims)) {
    const gx = group.reduce((t, p) => t + p.cx, 0) / group.length;
    const gy = group.reduce((t, p) => t + p.cy, 0) / group.length;
    if (gx < box.minX || gx > box.maxX || gy < box.minY || gy > box.maxY) continue;
    const d = dist(gx, gy, cx, cy);
    if (d < bestDist) {
      bestDist = d;
      best = group;
    }
  }
  return best ? signatureOf(best) : null;
}

export interface StructHit {
  /** Centre in page pixels, the same space `decodePlanPage` and the 2600-long-edge raster share. */
  x: number;
  y: number;
  /** Radius of the matched group, for hit-testing and for sampling fill. */
  r: number;
  /** How many primitives matched. One is genuinely ambiguous; the caller lowers confidence for it. */
  parts: number;
}

/** True if two signatures describe the same symbol, within tolerance. */
export function signaturesMatch(a: SymbolSignature, b: SymbolSignature): boolean {
  if (a.points !== b.points) return false;
  if (a.circles.length !== b.circles.length) return false;
  for (let i = 0; i < a.circles.length; i++) {
    if (!lenEq(Number(a.circles[i].slice(1)), Number(b.circles[i].slice(1)))) return false;
  }
  if (a.spans.length !== b.spans.length) return false;
  for (let i = 0; i < a.spans.length; i++) {
    if (!lenEq(a.spans[i], b.spans[i])) return false;
  }
  return true;
}

/** Every location on the page whose primitives match `sig`. Exact — there is no score to threshold. */
export function findMatches(
  prims: Primitive[],
  sig: SymbolSignature,
  withinPx = CLUSTER_PX
): StructHit[] {
  const hits: StructHit[] = [];
  for (const group of clusterPrimitives(prims, withinPx)) {
    if (!signaturesMatch(signatureOf(group), sig)) continue;
    const cx = group.reduce((t, p) => t + p.cx, 0) / group.length;
    const cy = group.reduce((t, p) => t + p.cy, 0) / group.length;
    const r = Math.max(...group.map((p) => p.r + dist(p.cx, p.cy, cx, cy)));
    hits.push({ x: cx, y: cy, r, parts: group.length });
  }
  return hits;
}

/**
 * solid | half | hollow, from the ink fraction around a hit's centre.
 *
 * This is the legend's own distinction on this drawing set: a SOLID triangle is
 * "TELEPHONE/DATA OUTLET WITH TWO (2) RJ-45" and a HOLLOW one is "DATA OUTLET". Geometry alone
 * cannot tell them apart — both are the same triangle — so the one thing the raster is needed for
 * is the fill.
 *
 * `img` must be at the SAME scale as the paths the primitives came from (both at the 2600 long
 * edge); this samples page pixels directly with no rescaling.
 */
export function classifyFill(img: GreyImageLike, hit: StructHit): "solid" | "half" | "hollow" {
  // Sampled over the inner ~half of the symbol: wide enough to see the shading, tight enough that
  // the surrounding white paper does not dilute it into "hollow".
  const R = Math.max(2, Math.round(hit.r * 0.55));
  let ink = 0;
  let n = 0;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = Math.round(hit.x) + dx;
      const y = Math.round(hit.y) + dy;
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      n++;
      if (img.data[y * img.width + x] < 128) ink++;
    }
  }
  const frac = n === 0 ? 0 : ink / n;
  return frac >= 0.55 ? "solid" : frac >= 0.22 ? "half" : "hollow";
}
