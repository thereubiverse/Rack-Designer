"use client";

import { useRef, useState, useEffect } from "react";
import { Faceplate, type HighlightPort } from "@/features/device-library/faceplate/Faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H, LABEL_H, RAIL_WIDTH_IN, PX_PER_IN } from "@/domain/faceplate-geometry";
import { MEDIA, type Face, type Media } from "@/domain/faceplate";
import { maxSpacing, wouldOverlapAt, SEL_PAD, type Pos } from "./portGroupOps";

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
  onSelectPort?: (index: number, additive: boolean) => void;
  onPortMedia?: (groupId: string, index: number, media: Media) => void;
  onAddColumn?: (id: string) => void;
  onAddRow?: (id: string) => void;
  onRemoveColumn?: (id: string) => void;
  onRemoveRow?: (id: string) => void;
  onMove?: (id: string, pos: Pos) => void;
  onSpacing?: (id: string, spacing: { colSpacing: number; rowSpacing: number }) => void;
}

export function EditorCanvas(props: EditorCanvasProps) {
  const { face, widthIn, rackUnits, rackMounted, side } = props;
  const overlayRef = useRef<HTMLDivElement>(null);
  const editing = Boolean(props.onSelect || props.onCreate);
  const dims = frameDims({ widthIn, rackUnits, rackMounted });
  const earX = dims.earWidthPx;

  const LABEL_GUTTER = 22; // matches Faceplate's FRONT/BACK gutter (side is always set here)
  const svgW = dims.frameWidthPx + LABEL_GUTTER;
  const svgH = dims.heightPx;
  // Scale off a constant reference (the full rack-mounted 19" frame) so toggling
  // Rack Mounted — which shrinks the frame — doesn't change the scale, and the
  // render height stays put instead of shifting vertically.
  const scaleRefW = RAIL_WIDTH_IN * PX_PER_IN + LABEL_GUTTER;
  const outerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);

  useEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      // Reserve the horizontal padding so the padded box never overflows into a scrollbar.
      const avail = el.clientWidth - CANVAS_PAD_X * 2;
      const s = avail > 0 ? Math.min(1, avail / scaleRefW) : 1;
      scaleRef.current = s;
      setScale(s);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [scaleRefW]);

  const [drag, setDrag] = useState<
    { id: string; startX: number; startY: number; origX: number; origY: number; dx: number; dy: number } | null
  >(null);

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
      if (dx !== 0 || dy !== 0) {
        props.onMove?.(drag!.id, { x: drag!.origX + dx, y: drag!.origY });
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
    const g = face.portGroups.find((x) => x.id === drag.id);
    if (!g) return null;
    const laidW = layoutPortGroup(g, dims.heightPx).width;
    const liveMax = Math.max(SEL_PAD, bounds.width - laidW - SEL_PAD);
    const liveX = Math.max(SEL_PAD, Math.min(g.gridX + drag.dx, liveMax));
    return { groupId: g.id, offsetX: liveX - g.gridX };
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
          onClick={() => props.onSelect?.(null, false)}
          onDragOver={(e) => {
            e.preventDefault();
            const p = portAt(e.clientX, e.clientY);
            setDragOverPort((prev) => (prev?.groupId === p?.groupId && prev?.index === p?.index ? prev : p));
          }}
          onDragLeave={() => setDragOverPort(null)}
          onDrop={(e) => {
            e.preventDefault();
            const media = e.dataTransfer.getData("text/plain") as Media;
            setDragOverPort(null);
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
            // Clamp the live-drag x to the body so the box can't be dragged off the device
            // (matches the on-drop clamp, so there's no snap-back either).
            const rawLiveX = dragging ? g.gridX + drag!.dx : g.gridX;
            const liveMax = Math.max(SEL_PAD, bounds.width - laid.width - SEL_PAD);
            const liveX = Math.max(SEL_PAD, Math.min(rawLiveX, liveMax));
            const invalid = dragging && wouldOverlapAt(face, g, { x: liveX, y: g.gridY }, bounds);
            // Raw box wraps ports + labels; the visible blue box is clamped to the device
            // BODY (between the ears) so it never touches or spills into the ears — ports
            // may still spread right up to that edge. Coords are local to the raw box origin.
            const rawLeft = (earX + liveX) - SEL_PAD;
            const rawTop = boxTop - LABEL_H - SEL_PAD;
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
            return (
              <div
                key={g.id}
                data-testid={`group-box-${g.id}`}
                data-selected={selected ? "true" : "false"}
                className="group"
                onClick={(e) => { e.stopPropagation(); props.onSelect?.(g.id, e.shiftKey); }}
                onPointerDown={(e) => {
                  if (!props.onMove) return;
                  e.stopPropagation();
                  setDrag({ id: g.id, startX: e.clientX, startY: e.clientY, origX: g.gridX, origY: g.gridY, dx: 0, dy: 0 });
                }}
                style={{
                  position: "absolute",
                  // The box wraps the whole group INCLUDING the port labels, so it
                  // never cuts through a top/bottom label: extend by LABEL_H each side.
                  left: (earX + liveX) - SEL_PAD,
                  top: boxTop - LABEL_H - SEL_PAD,
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
                      border: invalid ? "1.5px solid #dc2626" : "1.5px solid #2d5bff",
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
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
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
