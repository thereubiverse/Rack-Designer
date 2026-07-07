"use client";

import { useRef, useState, useEffect } from "react";
import { Faceplate, type HighlightPort } from "@/features/device-library/faceplate/Faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H, LABEL_H, RAIL_WIDTH_IN, PX_PER_IN, GRID_PX } from "@/domain/faceplate-geometry";
import { MEDIA, type Face, type Media, type PortGroup } from "@/domain/faceplate";
import { maxSpacing, wouldOverlapAt, resolveYOffset, findFreePosition, SEL_PAD, type Pos } from "./portGroupOps";
import { computeGuides, guidesForMovingRect, rectOf, type GuideLine, type SpacingGuide, type Rect } from "./alignmentGuides";

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
  onSelect?: (id: string | null, additive: boolean) => void;
  onMarqueeSelect?: (ids: string[], additive: boolean) => void;
  onSelectPort?: (index: number, additive: boolean) => void;
  onPortMedia?: (groupId: string, index: number, media: Media) => void;
  onAddColumn?: (id: string) => void;
  onAddRow?: (id: string) => void;
  onRemoveColumn?: (id: string) => void;
  onRemoveRow?: (id: string) => void;
  onMove?: (id: string, target: { x: number; yOffset: number }) => void;
  onMoveGroups?: (ids: string[], delta: { dx: number; dyOffset: number }) => void;
  /** Alt+drag: duplicate `ids`, select the copies, and return their new ids to drag. */
  onDuplicate?: (ids: string[]) => string[];
  /** End of an Alt+drag: place the copies at `delta`, or discard them (delta null / rejected). */
  onDuplicateDrop?: (newIds: string[], delta: { dx: number; dyOffset: number } | null) => void;
  onSpacing?: (id: string, spacing: { colSpacing: number; rowSpacing: number }) => void;
  snapToGrid?: boolean;
  /** Media of the palette chip currently being dragged (for the drop-preview box). */
  paletteDragMedia?: Media | null;
}

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
  const allowVertical = rackUnits >= 2;
  const snapX = (x: number) => (snapStep > 1 ? Math.round(x / snapStep) * snapStep : x);

  function clientToDevice(clientX: number, clientY: number): Pos {
    const rect = overlayRef.current?.getBoundingClientRect();
    return toDevicePos({ x: clientX, y: clientY }, { left: rect?.left ?? 0, top: rect?.top ?? 0 }, scaleRef.current, earX);
  }
  // Select every group whose VISIBLE PORTS the marquee overlaps. The group box on screen is
  // the padded selection box (SEL_PAD all round + LABEL_H label strips top/bottom), so the
  // glyphs sit inset from its edges — hit-testing the raw box made the marquee grab a group
  // well before it touched the ports the user sees. Inset the box's real on-screen rect back
  // to the glyph bounds (× scale, since the rect is in scaled client px) so the hit test still
  // can't drift from what's drawn. Unmeasurable rects (e.g. jsdom) fall back to the raw box.
  function marqueeSelect(sx: number, sy: number, ex: number, ey: number, additive: boolean) {
    const ml = Math.min(sx, ex), mr = Math.max(sx, ex), mt = Math.min(sy, ey), mb = Math.max(sy, ey);
    const s = scaleRef.current || 1;
    const padX = SEL_PAD * s, padY = (LABEL_H + SEL_PAD) * s;
    const ids: string[] = [];
    overlayRef.current?.querySelectorAll('[data-testid^="group-box-"]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const id = (el.getAttribute("data-testid") || "").replace("group-box-", "");
      if (r.width <= 0 || r.height <= 0) { ids.push(id); return; } // unmeasurable (jsdom) → include
      const gl = r.left + padX, gr = r.right - padX, gt = r.top + padY, gb = r.bottom - padY;
      if (gl < mr && gr > ml && gt < mb && gb > mt) ids.push(id);
    });
    props.onMarqueeSelect?.(ids, additive);
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
    const liveOffsetY = allowVertical ? resolveYOffset(g, yOff, bounds, guideY ? 1 : snapStep) : (g.yOffset ?? 0);
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
  const guideData = isMulti ? multiDrag : activeDrag; // which drag's guides to draw

  // The clamped-to-body selection box for a group, in overlay-local coords. Shared by the
  // live selection box and the palette drop-preview so they line up exactly.
  function clampedBox(gridX: number, laidWidth: number, laidTop: number, laidHeight: number) {
    const rawLeft = earX + gridX - SEL_PAD;
    const rawTop = laidTop - LABEL_H - SEL_PAD;
    const rawW = laidWidth + SEL_PAD * 2;
    const rawH = laidHeight + LABEL_H * 2 + SEL_PAD * 2;
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
      // Map cursor movement so the handle tracks the cursor: each unit of column
      // spacing widens the box by (cols-1); each unit of row spacing grows it from
      // the center, so the bottom edge moves at (rows-1)/2.
      const colDen = Math.max(1, sd.cols - 1);
      const rowDen = Math.max(1, sd.rows - 1);
      const colSpacing = Math.max(0, Math.min(sd.maxCol, sd.grabCol + (e.clientX - sd.startX) / (s * colDen)));
      const rowSpacing = Math.max(0, Math.min(sd.maxRow, sd.grabRow + (2 * (e.clientY - sd.startY)) / (s * rowDen)));
      props.onSpacing?.(sd.id, { colSpacing, rowSpacing });
    }
    function onUp() { setSpaceDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [spaceDrag, props]);

  function dropPos(e: React.DragEvent): Pos {
    const rect = overlayRef.current?.getBoundingClientRect();
    return toDevicePos({ x: e.clientX, y: e.clientY }, { left: rect?.left ?? 0, top: rect?.top ?? 0 }, scaleRef.current, earX);
  }

  // Which existing port sits under the cursor (for drag-a-type-onto-a-port).
  const [dragOverPort, setDragOverPort] = useState<{ groupId: string; index: number } | null>(null);
  // Where a new group would land if the palette chip is dropped on empty space (drop preview).
  const [dropPreview, setDropPreview] = useState<PortGroup | null>(null);
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
          onDragLeave={() => { setDragOverPort(null); setDropPreview(null); }}
          onDrop={(e) => {
            e.preventDefault();
            const media = e.dataTransfer.getData("text/plain") as Media;
            setDragOverPort(null);
            setDropPreview(null);
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
            const boxTop = laid.top;
            const dragging = drag?.id === g.id;
            const inMulti = isMulti && !!multiDrag && !!drag?.ids.includes(g.id);
            // Live position: multi-move shifts every group in the set by the shared delta;
            // otherwise the single dragged group uses the shared resolver; others stay put.
            const liveX = inMulti
              ? Math.max(SEL_PAD, Math.min(g.gridX + multiDrag!.dx, bounds.width - laid.width - SEL_PAD))
              : (dragging && activeDrag ? activeDrag.liveX : g.gridX);
            const liveOffsetY = inMulti
              ? resolveYOffset(g, (g.yOffset ?? 0) + multiDrag!.dyOffset, bounds, 1)
              : (dragging && activeDrag ? activeDrag.liveOffsetY : (g.yOffset ?? 0));
            const dyVisual = liveOffsetY - (g.yOffset ?? 0);
            const liveBoxTop = boxTop + dyVisual;
            const invalid = dragging && wouldOverlapAt(face, { ...g, yOffset: liveOffsetY }, { x: liveX, y: g.gridY }, bounds);
            // Raw box wraps ports + labels; the visible blue box is clamped to the device
            // BODY (between the ears) so it never touches or spills into the ears — ports
            // may still spread right up to that edge. Coords are local to the raw box origin.
            const rawLeft = (earX + liveX) - SEL_PAD;
            const rawTop = liveBoxTop - LABEL_H - SEL_PAD;
            const rawW = laid.width + SEL_PAD * 2;
            const rawH = laid.height + LABEL_H * 2 + SEL_PAD * 2;
            const bodyLeft = earX;
            const bodyRight = earX + dims.bodyWidthPx;
            const cL = Math.max(0, bodyLeft - rawLeft);
            const cT = Math.max(0, -rawTop);
            const cR = Math.min(rawW, bodyRight - rawLeft);
            const cB = Math.min(rawH, dims.heightPx - rawTop);
            const cW = Math.max(0, cR - cL);
            const cH = Math.max(0, cB - cT);
            // Only the glyph area "grabs" the group; presses on the surrounding padding fall
            // through (no stopPropagation) to the overlay so a marquee can start there.
            const onGlyph = (e: React.PointerEvent | React.MouseEvent) => {
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              if (box.width <= 0) return true; // unmeasurable (e.g. jsdom) → whole box grabs
              const s = scaleRef.current || 1;
              const lx = (e.clientX - box.left) / s, ly = (e.clientY - box.top) / s;
              return lx >= SEL_PAD && lx <= SEL_PAD + laid.width && ly >= LABEL_H + SEL_PAD && ly <= LABEL_H + SEL_PAD + laid.height;
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
                  // The box wraps the whole group INCLUDING the port labels, so it
                  // never cuts through a top/bottom label: extend by LABEL_H each side.
                  left: (earX + liveX) - SEL_PAD,
                  top: liveBoxTop - LABEL_H - SEL_PAD,
                  width: laid.width + SEL_PAD * 2,
                  height: laid.height + LABEL_H * 2 + SEL_PAD * 2,
                  cursor: props.onMove ? "move" : "pointer",
                  // Selected group (and its controls) sits above every other group + the faceplate.
                  zIndex: selected ? 20 : 1,
                }}
              >
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
                      onPointerDown={(e) => { e.stopPropagation(); chevNetRef.current = 0; chevMovedRef.current = false; setChevDrag({ id: g.id, axis: "col", start: e.clientX, initial: g.cols }); }}
                      style={chevronStyle({ left: cR - 6, top: (cT + cB) / 2 - 6, cursor: "ew-resize" })}
                    ><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6l-6 6" /></svg></button>
                    <button
                      type="button"
                      data-testid="chevron-row"
                      className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100"
                      title="Add a row of ports (click, or drag down for more)"
                      onPointerDown={(e) => { e.stopPropagation(); chevNetRef.current = 0; chevMovedRef.current = false; setChevDrag({ id: g.id, axis: "row", start: e.clientY, initial: g.rows }); }}
                      style={chevronStyle({ left: (cL + cR) / 2 - 6, top: cB - 6, cursor: "ns-resize" })}
                    ><svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6l6 -6" /></svg></button>
                    {props.onSpacing && (
                      <div
                        data-testid="spacing-handle"
                        className="pointer-events-none opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100"
                        title="Drag to change spacing"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const { maxCol, maxRow } = maxSpacing(face, g, bounds);
                          setSpaceDrag({ id: g.id, startX: e.clientX, startY: e.clientY, grabCol: g.colSpacing, grabRow: g.rowSpacing, maxCol, maxRow, cols: g.cols, rows: g.rows });
                        }}
                        style={{ position: "absolute", left: cR - 5, top: cB - 5, width: 10, height: 10, borderRadius: "50%", background: "#2d5bff", border: "1.5px solid #fff", cursor: "nwse-resize", zIndex: 7 }}
                      />
                    )}
                  </>
                )}
                {singleSelected && (
                  <>
                    {laid.cells.map((cell) => {
                      // localY offset by +LABEL_H because the box top now sits LABEL_H
                      // above the glyph stack (to wrap the labels). Port selection is a
                      // recolor only (Faceplate highlight) — no per-port box here.
                      const localX = cell.x - g.gridX + SEL_PAD;
                      const localY = cell.y - boxTop + LABEL_H + SEL_PAD;
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
          {guideData && (guideData.lines.length > 0 || guideData.spacings.length > 0) && (
            <>
              {guideData.lines.map((l, i) => l.axis === "x" ? (
                <div key={`gl${i}`} data-testid="align-guide" style={{ position: "absolute", left: earX + l.pos, top: Math.min(l.start, l.end), width: 0, height: Math.abs(l.end - l.start), borderLeft: "1px dashed #2d5bff", pointerEvents: "none", zIndex: 30 }} />
              ) : (
                <div key={`gl${i}`} data-testid="align-guide" style={{ position: "absolute", left: earX + Math.min(l.start, l.end), top: l.pos, width: Math.abs(l.end - l.start), height: 0, borderTop: "1px dashed #2d5bff", pointerEvents: "none", zIndex: 30 }} />
              ))}
              {guideData.spacings.map((s, i) => (
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
