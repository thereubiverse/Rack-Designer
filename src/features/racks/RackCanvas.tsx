"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { RackFrame, rackSvgSize, ruTopY, RACK_GUTTER_L, RACK_PAD, RACK_INTERIOR_W, type RackPlacementRender } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { fitScale, clampPan, type FitMode } from "./rackOps";
import { PatchLayer } from "./PatchLayer";
import type { Connection, PortRef } from "./connectionOps";

// Smoothly-animated fit/zoom transition on the single translate+scale transform, so a Fit toggle
// or button zoom eases from wherever the rack is now to the target.
const ZOOM_TRANSITION = "transform 340ms cubic-bezier(0.2, 0, 0, 1)";
const FIT_MARGIN = 16;      // gap kept around the rack when fitted
// Zoom limits are ABSOLUTE scale (not relative to the fit), so the reachable zoom range is the
// same no matter what the rack is fitted to.
const MIN_SCALE = 0.05;
const MAX_SCALE = 3;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export type RackCanvasHandle = { zoomBy: (factor: number) => void };

/** Interactive layer over the pure RackFrame (EditorCanvas pattern). The viewport is a fixed box
 *  with overflow hidden; the rack lives in a single translate+scale transform. That makes pinch-
 *  zoom and two-finger pan work in BOTH axes at any zoom/fit, with a consistent absolute zoom
 *  range, while the Fit toggle animates the transform from the current state to the fitted one.
 *  Also: free-RU add targets, device selection + grip-handle RU dragging, Delete key. */
export const RackCanvas = forwardRef<RackCanvasHandle, {
  heightU: number;
  placements: RackPlacementRender[];
  side: "FRONT" | "BACK";
  fitMode?: FitMode;                             // "width" fills the viewport width; "height" fits the whole rack
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddAt: (u: number) => void;
  onMove: (id: string, targetU: number) => void;
  onDelete: (id: string) => void;
  connections: Connection[];
  selectedConnectionId: string | null;
  onPatch: (a: PortRef, b: PortRef) => void;
  onSelectConnection: (id: string | null) => void;
  onDisconnect: (id: string) => void;
}>(function RackCanvas(props, ref) {
  const { heightU, placements, side, selectedId, fitMode = "height" } = props;
  const { width, height } = rackSvgSize(heightU);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1); // ABSOLUTE display scale
  const [pan, setPan] = useState({ x: 0, y: 0 });

  // scaleRef/panRef are the authoritative current values — updated synchronously at every mutation
  // so rapid successive gestures (e.g. clicking + several times in a frame) accumulate correctly,
  // instead of all reading a stale value that only syncs after React commits.
  const scaleRef = useRef(scale);
  const panRef = useRef(pan);
  const setScaleNow = (s: number) => { scaleRef.current = s; setScale(s); };
  const setPanNow = (p: { x: number; y: number }) => { panRef.current = p; setPan(p); };

  const enableTransition = () => { if (contentRef.current) contentRef.current.style.transition = ZOOM_TRANSITION; };

  // Zoom about a point (viewport coords), clamped to the absolute range, keeping that point fixed.
  const zoomAround = useCallback((factor: number, px: number, py: number, animate: boolean) => {
    const cur = scaleRef.current;
    const next = clampScale(cur * factor);
    if (next === cur) return;
    if (animate) enableTransition();
    const host = hostRef.current;
    const vw = host?.clientWidth ?? 0, vh = host?.clientHeight ?? 0;
    const ratio = next / cur;
    const p = panRef.current;
    setScaleNow(next);
    setPanNow(clampPan(px - (px - p.x) * ratio, py - (py - p.y) * ratio, vw, vh, width * next, height * next));
  }, [width, height]);

  // Toolbar +/- zoom about the viewport centre (animated).
  const zoomBy = useCallback((factor: number) => {
    const host = hostRef.current;
    zoomAround(factor, (host?.clientWidth ?? 0) / 2, (host?.clientHeight ?? 0) / 2, true);
  }, [zoomAround]);
  useImperativeHandle(ref, () => ({ zoomBy }), [zoomBy]);

  // Fit (PatchDocs "fit" toggle): "width" fills the viewport width; "height" fits the whole rack.
  // Recompute the scale + re-centre the pan whenever the mode flips or the viewport resizes. The
  // transform transition is (re)enabled here so the flip animates.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    enableTransition();
    const fit = () => {
      const vw = host.clientWidth, vh = host.clientHeight;
      if (vw <= 0 || vh <= 0) return;
      const s = clampScale(fitScale(fitMode, vw, vh, width, height, FIT_MARGIN));
      setScaleNow(s);
      // Centre horizontally; fit-height centres vertically too, fit-width top-aligns (show the top).
      setPanNow({ x: (vw - width * s) / 2, y: fitMode === "width" ? FIT_MARGIN : (vh - height * s) / 2 });
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [width, height, fitMode]);

  // Wheel: ctrl+wheel = pinch-zoom (about the cursor); plain wheel = two-finger pan (both axes).
  // Both work at any fit/zoom. Native non-passive listener so preventDefault stops browser zoom /
  // page scroll. Transitions are dropped during the gesture (immediate follow) and restored after.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let restore: ReturnType<typeof setTimeout> | undefined;
    const suspendTransition = () => {
      if (contentRef.current) contentRef.current.style.transition = "none";
      clearTimeout(restore);
      restore = setTimeout(enableTransition, 140);
    };
    function onWheel(e: WheelEvent) {
      const host = hostRef.current;
      if (!host) return;
      e.preventDefault();
      suspendTransition();
      if (e.ctrlKey) {
        // Pinch-zoom about the cursor.
        const rect = host.getBoundingClientRect();
        zoomAround(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top, false);
      } else {
        // Two-finger pan — free movement in both axes, clamped so the rack stays reachable.
        const p = panRef.current, fs = scaleRef.current;
        setPanNow(clampPan(p.x - e.deltaX, p.y - e.deltaY, host.clientWidth, host.clientHeight, width * fs, height * fs));
      }
    }
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => { host.removeEventListener("wheel", onWheel); clearTimeout(restore); };
  }, [zoomAround, width, height]);

  const ix = RACK_GUTTER_L + RACK_PAD;

  // Grip drag — imperative for smoothness: while dragging we update the DOM DIRECTLY (the dragged
  // faceplate's transform, its overlay box, and the ghost slot) inside the pointermove handler, with
  // NO React re-render per frame, so the device tracks the pointer 1:1 with zero render latency.
  // React state changes only on start/end; the move is committed once (snapped to a free RU) on release.
  const [dragId, setDragId] = useState<string | null>(null);
  const dragRef = useRef<{ id: string; startY: number; origU: number; ru: number; ghostU: number } | null>(null);
  useEffect(() => {
    if (!dragId) return;
    const content = contentRef.current;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !content) return;
      const scl = scaleRef.current;
      const origTop = ruTopY(d.origU, d.ru, heightU);
      const minTop = ruTopY(heightU - d.ru + 1, d.ru, heightU); // device pinned at the very top
      const maxTop = ruTopY(1, d.ru, heightU);                  // device pinned at the very bottom
      const top = Math.max(minTop, Math.min(maxTop, origTop + (e.clientY - d.startY) / scl));
      d.ghostU = Math.min(heightU - d.ru + 1, Math.max(1, d.origU - Math.round((e.clientY - d.startY) / (RU_PX * scl))));
      content.querySelector(`[data-testid="rack-device-${d.id}"]`)?.setAttribute("transform", `translate(${ix}, ${top})`);
      const box = content.querySelector<HTMLElement>(`[data-testid="rack-dev-${d.id}"]`);
      if (box) box.style.transform = `translateY(${top - origTop}px)`;
      content.querySelector('[data-testid="rack-ghost"]')?.setAttribute("y", String(ruTopY(d.ghostU, d.ru, heightU)));
    };
    const onUp = () => {
      const d = dragRef.current;
      if (d && content) {
        const box = content.querySelector<HTMLElement>(`[data-testid="rack-dev-${d.id}"]`);
        if (box) box.style.transform = ""; // the re-render places the box at the committed RU
        // Reset the faceplate's imperatively-set transform back to a SNAPPED RU. When the commit
        // lands on a new RU, React re-renders and overrides this. When it lands on the SAME RU
        // (small drag, or resolveMove clamped back to origin), startU is unchanged so React never
        // re-renders this device — and without this reset the faceplate would stay frozen at the
        // loose pointer position while the selection box snapped correctly.
        content.querySelector(`[data-testid="rack-device-${d.id}"]`)
          ?.setAttribute("transform", `translate(${ix}, ${ruTopY(d.origU, d.ru, heightU)})`);
        props.onMove(d.id, d.ghostU);       // resolveMove clamps to a valid slot; one commit
      }
      dragRef.current = null;
      setDragId(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [dragId, props, heightU, ix]);

  // Delete/Backspace removes the selection (unless typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.tagName === "SELECT" || t?.isContentEditable) return;
      if (props.selectedConnectionId) { e.preventDefault(); props.onDisconnect(props.selectedConnectionId); return; }
      if (selectedId) { e.preventDefault(); props.onDelete(selectedId); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, props, props.selectedConnectionId]);

  // Hovering an unpatched port highlights its glyph + label blue (via the faceplate's highlight prop).
  const [hoveredPort, setHoveredPort] = useState<import("./connectionOps").PortRef | null>(null);
  const faceSide = side === "FRONT" ? "front" : "back";
  const highlightPort = hoveredPort && hoveredPort.side === faceSide
    ? { groupId: hoveredPort.groupId, portIndex: hoveredPort.portIndex } : null;

  const occupied = new Set<number>();
  for (const p of placements) for (let u = p.startU; u < p.startU + p.template.rackUnits; u++) occupied.add(u);

  return (
    // Fixed viewport (fills its parent's h/w), overflow hidden — panning is done via the transform,
    // so scroll/zoom gestures are never gated on content overflowing an axis.
    <div ref={hostRef} className="relative h-full w-full overflow-hidden">
      <div ref={contentRef} data-testid="rack-canvas-scale" className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, width, height, transition: ZOOM_TRANSITION }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          onClick={() => { props.onSelect(null); props.onSelectConnection(null); }}>
          <RackFrame heightU={heightU} placements={placements} side={side} dragId={dragId} highlight={highlightPort} />
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
          // Base RU position; during a grip-drag the box is offset imperatively (see the drag effect).
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
                      dragRef.current = { id: p.id, startY: e.clientY, origU: p.startU, ru: p.template.rackUnits, ghostU: p.startU };
                      setDragId(p.id);
                    }}
                    className="absolute -right-1 top-1/2 flex h-8 w-4 -translate-y-1/2 cursor-grab items-center justify-center rounded bg-blue-600 text-white">
                    <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg>
                  </div>
                </>
              )}
            </div>
          );
        })}
        {/* Overlay svg painted ABOVE the device hit-box divs so port dots and cables are hit-testable
           by the real pointer (elementFromPoint). pointerEvents:none lets clicks over empty faceplate
           area fall through to the device divs / free-RU strips / base svg beneath it; only the
           interactive PatchLayer elements (port dots, cables) opt back in via their own pointerEvents. */}
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} overflow="visible"
          style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }}>
          <PatchLayer placements={placements} heightU={heightU} side={side}
            connections={props.connections} selectedConnectionId={props.selectedConnectionId}
            onPatch={props.onPatch} onSelectConnection={props.onSelectConnection}
            onHoverPort={setHoveredPort} />
        </svg>
      </div>
    </div>
  );
});
