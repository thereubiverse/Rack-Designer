// Pure operations on a Face's `elements` (icons, and later text/shapes/lines). Mirrors the shape
// of portGroupOps: no React, no I/O — just Face → Face transforms the editor and tests can share.
import type { Face, IconElement, TextElement, ShapeElement, LineElement, FaceElement } from "@/domain/faceplate";

export const ICON_DEFAULT_SIZE = 36; // device px — a placed icon's initial width & height
export const ICON_MIN_SIZE = 12;     // device px — smallest an icon can be resized to

/** Append an icon element at a position (top-left, device px) with a default square size. */
export function addIconElement(
  face: Face,
  { gridX, gridY, iconName, w = ICON_DEFAULT_SIZE, h = ICON_DEFAULT_SIZE }:
    { gridX: number; gridY: number; iconName: string; w?: number; h?: number },
): Face {
  const el: IconElement = { id: crypto.randomUUID(), kind: "icon", gridX, gridY, w, h, iconName };
  return { ...face, elements: [...face.elements, el] };
}

/** Move an element to a new top-left position (device px). */
export function moveElement(face: Face, id: string, pos: { gridX: number; gridY: number }): Face {
  return { ...face, elements: face.elements.map((e) => (e.id === id ? { ...e, ...pos } : e)) };
}

/** Resize an element, clamped to a minimum on each axis. */
export function resizeElement(face: Face, id: string, size: { w: number; h: number }): Face {
  const w = Math.max(ICON_MIN_SIZE, size.w);
  const h = Math.max(ICON_MIN_SIZE, size.h);
  return { ...face, elements: face.elements.map((e) => (e.id === id ? { ...e, w, h } : e)) };
}

/** Resolve a corner-handle resize: uniform (square) scale driven by the larger of the two drag
 *  deltas, clamped to the minimum size and to the device body so the box never spills past the
 *  edge or into the ears (the top-left stays put, so the max is the room to the body's edges). */
export function resolveIconResize(
  orig: { gridX: number; gridY: number; w: number; h: number }, dx: number, dy: number,
  bounds: { width: number; height: number },
): { w: number; h: number } {
  const maxSize = Math.min(bounds.width - orig.gridX, bounds.height - orig.gridY);
  const size = Math.max(ICON_MIN_SIZE, Math.min(Math.max(orig.w + dx, orig.h + dy), maxSize));
  return { w: size, h: size };
}

/** Top-left of a `size`-square icon centred on a cursor (device coords), clamped so the whole box
 *  stays inside the body. Shared by the drop-preview ghost and the actual placement so they match. */
export function resolveIconDrop(
  cursorX: number, cursorY: number, size: number, bounds: { width: number; height: number },
): { gridX: number; gridY: number } {
  return {
    gridX: Math.max(0, Math.min(cursorX - size / 2, bounds.width - size)),
    gridY: Math.max(0, Math.min(cursorY - size / 2, bounds.height - size)),
  };
}

/** Resolve a resize applied to a whole selection from one anchor handle. The anchor tracks the
 *  cursor exactly (same as a single resize). `uniform` (Shift held) forces every icon to the
 *  anchor's new size; otherwise each icon scales by the same factor, keeping their relative sizes.
 *  Every result is clamped to the minimum size and to that icon's own room in the body. */
export function resolveIconGroupResize(
  boxes: { id: string; gridX: number; gridY: number; w: number; h: number }[],
  anchorId: string, dx: number, dy: number,
  bounds: { width: number; height: number }, uniform: boolean,
): { id: string; w: number; h: number }[] {
  const anchor = boxes.find((b) => b.id === anchorId);
  if (!anchor) return boxes.map((b) => ({ id: b.id, w: b.w, h: b.h }));
  const anchorSize = resolveIconResize(anchor, dx, dy, bounds).w; // clamped square side the anchor grows to
  const factor = anchorSize / anchor.w;
  return boxes.map((b) => {
    const raw = uniform ? anchorSize : b.w * factor;
    const maxSize = Math.min(bounds.width - b.gridX, bounds.height - b.gridY);
    const size = Math.max(ICON_MIN_SIZE, Math.min(raw, maxSize));
    return { id: b.id, w: size, h: size };
  });
}

/** Resolve a corner-handle resize for text/shape boxes, which — unlike icons — are not locked to a
 *  square: each axis grows independently by its own drag delta. Non-uniform (default) scales every
 *  box in the selection by the anchor's per-axis growth factor, so a single selection simply becomes
 *  `orig.w+dx x orig.h+dy` and a multi-selection keeps every box's relative proportions. `uniform`
 *  (Shift held) mirrors `resolveIconGroupResize`'s Shift behaviour but forces a square on BOTH axes:
 *  the anchor's larger new side (clamped to the anchor's own room) is broadcast to every box's w AND
 *  h. Every result is clamped to the minimum size and to that box's own room in the body. */
export function resolveElementsResize(
  boxes: { id: string; gridX: number; gridY: number; w: number; h: number }[],
  anchorId: string, dx: number, dy: number,
  bounds: { width: number; height: number }, uniform: boolean,
): { id: string; w: number; h: number }[] {
  const anchor = boxes.find((b) => b.id === anchorId);
  if (!anchor) return boxes.map((b) => ({ id: b.id, w: b.w, h: b.h }));

  const clamp = (raw: number, gridPos: number, boundSize: number) =>
    Math.max(ICON_MIN_SIZE, Math.min(raw, boundSize - gridPos));

  if (uniform) {
    const anchorMax = Math.min(bounds.width - anchor.gridX, bounds.height - anchor.gridY);
    const anchorSide = Math.max(ICON_MIN_SIZE, Math.min(Math.max(anchor.w + dx, anchor.h + dy), anchorMax));
    return boxes.map((b) => {
      const maxSize = Math.min(bounds.width - b.gridX, bounds.height - b.gridY);
      const size = Math.max(ICON_MIN_SIZE, Math.min(anchorSide, maxSize));
      return { id: b.id, w: size, h: size };
    });
  }

  const wFactor = (anchor.w + dx) / anchor.w;
  const hFactor = (anchor.h + dy) / anchor.h;
  return boxes.map((b) => ({
    id: b.id,
    w: clamp(b.w * wFactor, b.gridX, bounds.width),
    h: clamp(b.h * hFactor, b.gridY, bounds.height),
  }));
}

/** Set sizes on several elements at once (used by the multi-element resize). */
export function resizeElements(face: Face, sizes: { id: string; w: number; h: number }[]): Face {
  const byId = new Map(sizes.map((s) => [s.id, s]));
  return {
    ...face,
    elements: face.elements.map((e) => {
      const s = byId.get(e.id);
      return s ? { ...e, w: Math.max(ICON_MIN_SIZE, s.w), h: Math.max(ICON_MIN_SIZE, s.h) } : e;
    }),
  };
}

/** Remove an element by id. */
export function deleteElement(face: Face, id: string): Face {
  return { ...face, elements: face.elements.filter((e) => e.id !== id) };
}

/** Swap the icon shown by an icon element (leaves position/size). */
export function setElementIcon(face: Face, id: string, iconName: string): Face {
  return { ...face, elements: face.elements.map((e) => (e.id === id && e.kind === "icon" ? { ...e, iconName } : e)) };
}

/** Swap the icon on every listed icon element (batch — for a multi-selection). */
export function setElementsIcon(face: Face, ids: string[], iconName: string): Face {
  const set = new Set(ids);
  return { ...face, elements: face.elements.map((e) => (set.has(e.id) && e.kind === "icon" ? { ...e, iconName } : e)) };
}

/** Set the colour on every listed icon/text/shape element. */
export function setElementsColor(face: Face, ids: string[], color: string): Face {
  const set = new Set(ids);
  return { ...face, elements: face.elements.map((e) => (set.has(e.id) && (e.kind === "icon" || e.kind === "text" || e.kind === "shape") ? { ...e, color } : e)) };
}

/** Set the opacity (0–1) on every listed icon element. */
export function setElementsOpacity(face: Face, ids: string[], opacity: number): Face {
  const o = Math.max(0, Math.min(1, opacity));
  const set = new Set(ids);
  return { ...face, elements: face.elements.map((e) => (set.has(e.id) && e.kind === "icon" ? { ...e, opacity: o } : e)) };
}

/** Duplicate the listed elements (fresh ids, same position). Returns the new face + new ids so the
 *  caller can select and drag the copies (Alt/Option+drag). */
export function duplicateElements(face: Face, ids: string[]): { face: Face; newIds: string[] } {
  const set = new Set(ids);
  const copies: FaceElement[] = [];
  const newIds: string[] = [];
  for (const e of face.elements) {
    if (!set.has(e.id)) continue;
    const id = crypto.randomUUID();
    newIds.push(id);
    copies.push({ ...e, id });
  }
  return { face: { ...face, elements: [...face.elements, ...copies] }, newIds };
}

/** Clamp a shared drag delta so a set of boxes moves together without any leaving the body. */
export function resolveElementsDrag(
  boxes: { gridX: number; gridY: number; w: number; h: number }[], dx: number, dy: number,
  bounds: { width: number; height: number },
): { dx: number; dy: number } {
  if (boxes.length === 0) return { dx: 0, dy: 0 };
  const left = Math.min(...boxes.map((b) => b.gridX));
  const right = Math.max(...boxes.map((b) => b.gridX + b.w));
  const top = Math.min(...boxes.map((b) => b.gridY));
  const bottom = Math.max(...boxes.map((b) => b.gridY + b.h));
  let cdx = dx, cdy = dy;
  if (left + cdx < 0) cdx = -left; else if (right + cdx > bounds.width) cdx = bounds.width - right;
  if (top + cdy < 0) cdy = -top; else if (bottom + cdy > bounds.height) cdy = bounds.height - bottom;
  return { dx: cdx === 0 ? 0 : cdx, dy: cdy === 0 ? 0 : cdy }; // normalise -0
}

/** Set absolute positions for several elements at once (used by the multi-element drag). */
export function placeElements(face: Face, moves: { id: string; gridX: number; gridY: number }[]): Face {
  const byId = new Map(moves.map((m) => [m.id, m]));
  return { ...face, elements: face.elements.map((e) => { const m = byId.get(e.id); return m ? { ...e, gridX: m.gridX, gridY: m.gridY } : e; }) };
}

export const TEXT_DEFAULT_W = 64;
export const TEXT_DEFAULT_H = 20;
export const SHAPE_DEFAULT_SIZE = 40;
export const LINE_DEFAULT_LEN = 60;
export const LINE_MIN_LEN = 8;

/** Append a text element at a position (top-left, device px) with default size/content. */
export function addTextElement(face: Face, { gridX, gridY }: { gridX: number; gridY: number }): Face {
  const el: TextElement = { id: crypto.randomUUID(), kind: "text", gridX, gridY, w: TEXT_DEFAULT_W, h: TEXT_DEFAULT_H, content: "Text", alignment: "center", fontSize: 11 };
  return { ...face, elements: [...face.elements, el] };
}

/** Append a shape element (rect/ellipse) at a position (top-left, device px) with a default square size. */
export function addShapeElement(face: Face, shape: "rect" | "ellipse", { gridX, gridY }: { gridX: number; gridY: number }): Face {
  const el: ShapeElement = { id: crypto.randomUUID(), kind: "shape", shape, gridX, gridY, w: SHAPE_DEFAULT_SIZE, h: SHAPE_DEFAULT_SIZE };
  return { ...face, elements: [...face.elements, el] };
}

/** Append a horizontal line element centred on the drop point. */
export function addLineElement(face: Face, { gridX, gridY }: { gridX: number; gridY: number }): Face {
  const half = LINE_DEFAULT_LEN / 2;
  const el: LineElement = { id: crypto.randomUUID(), kind: "line", x1: gridX - half, y1: gridY, x2: gridX + half, y2: gridY, stroke: "#111418", strokeWidth: 1.5 };
  return { ...face, elements: [...face.elements, el] };
}

/** Shallow-merge a partial into every listed element (any kind). */
export function updateElements(face: Face, ids: string[], patch: Partial<FaceElement>): Face {
  const set = new Set(ids);
  return { ...face, elements: face.elements.map((e) => (set.has(e.id) ? { ...e, ...patch } as FaceElement : e)) };
}

/** Shift both endpoints of a line by the same delta. */
export function translateLine(face: Face, id: string, dx: number, dy: number): Face {
  return { ...face, elements: face.elements.map((e) => (e.id === id && e.kind === "line" ? { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy } : e)) };
}

/** Move one endpoint ("a" = x1/y1, "b" = x2/y2), clamped so the line keeps at least LINE_MIN_LEN. */
export function moveLineEndpoint(face: Face, id: string, which: "a" | "b", pos: { x: number; y: number }): Face {
  return {
    ...face,
    elements: face.elements.map((e) => {
      if (e.id !== id || e.kind !== "line") return e;
      const fixed = which === "a" ? { x: e.x2, y: e.y2 } : { x: e.x1, y: e.y1 };
      let { x, y } = pos;
      const len = Math.hypot(x - fixed.x, y - fixed.y);
      if (len < LINE_MIN_LEN) {
        const ux = len === 0 ? 1 : (x - fixed.x) / len;
        const uy = len === 0 ? 0 : (y - fixed.y) / len;
        x = fixed.x + ux * LINE_MIN_LEN;
        y = fixed.y + uy * LINE_MIN_LEN;
      }
      return which === "a" ? { ...e, x1: x, y1: y } : { ...e, x2: x, y2: y };
    }),
  };
}
