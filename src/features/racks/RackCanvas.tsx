"use client";

import { useEffect, useRef, useState } from "react";
import { RackFrame, rackSvgSize, ruTopY, RACK_GUTTER_L, RACK_PAD, RACK_INTERIOR_W, type RackPlacementRender } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";

/** Interactive layer over the pure RackFrame (EditorCanvas pattern): fit-to-width scaling,
 *  free-RU click targets, device selection + grip-handle RU dragging, Delete key. */
export function RackCanvas(props: {
  heightU: number;
  placements: RackPlacementRender[];
  side: "FRONT" | "BACK";
  zoom?: number;                                 // user zoom multiplier (default 1) — final scale = fit × zoom
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddAt: (u: number) => void;
  onMove: (id: string, targetU: number) => void;
  onDelete: (id: string) => void;
}) {
  const { heightU, placements, side, selectedId, zoom = 1 } = props;
  const { width, height } = rackSvgSize(heightU);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const finalScale = scale * zoom;
  const finalScaleRef = useRef(finalScale);
  useEffect(() => { finalScaleRef.current = finalScale; }, [finalScale]);

  // Fit to the host's width (vertical scrolling handles tall racks).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (w > 0) setScale(Math.min(1, w / width));
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [width]);

  // Grip drag: convert vertical pixel movement to RU movement (up = +U).
  const [drag, setDrag] = useState<{ id: string; startY: number; origU: number } | null>(null);
  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const dyRU = Math.round((e.clientY - drag!.startY) / (RU_PX * finalScaleRef.current));
      props.onMove(drag!.id, drag!.origU - dyRU);
    }
    function onUp() { setDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [drag, props]);

  // Delete/Backspace removes the selection (unless typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.tagName === "SELECT" || t?.isContentEditable) return;
      if (selectedId) { e.preventDefault(); props.onDelete(selectedId); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, props]);

  const occupied = new Set<number>();
  for (const p of placements) for (let u = p.startU; u < p.startU + p.template.rackUnits; u++) occupied.add(u);
  const ix = RACK_GUTTER_L + RACK_PAD;

  return (
    <div ref={hostRef} className="w-full" style={{ width: width * zoom, height: height * zoom }}>
      <div data-testid="rack-canvas-scale" className="relative origin-top-left" style={{ transform: `scale(${finalScale})`, width, height }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} onClick={() => props.onSelect(null)}>
          <RackFrame heightU={heightU} placements={placements} side={side} />
        </svg>
        {/* free-RU click strips */}
        {Array.from({ length: heightU }, (_, i) => i + 1).filter((u) => !occupied.has(u)).map((u) => (
          <div key={u} data-testid={`ru-hit-${u}`} title={`Add device at U${u}`}
            onClick={(e) => { e.stopPropagation(); props.onAddAt(u); }}
            className="absolute cursor-pointer rounded hover:bg-blue-50/60"
            style={{ left: ix, top: ruTopY(u, 1, heightU), width: RACK_INTERIOR_W, height: RU_PX }} />
        ))}
        {/* device hit boxes */}
        {placements.map((p) => {
          const top = ruTopY(p.startU, p.template.rackUnits, heightU);
          const h = p.template.rackUnits * RU_PX;
          const selected = p.id === selectedId;
          return (
            <div key={p.id} data-testid={`rack-dev-${p.id}`}
              onClick={(e) => { e.stopPropagation(); props.onSelect(p.id); }}
              className={`absolute ${selected ? "z-10" : ""}`}
              style={{ left: ix, top, width: RACK_INTERIOR_W, height: h, cursor: "pointer" }}>
              {selected && (
                <>
                  <div className="pointer-events-none absolute -inset-0.5 rounded border-2 border-blue-500" />
                  <div data-testid={`rack-grip-${p.id}`} title="Drag to move"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setDrag({ id: p.id, startY: e.clientY, origU: p.startU });
                    }}
                    className="absolute -right-1 top-1/2 flex h-8 w-4 -translate-y-1/2 cursor-grab items-center justify-center rounded bg-blue-600 text-white">
                    <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
