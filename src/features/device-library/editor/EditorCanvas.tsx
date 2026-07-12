"use client";

import { useRef, useState, useEffect } from "react";
import { Faceplate, type HighlightPort } from "@/features/device-library/faceplate/Faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H, LABEL_H, RAIL_WIDTH_IN, PX_PER_IN, GRID_PX, RU_PX } from "@/domain/faceplate-geometry";
import { MEDIA, type Face, type Media, type PortGroup, type FaceElement, type BoxElement } from "@/domain/faceplate";
import { maxSpacing, wouldOverlapAt, resolveYOffset, resolveSingleRowBoxOffset, singleRowPositions, rankForRowState, resolveRowRank, twoRowPositions, rankForTwoRowState, labelSidePositions, rankForLabelSide, findFreePosition, SEL_PAD, type Pos } from "./portGroupOps";
import { computeGuides, guidesForMovingRect, rectOf, type GuideLine, type SpacingGuide, type Rect } from "./alignmentGuides";
import { resolveIconResize, resolveIconGroupResize, resolveIconDrop, resolveElementsDrag, ICON_DEFAULT_SIZE } from "./elementOps";

// How close (screen px) a group edge/gap must get before a smart guide snaps.
const GUIDE_THRESHOLD_PX = 6;

// Vertical breathing room for the selection box labels + bottom edge controls.
// Horizontal is 0 so the device spans the full canvas width — the left ear lines
// up with the "Port Types" label and the FRONT label with the right-hand toggles.
const CANVAS_PAD_Y = 16;
const CANVAS_PAD_X = 0;

export interface EditorCanvasProps {
  face: Face;
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
  side: "FRONT" | "BACK";
  selectedGroupIds?: string[];
  selectedPortIndices?: number[];
  highlight?: HighlightPort | HighlightPort[] | null;
  onCreate?: (media: Media, pos: Pos) => void;
  /** Dropping the Icon element chip on the device → open the icon picker at this position. */
  onDropIcon?: (pos: Pos) => void;
  /** Dropping the Text element chip on the device → create a text element at this position. */
  onCreateText?: (pos: Pos) => void;
  /** Dropping the Shape element chip on the device → create a shape element at this position. */
  onCreateShape?: (pos: Pos) => void;
  /** Dropping the Line element chip on the device → create a line element at this position. */
  onCreateLine?: (pos: Pos) => void;
  /** True while the Icon element chip is being dragged (shows the drop-preview box). */
  paletteDragIcon?: boolean;
  /** Which non-icon element chip (Text/Shape) is being dragged (shows the drop-preview box). */
  paletteDragElement?: "text" | "shape" | null;
  // Line elements: move an endpoint, or translate the whole line.
  onMoveLineEndpoint?: (id: string, which: "a" | "b", pos: { x: number; y: number }) => void;
  onTranslateLine?: (id: string, dx: number, dy: number) => void;
  // Icon elements: multi-select (marquee + shift+click) / move / resize.
  selectedElementIds?: string[];
  onSelectElement?: (id: string, additive: boolean) => void;
  onMoveElements?: (moves: { id: string; gridX: number; gridY: number }[]) => void;
  onResizeElements?: (sizes: { id: string; w: number; h: number }[]) => void;
  /** Alt/Option+drag: duplicate `ids`, select the copies, and return their new ids to drag. */
  onDuplicateElements?: (ids: string[]) => string[];
  onSelect?: (id: string | null, additive: boolean) => void;
  // Marquee reports the groups AND icon elements it swept over.
  onMarqueeSelect?: (groupIds: string[], elementIds: string[], additive: boolean) => void;
  onSelectPort?: (index: number, additive: boolean) => void;
  onPortMedia?: (groupId: string, index: number, media: Media) => void;
  onAddColumn?: (id: string) => void;
  onAddRow?: (id: string) => void;
  onRemoveColumn?: (id: string) => void;
  onRemoveRow?: (id: string) => void;
  onMove?: (id: string, target: { x: number; yOffset: number }) => void;
  onMoveGroups?: (ids: string[], delta: { dx: number; dyOffset: number }) => void;
  /** Single-row vertical snap: set the group's vertical offset (px from centered) and the label
   *  side that the snapped position implies. */
  onVerticalMove?: (id: string, yOffset: number, labelPos: "top" | "bottom") => void;
  /** Two-row vertical snap: set the row spacing + per-row label sides the snapped position implies. */
  onRowSnap?: (id: string, colSpacing: number, rowSpacing: number, labels: ("top" | "bottom")[]) => void;
  /** Alt+drag: duplicate `ids`, select the copies, and return their new ids to drag. */
  onDuplicate?: (ids: string[]) => string[];
  /** End of an Alt+drag: place the copies at `delta`, or discard them (delta null / rejected). */
  onDuplicateDrop?: (newIds: string[], delta: { dx: number; dyOffset: number } | null) => void;
  onSpacing?: (id: string, spacing: { colSpacing?: number; rowSpacing?: number }) => void;
  snapToGrid?: boolean;
  /** Media of the palette chip currently being dragged (for the drop-preview box). */
  paletteDragMedia?: Media | null;
}

// A "box" element (icon/text/shape) sits in a gridX/gridY/w/h box and shares the generic
// select/move/resize overlay below; lines are a separate future overlay.
const isBoxEl = (e: FaceElement): e is BoxElement => e.kind === "icon" || e.kind === "text" || e.kind === "shape";

export function EditorCanvas(props: EditorCanvasProps) {
  const { face, widthIn, rackUnits, rackMounted, side } = props;
  const overlayRef = useRef<HTMLDivElement>(null);
  const editing = Boolean(props.onSelect || props.onCreate);
  const dims = frameDims({ widthIn, rackUnits, rackMounted });
  const earX = dims.earWidthPx;

  // No label gutter — the FRONT/BACK label sits inside the frame, so the device fills the
  // full width and its right edge lines up with the toolbar toggles.
  const svgW = dims.frameWidthPx;
  const svgH = dims.heightPx;
  // Scale off a constant reference (the full rack-mounted 19" frame) so toggling
  // Rack Mounted — which shrinks the frame — doesn't change the scale, and the
  // render height stays put instead of shifting vertically.
  const scaleRefW = RAIL_WIDTH_IN * PX_PER_IN;
  const outerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);

  useEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      // Reserve the horizontal padding so the padded box never overflows into a scrollbar.
      // Scale to fill the width (SVG scales cleanly, so growing past 1 is fine) — a full
      // rack device then spans the container and its right edge lines up with the toolbar.
      const avail = el.clientWidth - CANVAS_PAD_X * 2;
      const s = avail > 0 ? avail / scaleRefW : 1;
      scaleRef.current = s;
      setScale(s);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scaleRefW]);

  const [drag, setDrag] = useState<
    { id: string; ids: string[]; duplicate?: boolean; startX: number; startY: number; origX: number; origY: number; origOffset: number; dx: number; dy: number } | null
  >(null);
  // Marquee (rubber-band) selection state — client coords; converted on use. (Effect below,
  // after `bounds` is in scope.)
  const [marquee, setMarquee] = useState<{ sx: number; sy: number; cx: number; cy: number; additive: boolean } | null>(null);
  // Set when a marquee actually DRAGGED (vs. a plain click) so the trailing click it produces
  // can be swallowed before it bubbles to a parent "click empty space → deselect" handler.
  const marqueeMovedRef = useRef(false);

  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      setDrag((d) => (d ? { ...d, dx: (e.clientX - d.startX) / s, dy: (e.clientY - d.startY) / s } : d));
    }
    function onUp(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const dx = (e.clientX - drag!.startX) / s;
      const dy = (e.clientY - drag!.startY) / s;
      // Only commit an actual move — a plain select-click (no movement) must not
      // mutate the face (avoids a redundant re-render and off-grid re-snapping).
      const moved = dx !== 0 || dy !== 0;
      // Delta from the set's original position (guides/grid/clamp applied).
      const delta = (() => {
        if (!moved) return null;
        if (drag!.ids.length > 1) { const m = resolveMultiMove(drag!.ids, dx, dy); return m ? { dx: m.dx, dyOffset: m.dyOffset } : null; }
        const r = resolveDrag(drag!.id, dx, dy);
        return r ? { dx: r.liveX - drag!.origX, dyOffset: r.liveOffsetY - drag!.origOffset } : null;
      })();
      if (drag!.duplicate) {
        props.onDuplicateDrop?.(drag!.ids, delta); // place the copies, or discard on no-move/overlap
      } else if (moved) {
        if (drag!.ids.length > 1) { if (delta) props.onMoveGroups?.(drag!.ids, delta); }
        else { const r = resolveDrag(drag!.id, dx, dy); if (r) props.onMove?.(drag!.id, { x: r.liveX, yOffset: r.liveOffsetY }); }
      }
      setDrag(null);
    }
    function onCancel() {
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [drag, props]);

  const [chevDrag, setChevDrag] = useState<
    { id: string; axis: "col" | "row"; start: number; initial: number } | null
  >(null);
  // Net rows/cols this chevron drag has applied so far (signed: + added, − removed).
  // A ref (not state) so the parent add/remove callbacks fire from event handlers,
  // never inside a state updater (which would setState-the-parent during render).
  const chevNetRef = useRef(0);
  const chevMovedRef = useRef(false);

  useEffect(() => {
    if (!chevDrag) return;
    const d = chevDrag;
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const step = d.axis === "col" ? CELL_W : ROW_H;
      const dist = (d.axis === "col" ? e.clientX - d.start : e.clientY - d.start) / s;
      // signed target delta; can't remove below 1 (the original single row/col)
      const want = Math.max(Math.round(dist / step), -(d.initial - 1));
      while (chevNetRef.current < want) {
        if (d.axis === "col") props.onAddColumn?.(d.id);
        else props.onAddRow?.(d.id);
        chevNetRef.current++;
        chevMovedRef.current = true;
      }
      while (chevNetRef.current > want) {
        if (d.axis === "col") props.onRemoveColumn?.(d.id);
        else props.onRemoveRow?.(d.id);
        chevNetRef.current--;
        chevMovedRef.current = true;
      }
    }
    function onUp() {
      // a plain click (no threshold crossed) still adds one
      if (!chevMovedRef.current) {
        if (d.axis === "col") props.onAddColumn?.(d.id);
        else props.onAddRow?.(d.id);
      }
      setChevDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [chevDrag, props]);

  const bounds = { width: dims.bodyWidthPx, height: dims.heightPx };
  // Snap step (12px on, free off) and whether the device is tall enough to drag vertically.
  const snapStep = props.snapToGrid ? GRID_PX : 1;
  // Vertical drag steps by a quarter of a rack unit when snap-to-grid is on (free otherwise).
  const vSnapStep = props.snapToGrid ? RU_PX / 4 : 1;
  const allowVertical = rackUnits >= 2;
  const snapX = (x: number) => (snapStep > 1 ? Math.round(x / snapStep) * snapStep : x);

  function clientToDevice(clientX: number, clientY: number): Pos {
    const rect = overlayRef.current?.getBoundingClientRect();
    return toDevicePos({ x: clientX, y: clientY }, { left: rect?.left ?? 0, top: rect?.top ?? 0 }, scaleRef.current, earX);
  }
  // Select every group whose VISIBLE PORTS the marquee overlaps. Each group renders a hidden
  // `glyph-bounds` element matching the exact on-screen port area, so the hit test uses that
  // real rect directly — it can never drift from what's drawn, and it stays correct as the
  // selection box grows (single-row 1RU slots) or the ports slide inside it. Unmeasurable
  // rects (e.g. jsdom) fall back to including the group.
  function marqueeSelect(sx: number, sy: number, ex: number, ey: number, additive: boolean) {
    const ml = Math.min(sx, ex), mr = Math.max(sx, ex), mt = Math.min(sy, ey), mb = Math.max(sy, ey);
    const hits = (selector: string, prefix: string) => {
      const out: string[] = [];
      overlayRef.current?.querySelectorAll(selector).forEach((el) => {
        const r = el.getBoundingClientRect();
        const id = (el.getAttribute("data-testid") || "").replace(prefix, "");
        if (r.width <= 0 || r.height <= 0) { out.push(id); return; } // unmeasurable (jsdom) → include
        if (r.left < mr && r.right > ml && r.top < mb && r.bottom > mt) out.push(id);
      });
      return out;
    };
    const groupIds = hits('[data-testid^="glyph-bounds-"]', "glyph-bounds-");
    const elementIds = hits('[data-testid^="el-hit-"]', "el-hit-");
    props.onMarqueeSelect?.(groupIds, elementIds, additive);
  }
  // Marquee lifecycle: select LIVE as it's dragged (so it never depends on the release point),
  // and deselect on a plain click.
  useEffect(() => {
    if (!marquee) return;
    const { sx, sy, additive } = marquee;
    function onMove(e: PointerEvent) {
      setMarquee((m) => (m ? { ...m, cx: e.clientX, cy: e.clientY } : m));
      if (Math.abs(e.clientX - sx) > 2 || Math.abs(e.clientY - sy) > 2) marqueeSelect(sx, sy, e.clientX, e.clientY, additive);
    }
    function onUp(e: PointerEvent) {
      const moved = Math.abs(e.clientX - sx) > 2 || Math.abs(e.clientY - sy) > 2;
      if (moved) { marqueeSelect(sx, sy, e.clientX, e.clientY, additive); marqueeMovedRef.current = true; }
      else props.onSelect?.(null, false); // plain click on blank → deselect
      setMarquee(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [marquee, face, bounds, props]); // eslint-disable-line react-hooks/exhaustive-deps


  // Resolve a live drag position: smart guides win when a guide is within threshold,
  // otherwise fall back to grid-snap / free. Returns the clamped live position + the guide
  // lines & equal-spacing brackets to draw. Shared by the render, move preview, and commit.
  function resolveDrag(gid: string, dx: number, dy: number): { liveX: number; liveOffsetY: number; lines: GuideLine[]; spacings: SpacingGuide[] } | null {
    const g = face.portGroups.find((x) => x.id === gid);
    if (!g) return null;
    const rawX = g.gridX + dx;
    const rawOffsetY = allowVertical ? (g.yOffset ?? 0) + dy : (g.yOffset ?? 0);
    let x = rawX, yOff = rawOffsetY;
    let lines: GuideLine[] = [], spacings: SpacingGuide[] = [];
    const gr = computeGuides(face, gid, { x: rawX, yOffset: rawOffsetY }, bounds, { threshold: GUIDE_THRESHOLD_PX / (scaleRef.current || 1), allowVertical });
    if (gr.lines.length || gr.spacings.length) { x = gr.x; yOff = gr.yOffset; lines = gr.lines; spacings = gr.spacings; }
    else x = snapX(rawX);
    const laidW = layoutPortGroup(g, dims.heightPx).width;
    const liveMax = Math.max(SEL_PAD, bounds.width - laidW - SEL_PAD);
    const liveX = Math.max(SEL_PAD, Math.min(x, liveMax));
    const guideY = lines.some((l) => l.axis === "y");
    // Single-row groups keep their full 1RU box inside the device (box snaps/clamps, never shrinks);
    // other groups clamp the port stack itself.
    const liveOffsetY = !allowVertical ? (g.yOffset ?? 0)
      : g.rows === 1 ? resolveSingleRowBoxOffset(yOff, bounds.height, guideY ? 1 : vSnapStep)
      : resolveYOffset(g, yOff, bounds, guideY ? 1 : vSnapStep);
    return { liveX, liveOffsetY, lines, spacings };
  }
  const activeDrag = drag ? resolveDrag(drag.id, drag.dx, drag.dy) : null;

  // Resolve a multi-group move: apply a shared raw delta, then snap the selection's outer
  // bounding box (smart guides → grid), clamp it to the body, and return the final delta +
  // guides. Each moving group ends up at its original position + this delta.
  function resolveMultiMove(ids: string[], rawDx: number, rawDy: number): { dx: number; dyOffset: number; lines: GuideLine[]; spacings: SpacingGuide[] } | null {
    const movers = ids.map((id) => face.portGroups.find((g) => g.id === id)).filter((g): g is NonNullable<typeof g> => !!g);
    if (movers.length < 2) return null;
    const cand: Rect[] = movers.map((g) => rectOf(g, bounds, { gridX: g.gridX + rawDx, yOffset: allowVertical ? (g.yOffset ?? 0) + rawDy : (g.yOffset ?? 0) }));
    const bbox: Rect = {
      left: Math.min(...cand.map((r) => r.left)), right: Math.max(...cand.map((r) => r.right)),
      top: Math.min(...cand.map((r) => r.top)), bottom: Math.max(...cand.map((r) => r.bottom)),
      cx: 0, cy: 0, w: 0, h: 0,
    };
    bbox.cx = (bbox.left + bbox.right) / 2; bbox.cy = (bbox.top + bbox.bottom) / 2; bbox.w = bbox.right - bbox.left; bbox.h = bbox.bottom - bbox.top;
    const others = face.portGroups.filter((g) => !ids.includes(g.id)).map((o) => rectOf(o, bounds));
    let ddx = 0, ddy = 0, lines: GuideLine[] = [], spacings: SpacingGuide[] = [];
    const gridSnap = (v: number) => (snapStep > 1 ? Math.round(v / snapStep) * snapStep - v : 0);
    const gr = guidesForMovingRect(bbox, others, bounds, { threshold: GUIDE_THRESHOLD_PX / (scaleRef.current || 1), allowVertical });
    if (gr.lines.length || gr.spacings.length) { ddx = gr.ddx; ddy = gr.ddy; lines = gr.lines; spacings = gr.spacings; }
    else ddx = gridSnap(bbox.left);
    // clamp the bounding box inside the body
    const bl = bbox.left + ddx, br = bbox.right + ddx;
    if (bl < SEL_PAD) ddx += SEL_PAD - bl; else if (br > bounds.width - SEL_PAD) ddx -= br - (bounds.width - SEL_PAD);
    if (allowVertical) { const bt = bbox.top + ddy, bb = bbox.bottom + ddy; if (bt < 0) ddy -= bt; else if (bb > bounds.height) ddy -= bb - bounds.height; }
    return { dx: rawDx + ddx, dyOffset: allowVertical ? rawDy + ddy : 0, lines, spacings };
  }
  const isMulti = !!drag && drag.ids.length > 1;
  const multiDrag = isMulti && drag ? resolveMultiMove(drag.ids, drag.dx, drag.dy) : null;
  const guideData = isMulti ? multiDrag : activeDrag; // which drag's guides to draw (port groups)

  // Rect (device coords) of an icon-shaped box — icons align by their own edges/centre.
  const iconRect = (b: { gridX: number; gridY: number; w: number; h: number }): Rect => ({
    left: b.gridX, right: b.gridX + b.w, top: b.gridY, bottom: b.gridY + b.h,
    cx: b.gridX + b.w / 2, cy: b.gridY + b.h / 2, w: b.w, h: b.h,
  });
  // Resolve an icon-element drag with smart guides: snap the moving set's bounding box against the
  // other icons AND the port groups (guides win, else grid), clamp it to the body, and return the
  // final delta + guide lines to draw. Mirrors resolveMultiMove but in 2D and edge-to-edge.
  function resolveIconDrag(origs: ElBox[], rawDx: number, rawDy: number): { dx: number; dy: number; lines: GuideLine[]; spacings: SpacingGuide[] } {
    const movingIds = new Set(origs.map((o) => o.id));
    const cand = origs.map((o) => iconRect({ gridX: o.gridX + rawDx, gridY: o.gridY + rawDy, w: o.w, h: o.h }));
    const bbox: Rect = {
      left: Math.min(...cand.map((r) => r.left)), right: Math.max(...cand.map((r) => r.right)),
      top: Math.min(...cand.map((r) => r.top)), bottom: Math.max(...cand.map((r) => r.bottom)),
      cx: 0, cy: 0, w: 0, h: 0,
    };
    bbox.cx = (bbox.left + bbox.right) / 2; bbox.cy = (bbox.top + bbox.bottom) / 2; bbox.w = bbox.right - bbox.left; bbox.h = bbox.bottom - bbox.top;
    const others: Rect[] = [];
    for (const el of face.elements) if (el.kind === "icon" && !movingIds.has(el.id)) others.push(iconRect(el));
    for (const g of face.portGroups) others.push(rectOf(g, bounds));
    const gridSnap = (v: number) => (snapStep > 1 ? Math.round(v / snapStep) * snapStep - v : 0);
    let ddx = 0, ddy = 0, lines: GuideLine[] = [], spacings: SpacingGuide[] = [];
    const gr = guidesForMovingRect(bbox, others, bounds, { threshold: GUIDE_THRESHOLD_PX / (scaleRef.current || 1), allowVertical: true });
    if (gr.lines.length || gr.spacings.length) { ddx = gr.ddx; ddy = gr.ddy; lines = gr.lines; spacings = gr.spacings; }
    else { ddx = gridSnap(bbox.left); ddy = gridSnap(bbox.top); }
    // clamp the bounding box inside the body (icons may reach the edges — no ear padding)
    const bl = bbox.left + ddx, br = bbox.right + ddx;
    if (bl < 0) ddx -= bl; else if (br > bounds.width) ddx -= br - bounds.width;
    const bt = bbox.top + ddy, bb = bbox.bottom + ddy;
    if (bt < 0) ddy -= bt; else if (bb > bounds.height) ddy -= bb - bounds.height;
    return { dx: rawDx + ddx, dy: rawDy + ddy, lines, spacings };
  }

  // The clamped-to-body 1RU slot box for the palette drop-preview, in overlay-local coords. A
  // fresh drop is a single-row group, so the preview matches its 1RU selection box exactly.
  function clampedBox(gridX: number, laidWidth: number, laidTop: number, laidHeight: number) {
    const rawLeft = earX + gridX - SEL_PAD;
    const rawTop = laidTop - (RU_PX - laidHeight) / 2;
    const rawW = laidWidth + SEL_PAD * 2;
    const rawH = RU_PX;
    const cL = Math.max(0, earX - rawLeft);
    const cT = Math.max(0, -rawTop);
    const cR = Math.min(rawW, earX + dims.bodyWidthPx - rawLeft);
    const cB = Math.min(rawH, dims.heightPx - rawTop);
    return { left: rawLeft + cL, top: rawTop + cT, width: Math.max(0, cR - cL), height: Math.max(0, cB - cT) };
  }
  const [spaceDrag, setSpaceDrag] = useState<
    { id: string; startX: number; startY: number; grabCol: number; grabRow: number; maxCol: number; maxRow: number; cols: number; rows: number } | null
  >(null);

  useEffect(() => {
    if (!spaceDrag) return;
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const sd = spaceDrag!;
      // Spacing is smooth by default; when snap-to-grid is on it steps by the grid (GRID_PX).
      const snap = (v: number) => (props.snapToGrid ? Math.round(v / GRID_PX) * GRID_PX : v);
      // Map cursor movement so the handle tracks the cursor: each unit of column spacing widens
      // the box by (cols-1); each unit of row spacing grows it from the center at (rows-1)/2.
      const colDen = Math.max(1, sd.cols - 1);
      const colSpacing = Math.max(0, Math.min(sd.maxCol, snap(sd.grabCol + (e.clientX - sd.startX) / (s * colDen))));
      if (sd.maxRow > 0) {
        // 2RU+ has vertical room: also space the rows. (On 1RU maxRow is 0, so the handle spaces
        // horizontally only — the vertical arrangement is owned by the left up/down handle.)
        const rowDen = Math.max(1, sd.rows - 1);
        const rowSpacing = Math.max(0, Math.min(sd.maxRow, snap(sd.grabRow + (2 * (e.clientY - sd.startY)) / (s * rowDen))));
        props.onSpacing?.(sd.id, { colSpacing, rowSpacing });
      } else {
        props.onSpacing?.(sd.id, { colSpacing }); // leave rowSpacing (owned by the left handle) untouched
      }
    }
    function onUp() { setSpaceDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [spaceDrag, props]);

  // The left up/down handle: snap a group's vertical port/label position. A single row cycles the
  // six 1RU-slot positions (yOffset + label); a 2-row group toggles the two positions (rows
  // together with labels outside ↔ spread to the pad edges with labels swapped inside).
  const [vertDrag, setVertDrag] = useState<
    { id: string; startY: number; grabRank: number; grabCol: number; rows: number } | null
  >(null);

  useEffect(() => {
    if (!vertDrag) return;
    function commit(clientY: number) {
      const s = scaleRef.current || 1;
      const vd = vertDrag!;
      const dy = (clientY - vd.startY) / s;
      if (vd.rows >= 3) {
        // Dense group: the glyphs stay put; the handle only flips every label above/below.
        const labelPos = labelSidePositions()[resolveRowRank(vd.grabRank, dy, 2)];
        props.onVerticalMove?.(vd.id, 0, labelPos);
      } else if (vd.rows === 2) {
        const pos = twoRowPositions()[resolveRowRank(vd.grabRank, dy, 2)];
        props.onRowSnap?.(vd.id, vd.grabCol, pos.rowSpacing, pos.labels);
      } else {
        const pos = singleRowPositions()[resolveRowRank(vd.grabRank, dy)];
        props.onVerticalMove?.(vd.id, pos.yOffset, pos.labelPos);
      }
    }
    function onMove(e: PointerEvent) { commit(e.clientY); }
    function onUp(e: PointerEvent) { commit(e.clientY); setVertDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [vertDrag, props]);

  // Icon element move/resize: commits live (the elements re-render at their new box each move).
  // A move carries the whole selected set (so they move together); a resize is a single element.
  type ElBox = { id: string; gridX: number; gridY: number; w: number; h: number };
  const [elDrag, setElDrag] = useState<
    { ids: string[]; mode: "move" | "resize"; startX: number; startY: number; origs: ElBox[]; anchorId?: string } | null
  >(null);
  // The icon the cursor is over — its resize handle shows even inside a multi-selection.
  const [hoverElId, setHoverElId] = useState<string | null>(null);
  // Smart-guide lines to draw while dragging icon element(s) (mirrors the group-drag guides).
  const [elGuides, setElGuides] = useState<{ lines: GuideLine[]; spacings: SpacingGuide[] } | null>(null);
  // Guides to render: a port-group drag's, else the icon drag's (only one runs at a time).
  const guideDraw = guideData ?? elGuides;
  useEffect(() => {
    if (!elDrag) return;
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const d = elDrag!;
      const dx = (e.clientX - d.startX) / s, dy = (e.clientY - d.startY) / s;
      if (d.mode === "move") {
        const res = resolveIconDrag(d.origs, dx, dy); // smart guides → grid → clamped to the body
        props.onMoveElements?.(d.origs.map((o) => ({ id: o.id, gridX: o.gridX + res.dx, gridY: o.gridY + res.dy })));
        setElGuides(res.lines.length || res.spacings.length ? { lines: res.lines, spacings: res.spacings } : null);
      } else {
        // Resize the whole selection from the anchor handle; Shift forces one uniform size,
        // otherwise every icon scales by the same factor (kept square + clamped per-icon).
        props.onResizeElements?.(resolveIconGroupResize(d.origs, d.anchorId ?? d.origs[0].id, dx, dy, bounds, e.shiftKey));
      }
    }
    function onUp() { setElDrag(null); setElGuides(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [elDrag, props, bounds]);

  // Line element move/reshape: a separate drag state from the box-element `elDrag` above since a
  // line has no gridX/gridY/w/h box — it's two endpoints. "move" translates both endpoints by the
  // same delta; "a"/"b" drags just that endpoint (device px, snapped to GRID_PX when enabled).
  type LineDrag = { kind: "line"; id: string; mode: "move" | "a" | "b"; startX: number; startY: number; ox1: number; oy1: number; ox2: number; oy2: number };
  const [lineDrag, setLineDrag] = useState<LineDrag | null>(null);
  useEffect(() => {
    if (!lineDrag) return;
    const d = lineDrag;
    // `translateLine` is delta-based (adds to whatever the face currently holds), unlike the
    // absolute-set box ops, so a "move" drag must send only the INCREMENT since the last event —
    // sending the full since-drag-start delta on every move would re-apply already-applied motion.
    let lastDx = 0, lastDy = 0;
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const dx = (e.clientX - d.startX) / s, dy = (e.clientY - d.startY) / s;
      if (d.mode === "move") {
        props.onTranslateLine?.(d.id, dx - lastDx, dy - lastDy);
        lastDx = dx; lastDy = dy;
      } else {
        // Endpoint drags are absolute (mirrors the box move/resize pattern): recompute from the
        // original endpoint each event, so out-of-order/duplicate events can't drift.
        const snap = (v: number) => (props.snapToGrid ? Math.round(v / GRID_PX) * GRID_PX : v);
        const x = snap((d.mode === "a" ? d.ox1 : d.ox2) + dx);
        const y = snap((d.mode === "a" ? d.oy1 : d.oy2) + dy);
        props.onMoveLineEndpoint?.(d.id, d.mode, { x, y });
      }
    }
    function onUp() { setLineDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [lineDrag, props]);

  function dropPos(e: React.DragEvent): Pos {
    const rect = overlayRef.current?.getBoundingClientRect();
    return toDevicePos({ x: e.clientX, y: e.clientY }, { left: rect?.left ?? 0, top: rect?.top ?? 0 }, scaleRef.current, earX);
  }

  // Which existing port sits under the cursor (for drag-a-type-onto-a-port).
  const [dragOverPort, setDragOverPort] = useState<{ groupId: string; index: number } | null>(null);
  // Where a new group would land if the palette chip is dropped on empty space (drop preview).
  const [dropPreview, setDropPreview] = useState<PortGroup | null>(null);
  // Cursor position (device coords) while the Icon chip is dragged over the device (icon preview).
  const [iconDropAt, setIconDropAt] = useState<Pos | null>(null);
  function portAt(clientX: number, clientY: number): { groupId: string; index: number } | null {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const s = scaleRef.current || 1;
    const lx = (clientX - rect.left) / s;
    const ly = (clientY - rect.top) / s;
    for (const g of face.portGroups) {
      const laid = layoutPortGroup(g, dims.heightPx);
      for (const cell of laid.cells) {
        const cx = earX + cell.x;
        if (lx >= cx && lx <= cx + CELL_W && ly >= cell.y && ly <= cell.y + ROW_H) return { groupId: g.id, index: cell.index };
      }
    }
    return null;
  }

  // While a group is being moved, shift its glyphs + labels by the same (clamped)
  // offset as the selection box, so they track the box during the drag.
  const movePreview = (() => {
    if (!drag) return null;
    if (isMulti && multiDrag) {
      return drag.ids.flatMap((id) => {
        const g = face.portGroups.find((x) => x.id === id);
        if (!g) return [];
        const laidW = rectOf(g, bounds).w;
        const liveX = Math.max(SEL_PAD, Math.min(g.gridX + multiDrag.dx, bounds.width - laidW - SEL_PAD));
        const liveOffsetY = resolveYOffset(g, (g.yOffset ?? 0) + multiDrag.dyOffset, bounds, 1);
        return [{ groupId: id, offsetX: liveX - g.gridX, offsetY: liveOffsetY - (g.yOffset ?? 0) }];
      });
    }
    if (!activeDrag) return null;
    const g = face.portGroups.find((x) => x.id === drag.id);
    if (!g) return null;
    return { groupId: g.id, offsetX: activeDrag.liveX - g.gridX, offsetY: activeDrag.liveOffsetY - (g.yOffset ?? 0) };
  })();

  return (
    <div ref={outerRef} data-testid="editor-canvas-fit" style={{ width: "100%" }}>
      {/* Vertical padding reserves room for the selection box labels + bottom edge
          controls; horizontal is 0 so a mounted device spans the full canvas width.
          margin auto keeps a narrower (unmounted) device centred instead of shifting left. */}
      <div style={{ position: "relative", width: svgW * scale + CANVAS_PAD_X * 2, height: svgH * scale + CANVAS_PAD_Y * 2, margin: "0 auto" }}>
        <div style={{ position: "absolute", top: CANVAS_PAD_Y, left: CANVAS_PAD_X, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <div data-testid="editor-canvas" style={{ position: "relative", display: "inline-block" }}>
            <Faceplate face={face} widthIn={widthIn} rackUnits={rackUnits} rackMounted={rackMounted} side={side}
              highlight={dragOverPort ? { groupId: dragOverPort.groupId, portIndex: dragOverPort.index } : props.highlight}
              movePreview={movePreview} />

            {editing && (
        <div
          ref={overlayRef}
          data-testid="editor-overlay"
          style={{ position: "absolute", inset: 0 }}
          onPointerDown={(e) => {
            // Blank-canvas press (group boxes stop propagation) → start a marquee; a plain
            // click with no drag deselects on release.
            if (!props.onSelect || e.button !== 0) return;
            // Clear any stale "just dragged" flag (e.g. a prior marquee that released over a
            // group glyph, so its trailing click never reached this overlay to reset it) — the
            // press that precedes THIS click owns whether the click gets swallowed.
            marqueeMovedRef.current = false;
            setMarquee({ sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY, additive: e.shiftKey });
          }}
          onClick={(e) => {
            // A marquee DRAG ends with a synthetic click on this overlay. Swallow it so it
            // doesn't bubble to a parent "click empty space → deselect" handler and wipe the
            // selection the drag just made. A plain click (no drag) is left to bubble.
            if (marqueeMovedRef.current) { e.stopPropagation(); marqueeMovedRef.current = false; }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move"; // suppress the native "+" copy badge
            if (props.paletteDragIcon || props.paletteDragElement) { // Icon/Text/Shape chip → preview where it lands
              setDragOverPort(null); setDropPreview(null); setIconDropAt(dropPos(e)); return;
            }
            const p = portAt(e.clientX, e.clientY);
            if (p) {
              // Over a port → it will be re-typed; show the port highlight, not a drop box.
              setDragOverPort((prev) => (prev?.groupId === p.groupId && prev?.index === p.index ? prev : p));
              setDropPreview(null);
            } else {
              setDragOverPort(null);
              // Over empty space → preview where the new group's selection box will land.
              const media = props.paletteDragMedia;
              if (media) {
                const base = phantomGroup(media);
                // Same step as the real drop: 1px (smooth) when snap is off, 12px when on.
                const free = findFreePosition(face, base, dropPos(e), bounds, undefined, snapStep);
                setDropPreview(free ? { ...base, gridX: free.x } : null);
              }
            }
          }}
          onDragLeave={() => { setDragOverPort(null); setDropPreview(null); setIconDropAt(null); }}
          onDrop={(e) => {
            e.preventDefault();
            const payload = e.dataTransfer.getData("text/plain");
            setDragOverPort(null);
            setDropPreview(null);
            setIconDropAt(null);
            if (payload === "element:icon") { props.onDropIcon?.(dropPos(e)); return; } // opens the icon picker
            if (payload === "element:text") { props.onCreateText?.(dropPos(e)); return; }
            if (payload === "element:shape") { props.onCreateShape?.(dropPos(e)); return; }
            if (payload === "element:line") { props.onCreateLine?.(dropPos(e)); return; }
            const media = payload as Media;
            if (!(MEDIA as string[]).includes(media)) return;
            const p = portAt(e.clientX, e.clientY);
            if (p) props.onPortMedia?.(p.groupId, p.index, media); // drop onto a port → change its type
            else props.onCreate?.(media, dropPos(e)); // drop on empty space → new group
          }}
        >
          {face.portGroups.map((g) => {
            const laid = layoutPortGroup(g, dims.heightPx);
            const selectedIds = props.selectedGroupIds ?? [];
            const selected = selectedIds.includes(g.id);
            // Chevrons, spacing handle and per-port targets are single-group operations,
            // so they only appear when this is the only selected group.
            const singleSelected = selectedIds.length === 1 && selectedIds[0] === g.id;
            // A single-ROW group sits in a fixed 1RU-tall slot; its (otherwise idle for vertical)
            // spacing handle snaps the row between the top / centre / bottom positions of that slot.
            const singleRow = g.rows === 1;
            const boxTop = laid.top;
            const dragging = drag?.id === g.id;
            const inMulti = isMulti && !!multiDrag && !!drag?.ids.includes(g.id);
            // Live position: multi-move shifts every group by the shared delta; a whole-group drag
            // uses the shared resolver; otherwise everything stays at its committed spot (the
            // single-row vertical snap commits live through the spacing handle).
            const liveX = inMulti
              ? Math.max(SEL_PAD, Math.min(g.gridX + multiDrag!.dx, bounds.width - laid.width - SEL_PAD))
              : (dragging && activeDrag ? activeDrag.liveX : g.gridX);
            const liveOffsetY = inMulti
              ? resolveYOffset(g, (g.yOffset ?? 0) + multiDrag!.dyOffset, bounds, 1)
              : (dragging && activeDrag ? activeDrag.liveOffsetY : (g.yOffset ?? 0));
            const dyVisual = liveOffsetY - (g.yOffset ?? 0);
            const liveBoxTop = boxTop + dyVisual;
            const invalid = dragging && wouldOverlapAt(face, { ...g, yOffset: liveOffsetY }, { x: liveX, y: g.gridY }, bounds);
            // Box geometry. Normal groups: the box wraps the ports + label strips and moves WITH
            // the group. Single-row: a 1RU-tall slot. On a 1RU device the slot fills the device and
            // can't move, so the row snaps between positions WITHIN a fixed box; on 2RU+ the slot is
            // free to move, so the box follows the port (kept centred in the slot) as it's dragged.
            const centeredTop = (dims.heightPx - laid.height) / 2; // port top at yOffset 0
            const slotInset = (RU_PX - laid.height) / 2;           // glyph inset when centred in the slot
            const glyphLocalY = singleRow ? (allowVertical ? slotInset : slotInset + liveOffsetY) : LABEL_H + SEL_PAD;
            const rawLeft = (earX + liveX) - SEL_PAD;
            const rawTop = singleRow ? (allowVertical ? centeredTop + liveOffsetY - slotInset : centeredTop - slotInset) : liveBoxTop - LABEL_H - SEL_PAD;
            const rawW = laid.width + SEL_PAD * 2;
            const rawH = singleRow ? RU_PX : laid.height + LABEL_H * 2 + SEL_PAD * 2;
            const bodyLeft = earX;
            const bodyRight = earX + dims.bodyWidthPx;
            const cL = Math.max(0, bodyLeft - rawLeft);
            const cT = Math.max(0, -rawTop);
            const cR = Math.min(rawW, bodyRight - rawLeft);
            const cB = Math.min(rawH, dims.heightPx - rawTop);
            const cW = Math.max(0, cR - cL);
            const cH = Math.max(0, cB - cT);
            // Controls sit at the box edges (never track the snapping row).
            const ctrlMidY = (cT + cB) / 2;
            // Only the glyph area "grabs" the group; presses on the surrounding padding fall
            // through (no stopPropagation) to the overlay so a marquee can start there.
            const onGlyph = (e: React.PointerEvent | React.MouseEvent) => {
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (box.width <= 0) return true; // unmeasurable (e.g. jsdom) → whole box grabs
              const s = scaleRef.current || 1;
              const lx = (e.clientX - box.left) / s, ly = (e.clientY - box.top) / s;
              return lx >= SEL_PAD && lx <= SEL_PAD + laid.width && ly >= glyphLocalY && ly <= glyphLocalY + laid.height;
            };
            return (
              <div
                key={g.id}
                data-testid={`group-box-${g.id}`}
                data-selected={selected ? "true" : "false"}
                className="group"
                onClick={(e) => { if (!onGlyph(e)) return; e.stopPropagation(); props.onSelect?.(g.id, e.shiftKey); }}
                onPointerDown={(e) => {
                  if (!props.onMove || !onGlyph(e)) return;
                  e.stopPropagation();
                  // The set to act on: this group's multi-selection, or just this group.
                  const selIds = props.selectedGroupIds ?? [];
                  const setIds = selIds.length > 1 && selIds.includes(g.id) ? selIds : [g.id];
                  // Alt+drag → duplicate the set and drag the copies (originals stay put).
                  if (e.altKey && props.onDuplicate) {
                    const newIds = props.onDuplicate(setIds);
                    if (newIds.length) {
                      setDrag({ id: newIds[0], ids: newIds, duplicate: true, startX: e.clientX, startY: e.clientY, origX: g.gridX, origY: g.gridY, origOffset: g.yOffset ?? 0, dx: 0, dy: 0 });
                      return;
                    }
                  }
                  setDrag({ id: g.id, ids: setIds, startX: e.clientX, startY: e.clientY, origX: g.gridX, origY: g.gridY, origOffset: g.yOffset ?? 0, dx: 0, dy: 0 });
                }}
                style={{
                  position: "absolute",
                  // Multi-row box wraps ports + top/bottom label strips; single-row box is a fixed
                  // 1RU slot the ports slide within (see the rawTop/rawH derivation above).
                  left: rawLeft,
                  top: rawTop,
                  width: rawW,
                  height: rawH,
                  cursor: props.onMove ? "move" : "pointer",
                  // Selected group (and its controls) sits above every other group + the faceplate.
                  zIndex: selected ? 20 : 1,
                }}
              >
                <div data-testid={`glyph-bounds-${g.id}`} style={{ position: "absolute", left: SEL_PAD, top: glyphLocalY, width: laid.width, height: laid.height, pointerEvents: "none" }} />
                {invalid && <div data-testid="move-invalid" style={{ display: "none" }} />}
                {selected && (
                  <div
                    data-testid="selection-box"
                    style={{
                      position: "absolute",
                      left: cL, top: cT, width: cW, height: cH,
                      borderRadius: 6,
                      border: invalid ? "1px solid #dc2626" : "1px solid #2d5bff",
                      background: "rgba(45,91,255,0.06)",
                      pointerEvents: "none",
                    }}
                  />
                )}
                {singleSelected && (
                  <>
                    <button
                      type="button"
                      data-testid="chevron-col"
                      className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100"
                      title="Add a column of ports (click, or drag right for more)"
                      onClick={(e) => e.stopPropagation()} // control click must not bubble to the deselect handler
                      onPointerDown={(e) => { e.stopPropagation(); chevNetRef.current = 0; chevMovedRef.current = false; setChevDrag({ id: g.id, axis: "col", start: e.clientX, initial: g.cols }); }}
                      style={chevronStyle({ left: cR - 6, top: ctrlMidY - 6, cursor: "ew-resize" })}
                    ><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6l-6 6" /></svg></button>
                    <button
                      type="button"
                      data-testid="chevron-row"
                      className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100"
                      title="Add a row of ports (click, or drag down for more)"
                      onClick={(e) => e.stopPropagation()} // control click must not bubble to the deselect handler
                      onPointerDown={(e) => { e.stopPropagation(); chevNetRef.current = 0; chevMovedRef.current = false; setChevDrag({ id: g.id, axis: "row", start: e.clientY, initial: g.rows }); }}
                      style={chevronStyle({ left: (cL + cR) / 2 - 6, top: cB - 6, cursor: "ns-resize" })}
                    ><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6l6 -6" /></svg></button>
                    {/* Left up/down handle: snap the vertical port/label position — 6 positions for a
                        single row, 2 for a 2-row group, and all-labels-above/below for 3+ rows. */}
                    {(g.rows === 2 ? props.onRowSnap : props.onVerticalMove) && (
                      <button
                        type="button"
                        data-testid="vert-handle"
                        className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100"
                        title="Drag up/down to move the ports and labels"
                        onClick={(e) => e.stopPropagation()} // control click must not bubble to the deselect handler
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const grabRank = g.rows >= 3 ? rankForLabelSide(laid.cells[0]?.labelPos ?? "bottom")
                            : g.rows === 2 ? rankForTwoRowState(g.rowSpacing)
                            : rankForRowState(g.yOffset ?? 0, laid.cells[0]?.labelPos ?? "top");
                          setVertDrag({ id: g.id, startY: e.clientY, grabRank, grabCol: g.colSpacing, rows: g.rows });
                        }}
                        style={chevronStyle({ left: cL - 6, top: (cT + cB) / 2 - 6, cursor: "ns-resize" })}
                      ><svg width="9" height="9" viewBox="0 0 24 24" fill="#2d5bff"><path d="M12 3l5 7H7z" /><path d="M12 21l5 -7H7z" /></svg></button>
                    )}
                    {/* The spacing handle: horizontal drag spaces columns; on 2RU+ (vertical room)
                        it also spaces rows. Smooth by default, grid-stepped when snap-to-grid is on.
                        Hidden when there's nothing to space (a lone column with no vertical room). */}
                    {props.onSpacing && (g.cols > 1 || (g.rows > 1 && allowVertical)) && (
                      <div
                        data-testid="spacing-handle"
                        className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100"
                        title="Drag to change spacing"
                        onClick={(e) => e.stopPropagation()} // control click must not bubble to the deselect handler
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const { maxCol, maxRow } = maxSpacing(face, g, bounds);
                          setSpaceDrag({ id: g.id, startX: e.clientX, startY: e.clientY, grabCol: g.colSpacing, grabRow: g.rowSpacing, maxCol, maxRow, cols: g.cols, rows: g.rows });
                        }}
                        style={{ position: "absolute", left: cR - 5, top: cB - 5, width: 10, height: 10, borderRadius: "50%", background: "#2d5bff", border: "1.5px solid #fff", cursor: allowVertical && g.rows > 1 ? "nwse-resize" : "ew-resize", zIndex: 7 }}
                      />
                    )}
                  </>
                )}
                {singleSelected && (
                  <>
                    {laid.cells.map((cell) => {
                      // Port click targets, local to the box. localY tracks the glyph's position
                      // within the box (which slides for single-row groups). Port selection is a
                      // recolor only (Faceplate highlight) — no per-port box here.
                      const localX = cell.x - g.gridX + SEL_PAD;
                      const localY = glyphLocalY + (cell.y - laid.top);
                      return (
                        <div
                          key={cell.index}
                          data-testid={`port-target-${cell.index}`}
                          onClick={(e) => { e.stopPropagation(); props.onSelectPort?.(cell.index, e.shiftKey); }}
                          style={{ position: "absolute", left: localX, top: localY, width: CELL_W, height: ROW_H, cursor: "pointer", zIndex: 5 }}
                        />
                      );
                    })}
                  </>
                )}
              </div>
            );
          })}
          {/* Box elements (icon/text/shape) — marquee/shift+click select, drag to move, corner
              handle to resize. Lines are a separate future overlay. */}
          {props.onSelectElement && face.elements.map((el) => {
            if (!isBoxEl(el)) return null;
            const selIds = props.selectedElementIds ?? [];
            const selected = selIds.includes(el.id);
            const onlySelected = selIds.length === 1 && selIds[0] === el.id;
            return (
              <div
                key={el.id}
                data-testid={`icon-el-${el.id}`}
                data-selected={selected ? "true" : "false"}
                onClick={(e) => { e.stopPropagation(); props.onSelectElement?.(el.id, e.shiftKey); }}
                onPointerEnter={() => setHoverElId(el.id)}
                onPointerLeave={() => setHoverElId((cur) => (cur === el.id ? null : cur))}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  // Drag the whole multi-selection together if this icon is part of it, else just this one.
                  const sel = props.selectedElementIds ?? [];
                  const ids = sel.length > 1 && sel.includes(el.id) ? sel : [el.id];
                  const picked = face.elements.filter((x): x is BoxElement => isBoxEl(x) && ids.includes(x.id));
                  let dragIds = picked.map((x) => x.id);
                  if (e.altKey && props.onDuplicateElements) { // Alt/Option+drag → drag fresh copies
                    const newIds = props.onDuplicateElements(dragIds);
                    if (newIds.length !== picked.length) return;
                    dragIds = newIds;
                  }
                  const origs = picked.map((x, i) => ({ id: dragIds[i], gridX: x.gridX, gridY: x.gridY, w: x.w, h: x.h }));
                  setElDrag({ ids: dragIds, mode: "move", startX: e.clientX, startY: e.clientY, origs });
                }}
                style={{ position: "absolute", left: earX + el.gridX, top: el.gridY, width: el.w, height: el.h, cursor: "move", zIndex: 22 }}
              >
                {/* hidden exact-rect hit target for the marquee (mirrors glyph-bounds) */}
                <div data-testid={`el-hit-${el.id}`} style={{ position: "absolute", inset: 0, pointerEvents: "none" }} />
                {selected && (
                  <>
                    <div data-testid="icon-el-box" style={{ position: "absolute", inset: -2, border: "1px solid #2d5bff", borderRadius: 4, background: "rgba(45,91,255,0.06)", pointerEvents: "none" }} />
                    {props.onResizeElements && (onlySelected || hoverElId === el.id) && (
                      <div
                        data-testid="icon-el-resize"
                        title="Drag to resize"
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          // Resize acts on the whole selection (anchored on this icon) if this icon is part of it.
                          const sel = props.selectedElementIds ?? [];
                          const ids = sel.length > 1 && sel.includes(el.id) ? sel : [el.id];
                          const origs = face.elements
                            .filter((x): x is BoxElement => isBoxEl(x) && ids.includes(x.id))
                            .map((x) => ({ id: x.id, gridX: x.gridX, gridY: x.gridY, w: x.w, h: x.h }));
                          setElDrag({ ids, mode: "resize", startX: e.clientX, startY: e.clientY, origs, anchorId: el.id });
                        }}
                        style={{ position: "absolute", right: -6, bottom: -6, width: 11, height: 11, borderRadius: "50%", background: "#2d5bff", border: "1.5px solid #fff", cursor: "nwse-resize", zIndex: 23 }}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
          {/* Line elements: a separate overlay from the box elements above — a line has no
              gridX/gridY/w/h box, just two endpoints, so it gets its own hit-area (a fat
              transparent stroke along the segment) and its own pair of endpoint handles. */}
          {props.onSelectElement && face.elements.map((el) => {
            if (el.kind !== "line") return null;
            const sel = (props.selectedElementIds ?? []).includes(el.id);
            const mkHandle = (which: "a" | "b", x: number, y: number) => (
              <div
                key={which}
                data-testid={`line-handle-${which}-${el.id}`}
                onPointerDown={(e) => {
                  if (e.button !== 0) return;
                  e.stopPropagation();
                  setLineDrag({ kind: "line", id: el.id, mode: which, startX: e.clientX, startY: e.clientY, ox1: el.x1, oy1: el.y1, ox2: el.x2, oy2: el.y2 });
                }}
                style={{ position: "absolute", left: earX + x - 5, top: y - 5, width: 10, height: 10, borderRadius: "50%", background: "#2d5bff", border: "1.5px solid #fff", cursor: "grab", zIndex: 24 }}
              />
            );
            return (
              <div key={el.id} data-testid={`line-el-${el.id}`}>
                {/* invisible fat hit line for click/drag along the segment (also the marquee's hit target) */}
                <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", zIndex: 21 }}>
                  <line
                    data-testid={`el-hit-${el.id}`}
                    x1={earX + el.x1} y1={el.y1} x2={earX + el.x2} y2={el.y2}
                    stroke="transparent" strokeWidth={12} strokeLinecap="round"
                    style={{ pointerEvents: "stroke", cursor: "move" }}
                    onClick={(e) => { e.stopPropagation(); props.onSelectElement?.(el.id, e.shiftKey); }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setLineDrag({ kind: "line", id: el.id, mode: "move", startX: e.clientX, startY: e.clientY, ox1: el.x1, oy1: el.y1, ox2: el.x2, oy2: el.y2 });
                    }}
                  />
                  {sel && <line x1={earX + el.x1} y1={el.y1} x2={earX + el.x2} y2={el.y2} stroke="#2d5bff" strokeWidth={1} pointerEvents="none" />}
                </svg>
                {sel && mkHandle("a", el.x1, el.y1)}
                {sel && mkHandle("b", el.x2, el.y2)}
              </div>
            );
          })}
          {dropPreview && (() => {
            const laid = layoutPortGroup(dropPreview, dims.heightPx);
            const box = clampedBox(dropPreview.gridX, laid.width, laid.top, laid.height);
            return (
              <div
                data-testid="drop-preview"
                style={{
                  position: "absolute",
                  left: box.left, top: box.top, width: box.width, height: box.height,
                  borderRadius: 6,
                  border: "1px solid #2d5bff",
                  background: "rgba(45,91,255,0.06)",
                  opacity: 0.5,
                  pointerEvents: "none",
                  zIndex: 15,
                }}
              />
            );
          })()}
          {iconDropAt && (() => {
            const { gridX, gridY } = resolveIconDrop(iconDropAt.x, iconDropAt.y, ICON_DEFAULT_SIZE, bounds);
            return (
              <div
                data-testid="icon-drop-preview"
                style={{
                  position: "absolute", left: earX + gridX, top: gridY, width: ICON_DEFAULT_SIZE, height: ICON_DEFAULT_SIZE,
                  borderRadius: 4, border: "1px solid #2d5bff", background: "rgba(45,91,255,0.06)", opacity: 0.5, pointerEvents: "none", zIndex: 15,
                }}
              />
            );
          })()}
          {guideDraw && (guideDraw.lines.length > 0 || guideDraw.spacings.length > 0) && (
            <>
              {guideDraw.lines.map((l, i) => l.axis === "x" ? (
                <div key={`gl${i}`} data-testid="align-guide" style={{ position: "absolute", left: earX + l.pos, top: Math.min(l.start, l.end), width: 0, height: Math.abs(l.end - l.start), borderLeft: "1px dashed #2d5bff", pointerEvents: "none", zIndex: 30 }} />
              ) : (
                <div key={`gl${i}`} data-testid="align-guide" style={{ position: "absolute", left: earX + Math.min(l.start, l.end), top: l.pos, width: Math.abs(l.end - l.start), height: 0, borderTop: "1px dashed #2d5bff", pointerEvents: "none", zIndex: 30 }} />
              ))}
              {guideDraw.spacings.map((s, i) => (
                <div key={`gs${i}`} data-testid="spacing-guide">
                  <div style={{ position: "absolute", left: earX + Math.min(s.start, s.end), top: s.y, width: Math.abs(s.end - s.start), height: 0, borderTop: "1px dashed #2d5bff", pointerEvents: "none", zIndex: 30 }} />
                  <div style={{ position: "absolute", left: earX + (s.start + s.end) / 2, top: s.y, transform: "translate(-50%,-140%)", background: "#2d5bff", color: "#fff", fontSize: 9, lineHeight: "12px", padding: "0 4px", borderRadius: 3, pointerEvents: "none", zIndex: 31, whiteSpace: "nowrap" }}>{s.gap}px</div>
                </div>
              ))}
            </>
          )}
          {marquee && (() => {
            const a = clientToDevice(marquee.sx, marquee.sy), b = clientToDevice(marquee.cx, marquee.cy);
            // Clamp to the device body so the marquee never spills into the ears or past the edges.
            const clx = (v: number) => Math.max(0, Math.min(v, bounds.width));
            const cly = (v: number) => Math.max(0, Math.min(v, bounds.height));
            const x1 = clx(a.x), x2 = clx(b.x), y1 = cly(a.y), y2 = cly(b.y);
            return (
              <div data-testid="marquee" style={{ position: "absolute", left: earX + Math.min(x1, x2), top: Math.min(y1, y2), width: Math.abs(x1 - x2), height: Math.abs(y1 - y2), border: "1px solid #2d5bff", background: "rgba(45,91,255,0.06)", pointerEvents: "none", zIndex: 25 }} />
            );
          })()}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A minimal 1×1 group of `media`, used only to size/place the palette drop-preview box. */
function phantomGroup(media: Media): PortGroup {
  return {
    id: "drop-preview", media, connectorType: "", idPrefix: "", countingDirection: "ltr",
    rows: 1, cols: 1, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
  };
}

export function toDevicePos(
  client: { x: number; y: number }, rect: { left: number; top: number }, scale: number, earX: number,
): Pos {
  const s = scale || 1;
  return { x: (client.x - rect.left) / s - earX, y: (client.y - rect.top) / s };
}

function chevronStyle(pos: React.CSSProperties & { translate?: string }): React.CSSProperties {
  return {
    position: "absolute",
    width: 12, height: 12, borderRadius: "50%",
    background: "#fff", border: "1px solid #2d5bff", color: "#2d5bff",
    fontSize: 9, lineHeight: "10px", padding: 0, cursor: "pointer", zIndex: 6,
    display: "flex", alignItems: "center", justifyContent: "center",
    ...pos,
  };
}
