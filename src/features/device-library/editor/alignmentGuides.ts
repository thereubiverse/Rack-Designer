// Smart alignment & spacing guides for dragging a port group — like Figma/Sketch.
// Pure geometry: given the face, the dragged group, and a candidate position, it returns
// the snapped position plus the guide lines and equal-spacing brackets to draw.
import { layoutPortGroup } from "@/domain/faceplate-geometry";
import type { Face, PortGroup } from "@/domain/faceplate";
import type { GridBounds } from "./portGroupOps";

export interface Rect { left: number; right: number; top: number; bottom: number; cx: number; cy: number; w: number; h: number }

/** A guide line: vertical (`axis:"x"`, at x=`pos`, spanning y in [start,end]) or
 *  horizontal (`axis:"y"`, at y=`pos`, spanning x in [start,end]). */
export interface GuideLine { axis: "x" | "y"; pos: number; start: number; end: number }

/** An equal-gap bracket: a horizontal gap of `gap` px between x=`start` and x=`end`, drawn at y=`y`. */
export interface SpacingGuide { gap: number; start: number; end: number; y: number }

export interface GuideResult { x: number; yOffset: number; lines: GuideLine[]; spacings: SpacingGuide[] }

/** Rect (device coords) of a group, optionally overriding gridX / yOffset. */
export function rectOf(g: PortGroup, bounds: GridBounds, over?: { gridX?: number; yOffset?: number }): Rect {
  const gg: PortGroup = { ...g, ...(over?.gridX !== undefined ? { gridX: over.gridX } : {}), ...(over?.yOffset !== undefined ? { yOffset: over.yOffset } : {}) };
  const laid = layoutPortGroup(gg, bounds.height);
  const left = gg.gridX, right = gg.gridX + laid.width;
  const top = laid.top, bottom = laid.top + laid.height;
  return { left, right, top, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2, w: laid.width, h: laid.height };
}

const near = (a: number, b: number, t: number) => Math.abs(a - b) <= t;

export function computeGuides(
  face: Face, draggedId: string, candidate: { x: number; yOffset: number },
  bounds: GridBounds, opts: { threshold: number; allowVertical: boolean },
): GuideResult {
  const dragged = face.portGroups.find((x) => x.id === draggedId);
  if (!dragged) return { x: candidate.x, yOffset: candidate.yOffset, lines: [], spacings: [] };
  const g = rectOf(dragged, bounds, { gridX: candidate.x, yOffset: candidate.yOffset });
  const oRects = face.portGroups.filter((x) => x.id !== draggedId).map((o) => rectOf(o, bounds));
  const r = guidesForMovingRect(g, oRects, bounds, opts);
  return { x: candidate.x + r.ddx, yOffset: candidate.yOffset + r.ddy, lines: r.lines, spacings: r.spacings };
}

function shiftRect(r: Rect, dx: number, dy: number): Rect {
  return { left: r.left + dx, right: r.right + dx, cx: r.cx + dx, top: r.top + dy, bottom: r.bottom + dy, cy: r.cy + dy, w: r.w, h: r.h };
}

/** Rect-based guide core: snap a moving rect against static rects. Returns the snap delta
 *  (ddx, ddy px) plus the guide lines + spacing brackets. Used by single-group drags and
 *  the multi-selection bounding box alike. */
export function guidesForMovingRect(
  g: Rect, oRects: Rect[], bounds: GridBounds,
  opts: { threshold: number; allowVertical: boolean },
): { ddx: number; ddy: number; lines: GuideLine[]; spacings: SpacingGuide[] } {
  const t = opts.threshold;

  // ---- X: alignment (edges + centers of G vs others + body center) --------------------
  // Each candidate is a delta to apply to gridX to make a G-line meet a static line.
  const gXlines = [g.left, g.cx, g.right];
  const staticX: number[] = [];
  for (const o of oRects) staticX.push(o.left, o.cx, o.right);
  staticX.push(bounds.width / 2); // device body center

  // ---- X: equal spacing --------------------------------------------------------------
  // Reference gaps between adjacent OTHER groups (sorted by x).
  const sorted = [...oRects].sort((a, b) => a.left - b.left);
  const refGaps: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].left - sorted[i].right;
    if (gap > 0.5) refGaps.push(gap);
  }
  // Nearest neighbours of G on each side.
  const leftN = oRects.filter((o) => o.right <= g.left + t).sort((a, b) => b.right - a.right)[0];
  const rightN = oRects.filter((o) => o.left >= g.right - t).sort((a, b) => a.left - b.left)[0];

  // Collect all X snap candidates as { delta, kind }.
  type XCand = { delta: number; kind: "align" | "space" };
  const xCands: XCand[] = [];
  for (const m of gXlines) for (const s of staticX) if (near(m, s, t)) xCands.push({ delta: s - m, kind: "align" });
  // spacing: match G's gap to a reference gap, on either side
  for (const gap of refGaps) {
    if (leftN) { const target = leftN.right + gap; if (near(g.left, target, t)) xCands.push({ delta: target - g.left, kind: "space" }); }
    if (rightN) { const target = rightN.left - gap; if (near(g.right, target, t)) xCands.push({ delta: target - g.right, kind: "space" }); }
  }
  // centered between both neighbours (left gap == right gap)
  if (leftN && rightN) { const mid = (leftN.right + rightN.left) / 2; if (near(g.cx, mid, t)) xCands.push({ delta: mid - g.cx, kind: "space" }); }

  // edge distance: G's margin to a body edge matching another group's margin to a body edge
  // (same side or mirrored → symmetric layout).
  const refMargins: number[] = [];
  for (const o of oRects) { refMargins.push(o.left); refMargins.push(bounds.width - o.right); }
  for (const md of refMargins) {
    if (md <= 0.5) continue;
    if (near(g.left, md, t)) xCands.push({ delta: md - g.left, kind: "space" });          // left margin matches
    const targetRight = bounds.width - md;
    if (near(g.right, targetRight, t)) xCands.push({ delta: targetRight - g.right, kind: "space" }); // right margin matches
  }

  // Pick the smallest-magnitude delta (alignment wins ties over spacing).
  xCands.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || (a.kind === "align" ? -1 : 1));
  const ddx = xCands.length ? xCands[0].delta : 0;

  // ---- Y: alignment (2RU+ only) ------------------------------------------------------
  let ddy = 0;
  if (opts.allowVertical) {
    const gY = shiftRect(g, ddx, 0);
    const gYlines = [gY.top, gY.cy, gY.bottom];
    const staticY: number[] = [];
    for (const o of oRects) staticY.push(o.top, o.cy, o.bottom);
    staticY.push(bounds.height / 2);
    const yCands: number[] = [];
    for (const m of gYlines) for (const s of staticY) if (near(m, s, t)) yCands.push(s - m);
    yCands.sort((a, b) => Math.abs(a) - Math.abs(b));
    if (yCands.length) ddy = yCands[0];
  }

  // ---- Build the lines + spacing brackets that hold at the snapped position ----------
  const gs = shiftRect(g, ddx, ddy);
  const lines: GuideLine[] = [];
  const eps = 0.5;
  // vertical alignment lines
  for (const [mv] of [[gs.left], [gs.cx], [gs.right]] as const) {
    for (const o of oRects) for (const sv of [o.left, o.cx, o.right]) {
      if (near(mv, sv, eps)) {
        lines.push({ axis: "x", pos: sv, start: Math.min(gs.top, o.top), end: Math.max(gs.bottom, o.bottom) });
      }
    }
    if (near(mv, bounds.width / 2, eps)) lines.push({ axis: "x", pos: bounds.width / 2, start: 0, end: bounds.height });
  }
  if (opts.allowVertical) {
    for (const mv of [gs.top, gs.cy, gs.bottom]) {
      for (const o of oRects) for (const sv of [o.top, o.cy, o.bottom]) {
        if (near(mv, sv, eps)) lines.push({ axis: "y", pos: sv, start: Math.min(gs.left, o.left), end: Math.max(gs.right, o.right) });
      }
      if (near(mv, bounds.height / 2, eps)) lines.push({ axis: "y", pos: bounds.height / 2, start: 0, end: bounds.width });
    }
  }

  // spacing brackets: G's gap matches a reference gap (draw both), or centered between neighbours
  const spacings: SpacingGuide[] = [];
  const yBar = gs.cy;
  const gapEps = 1;
  if (leftN) {
    const lg = gs.left - leftN.right;
    if (lg > 0.5 && refGaps.some((rg) => near(rg, lg, gapEps))) {
      spacings.push({ gap: Math.round(lg), start: leftN.right, end: gs.left, y: yBar });
      // draw the matching reference gap too
      for (let i = 0; i < sorted.length - 1; i++) {
        const rg = sorted[i + 1].left - sorted[i].right;
        if (near(rg, lg, gapEps)) spacings.push({ gap: Math.round(rg), start: sorted[i].right, end: sorted[i + 1].left, y: (sorted[i].cy + sorted[i + 1].cy) / 2 });
      }
    }
  }
  if (rightN) {
    const rgp = rightN.left - gs.right;
    if (rgp > 0.5 && refGaps.some((rg) => near(rg, rgp, gapEps))) {
      spacings.push({ gap: Math.round(rgp), start: gs.right, end: rightN.left, y: yBar });
    }
  }
  if (leftN && rightN) {
    const lg = gs.left - leftN.right, rg = rightN.left - gs.right;
    if (lg > 0.5 && near(lg, rg, gapEps)) {
      spacings.push({ gap: Math.round(lg), start: leftN.right, end: gs.left, y: yBar });
      spacings.push({ gap: Math.round(rg), start: gs.right, end: rightN.left, y: yBar });
    }
  }

  // edge-distance brackets: G's margin to a body edge matches another group's margin
  // (same side or mirrored). Draw G's edge bracket and the matching reference's bracket.
  const gLeftM = gs.left, gRightM = bounds.width - gs.right;
  for (const o of oRects) {
    const oLeftM = o.left, oRightM = bounds.width - o.right;
    if (gLeftM > 0.5 && near(gLeftM, oLeftM, gapEps)) {
      spacings.push({ gap: Math.round(gLeftM), start: 0, end: gs.left, y: yBar });
      spacings.push({ gap: Math.round(oLeftM), start: 0, end: o.left, y: o.cy });
    }
    if (gLeftM > 0.5 && near(gLeftM, oRightM, gapEps)) {
      spacings.push({ gap: Math.round(gLeftM), start: 0, end: gs.left, y: yBar });
      spacings.push({ gap: Math.round(oRightM), start: o.right, end: bounds.width, y: o.cy });
    }
    if (gRightM > 0.5 && near(gRightM, oRightM, gapEps)) {
      spacings.push({ gap: Math.round(gRightM), start: gs.right, end: bounds.width, y: yBar });
      spacings.push({ gap: Math.round(oRightM), start: o.right, end: bounds.width, y: o.cy });
    }
    if (gRightM > 0.5 && near(gRightM, oLeftM, gapEps)) {
      spacings.push({ gap: Math.round(gRightM), start: gs.right, end: bounds.width, y: yBar });
      spacings.push({ gap: Math.round(oLeftM), start: 0, end: o.left, y: o.cy });
    }
  }

  // de-dup brackets that resolve to the same span+row
  const seen = new Set<string>();
  const uniqSpacings = spacings.filter((s) => {
    const k = `${Math.round(s.start)}-${Math.round(s.end)}-${Math.round(s.y)}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });

  // Keep every guide inside the device body — never into the ears / beyond the edges.
  const cx = (v: number) => Math.max(0, Math.min(v, bounds.width));
  const cy = (v: number) => Math.max(0, Math.min(v, bounds.height));
  const clampedLines = lines.map((l) => l.axis === "x"
    ? { ...l, pos: cx(l.pos), start: cy(l.start), end: cy(l.end) }
    : { ...l, pos: cy(l.pos), start: cx(l.start), end: cx(l.end) });
  const clampedSpacings = uniqSpacings.map((s) => ({ ...s, start: cx(s.start), end: cx(s.end), y: cy(s.y) }));

  return { ddx, ddy, lines: clampedLines, spacings: clampedSpacings };
}
