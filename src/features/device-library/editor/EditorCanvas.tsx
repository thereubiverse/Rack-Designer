"use client";

import { useRef, useState, useEffect } from "react";
import { Faceplate, type HighlightPort } from "@/features/device-library/faceplate/Faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H, LABEL_H } from "@/domain/faceplate-geometry";
import { MEDIA, type Face, type Media } from "@/domain/faceplate";
import { maxSpacing, wouldOverlapAt, type Pos } from "./portGroupOps";

const SEL_PAD = 6; // visual padding so the selection box wraps the number labels

export interface EditorCanvasProps {
  face: Face;
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
  side: "FRONT" | "BACK";
  selectedGroupId?: string | null;
  selectedPortIndex?: number | null;
  highlight?: HighlightPort | null;
  onCreate?: (media: Media, pos: Pos) => void;
  onSelect?: (id: string | null) => void;
  onSelectPort?: (index: number | null) => void;
  onAddColumn?: (id: string) => void;
  onAddRow?: (id: string) => void;
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
  const outerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);

  useEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const avail = el.clientWidth;
      const s = avail > 0 ? Math.min(1, avail / svgW) : 1;
      scaleRef.current = s;
      setScale(s);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [svgW]);

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
    { id: string; axis: "col" | "row"; start: number } | null
  >(null);
  // How many rows/cols this chevron drag has added so far. A ref (not state) so
  // the parent add-callbacks fire from event handlers, never inside a state
  // updater (which would setState-the-parent during render).
  const chevAddedRef = useRef(0);

  useEffect(() => {
    if (!chevDrag) return;
    const d = chevDrag;
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const step = d.axis === "col" ? CELL_W : ROW_H;
      const dist = (d.axis === "col" ? e.clientX - d.start : e.clientY - d.start) / s;
      const want = Math.max(0, Math.floor(dist / step));
      for (let i = chevAddedRef.current; i < want; i++) {
        if (d.axis === "col") props.onAddColumn?.(d.id);
        else props.onAddRow?.(d.id);
      }
      if (want > chevAddedRef.current) chevAddedRef.current = want;
    }
    function onUp() {
      // a plain click (no threshold crossed) still adds one
      if (chevAddedRef.current === 0) {
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
    { id: string; startX: number; startY: number; grabCol: number; grabRow: number; maxCol: number; maxRow: number } | null
  >(null);

  useEffect(() => {
    if (!spaceDrag) return;
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const sd = spaceDrag!;
      const colSpacing = Math.max(0, Math.min(sd.maxCol, sd.grabCol + (e.clientX - sd.startX) / s));
      const rowSpacing = Math.max(0, Math.min(sd.maxRow, sd.grabRow + (e.clientY - sd.startY) / s));
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

  return (
    <div ref={outerRef} data-testid="editor-canvas-fit" style={{ width: "100%" }}>
      <div style={{ width: svgW * scale, height: svgH * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <div data-testid="editor-canvas" style={{ position: "relative", display: "inline-block" }}>
            <Faceplate face={face} widthIn={widthIn} rackUnits={rackUnits} rackMounted={rackMounted} side={side} highlight={props.highlight} />

            {editing && (
        <div
          ref={overlayRef}
          data-testid="editor-overlay"
          style={{ position: "absolute", inset: 0 }}
          onClick={() => props.onSelect?.(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const media = e.dataTransfer.getData("text/plain") as Media;
            if (props.onCreate && (MEDIA as string[]).includes(media)) {
              props.onCreate(media, dropPos(e));
            }
          }}
        >
          {face.portGroups.map((g) => {
            const laid = layoutPortGroup(g, dims.heightPx);
            const selected = g.id === props.selectedGroupId;
            const boxTop = laid.top;
            const dragging = drag?.id === g.id;
            const liveX = dragging ? g.gridX + drag!.dx : g.gridX;
            const invalid = dragging && wouldOverlapAt(face, g, { x: liveX, y: g.gridY }, bounds);
            return (
              <div
                key={g.id}
                data-testid={`group-box-${g.id}`}
                data-selected={selected ? "true" : "false"}
                onClick={(e) => { e.stopPropagation(); props.onSelect?.(g.id); }}
                onPointerDown={(e) => {
                  if (!props.onMove) return;
                  e.stopPropagation();
                  setDrag({ id: g.id, startX: e.clientX, startY: e.clientY, origX: g.gridX, origY: g.gridY, dx: 0, dy: 0 });
                }}
                style={{
                  position: "absolute",
                  left: (earX + liveX) - SEL_PAD,
                  top: boxTop - SEL_PAD,
                  width: laid.width + SEL_PAD * 2,
                  height: laid.height + SEL_PAD * 2,
                  cursor: props.onMove ? "move" : "pointer",
                  borderRadius: 6,
                  border: invalid ? "1.5px solid #dc2626" : selected ? "1.5px solid #2d5bff" : "1.5px solid transparent",
                  background: selected ? "rgba(45,91,255,0.06)" : "transparent",
                }}
              >
                {invalid && <div data-testid="move-invalid" style={{ display: "none" }} />}
                {selected && (
                  <>
                    <button
                      type="button"
                      data-testid="chevron-col"
                      title="Add a column of ports (click, or drag right for more)"
                      onPointerDown={(e) => { e.stopPropagation(); chevAddedRef.current = 0; setChevDrag({ id: g.id, axis: "col", start: e.clientX }); }}
                      style={chevronStyle({ right: -8, top: "50%", translate: "0 -50%" })}
                    >›</button>
                    <button
                      type="button"
                      data-testid="chevron-row"
                      title="Add a row of ports (click, or drag down for more)"
                      onPointerDown={(e) => { e.stopPropagation(); chevAddedRef.current = 0; setChevDrag({ id: g.id, axis: "row", start: e.clientY }); }}
                      style={chevronStyle({ bottom: -8, left: "50%", translate: "-50% 0" })}
                    >⌄</button>
                    {props.onSpacing && (
                      <div
                        data-testid="spacing-handle"
                        title="Drag to change spacing"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const { maxCol, maxRow } = maxSpacing(face, g, bounds);
                          setSpaceDrag({ id: g.id, startX: e.clientX, startY: e.clientY, grabCol: g.colSpacing, grabRow: g.rowSpacing, maxCol, maxRow });
                        }}
                        style={{ position: "absolute", right: -7, bottom: -7, width: 14, height: 14, borderRadius: "50%", background: "#2d5bff", border: "1.5px solid #fff", cursor: "nwse-resize", zIndex: 7 }}
                      />
                    )}
                    {laid.cells.map((cell) => {
                      const localX = cell.x - g.gridX + SEL_PAD;
                      const localY = cell.y - boxTop + SEL_PAD;
                      const isSelPort = cell.index === props.selectedPortIndex;
                      const boxTopY = cell.labelPos === "top" ? localY - LABEL_H : localY;
                      return (
                        <div key={cell.index}>
                          <div
                            data-testid={`port-target-${cell.index}`}
                            onClick={(e) => { e.stopPropagation(); props.onSelectPort?.(cell.index); }}
                            style={{ position: "absolute", left: localX, top: localY, width: CELL_W, height: ROW_H, cursor: "pointer", zIndex: 5 }}
                          />
                          {isSelPort && (
                            <div
                              data-testid="port-select-box"
                              style={{ position: "absolute", left: localX - 2, top: boxTopY - 2, width: CELL_W + 4, height: ROW_H + LABEL_H + 4, outline: "1.5px solid #2d5bff", borderRadius: 4, pointerEvents: "none", zIndex: 6 }}
                            />
                          )}
                        </div>
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
    width: 16, height: 16, borderRadius: "50%",
    background: "#fff", border: "1.5px solid #2d5bff", color: "#2d5bff",
    fontSize: 11, lineHeight: "13px", padding: 0, cursor: "pointer", zIndex: 6,
    ...pos,
  };
}
