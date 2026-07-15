"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { RackFrame, rackSvgSize, ruTopY, RACK_GUTTER_L, RACK_PAD, RACK_INTERIOR_W, RK_SELECT, RK_GRIP, type RackPlacementRender } from "./RackFrame";
import { RU_PX, frameDims } from "@/domain/faceplate-geometry";
import { fitScale, clampPan, type FitMode } from "./rackOps";
import { PatchLayer } from "./PatchLayer";
import { samePort, portConnection, isConnected, portsOf, type Connection, type PortRef } from "./connectionOps";
import { CORNER_R, type HighlightPort } from "@/features/device-library/faceplate/Faceplate";

// Exact PatchDocs colours (their --color-primary-blue / highlighted amber).
const BLUE = "#1a55d8";
const AMBER = "#fdc700";

// Smoothly-animated fit/zoom transition on the single translate+scale transform, so a Fit toggle
// or button zoom eases from wherever the rack is now to the target.
const ZOOM_TRANSITION = "transform 340ms cubic-bezier(0.2, 0, 0, 1)";
const FIT_MARGIN = 16;      // gap kept around the rack when fitted
// Zoom limits are ABSOLUTE scale (not relative to the fit), so the reachable zoom range is the
// same no matter what the rack is fitted to.
const MIN_SCALE = 0.05;
const MAX_SCALE = 3;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
/** How far the selection box sits outside the device it wraps. */
const SELECT_OUTSET = 2;
/** Grip handle width — must stay in step with its `w-4` class (used to centre it on the ear). */
const GRIP_W = 16;

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
  onReplace: (existingConnIds: string[], a: PortRef, b: PortRef) => void;
  onSelectConnection: (id: string | null) => void;
  onDisconnect: (id: string) => void;
  portLabel: (p: PortRef) => string;
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
  const [hoverU, setHoverU] = useState<number | null>(null);
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

  // Port hover (any port) + cable hover feed the amber/blue highlight model:
  //  - a patched port + its cable are BLUE by default, AMBER when that run is hovered or selected;
  //  - an unpatched port turns BLUE on hover.
  const [hoveredPort, setHoveredPort] = useState<PortRef | null>(null);
  const [hoveredCable, setHoveredCable] = useState<string | null>(null);
  const [selectedPort, setSelectedPort] = useState<PortRef | null>(null); // patched port picked by 1st click
  const [pinShown, setPinShown] = useState(false);                        // 2nd click on it → disconnect pin
  const [pendingSource, setPendingSource] = useState<PortRef | null>(null); // unpatched port picked to connect FROM
  const [replacePrompt, setReplacePrompt] = useState<{ existing: Connection[]; source: PortRef; target: PortRef } | null>(null);
  const faceSide = side === "FRONT" ? "front" : "back";
  const conns = props.connections;

  // Drag-drop / click completing a connection onto `to`. If `to` is already patched, raise the
  // replace prompt instead of patching (the parent re-validates and rejects duplicates anyway).
  const attemptConnect = (from: PortRef, to: PortRef) => {
    if (samePort(from, to)) return;
    const onFrom = portConnection(conns, from), onTo = portConnection(conns, to);
    // Already patched to each other — the user just re-drew the cable they already have.
    if (onFrom && onTo && onFrom.id === onTo.id) return;
    // EITHER end being patched means the same thing: the user is moving a cable. Offer to replace
    // rather than refusing — and take BOTH out when both ends are busy, or the survivor would leave
    // its port double-booked and the server would reject the save.
    const existing = [onFrom, onTo].filter((c): c is Connection => !!c)
      .filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i);
    if (existing.length > 0) { setReplacePrompt({ existing, source: from, target: to }); return; }
    props.onPatch(from, to);
  };
  // The click state machine: a patched port selects on the 1st click and shows its disconnect pin on
  // the 2nd; an unpatched port becomes the pending connection source (candidate ports then flash),
  // and a 2nd click on another port completes (or, if that port is patched, prompts to replace).
  const handlePortClick = (port: PortRef) => {
    if (pendingSource) {
      if (samePort(pendingSource, port)) { setPendingSource(null); return; } // click source again → cancel
      attemptConnect(pendingSource, port);
      setPendingSource(null);
      return;
    }
    const conn = portConnection(conns, port);
    if (conn) {
      if (selectedPort && samePort(selectedPort, port)) setPinShown(true);
      else { props.onSelectConnection(conn.id); setSelectedPort(port); setPinShown(false); }
    } else {
      setPendingSource(port);
      setSelectedPort(null); setPinShown(false); props.onSelectConnection(null);
    }
  };

  // Escape cancels whatever is in flight (replace prompt → pending pick → disconnect pin).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (replacePrompt) { setReplacePrompt(null); setPendingSource(null); }
      else if (pendingSource) setPendingSource(null);
      else if (pinShown) setPinShown(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replacePrompt, pendingSource, pinShown]);

  // A connection's "run" is active (amber) when it is selected, hovered directly, or one of its
  // ports is the hovered port.
  const activeConnIds = new Set<string>();
  for (const c of conns) {
    if (c.id === props.selectedConnectionId || c.id === hoveredCable
      || (hoveredPort && (samePort(c.a, hoveredPort) || samePort(c.b, hoveredPort)))) {
      activeConnIds.add(c.id);
    }
  }

  // Faceplate port colours: connected ports blue (amber when their run is active); a hovered
  // unpatched port blue. Ports off the current face are ignored (matched per-device by groupId).
  const portHighlights: HighlightPort[] = [];
  const seenHl = new Set<string>();
  const addHl = (p: PortRef, extra: { color?: string; flash?: boolean }) => {
    if (p.side !== faceSide) return;
    const k = `${p.groupId}:${p.portIndex}`;
    if (seenHl.has(k)) return;
    seenHl.add(k);
    portHighlights.push({ groupId: p.groupId, portIndex: p.portIndex, ...extra });
  };
  for (const c of conns) {
    const color = activeConnIds.has(c.id) ? AMBER : BLUE;
    addHl(c.a, { color });
    addHl(c.b, { color });
  }
  if (pendingSource) {
    // Connection in progress: the picked source is solid blue and every UNPATCHED port on the face
    // flashes to show it's a connectable target.
    addHl(pendingSource, { color: BLUE });
    for (const p of placements) {
      const face = faceSide === "front" ? p.template.frontFace : p.template.backFace;
      for (const port of portsOf(face, p.id, faceSide)) {
        if (!isConnected(conns, port)) addHl(port, { flash: true });
      }
    }
  } else if (hoveredPort && !conns.some((c) => samePort(c.a, hoveredPort) || samePort(c.b, hoveredPort))) {
    addHl(hoveredPort, { color: BLUE });
  }

  const occupied = new Set<number>();
  for (const p of placements) for (let u = p.startU; u < p.startU + p.template.rackUnits; u++) occupied.add(u);

  return (
    // Fixed viewport (fills its parent's h/w), overflow hidden — panning is done via the transform,
    // so scroll/zoom gestures are never gated on content overflowing an axis.
    // no-select-ui: the rack is a diagram, so dragging a patch across it must never start a text
    // selection over the device labels and port numbers.
    <div ref={hostRef} className="no-select-ui relative h-full w-full overflow-hidden">
      <div ref={contentRef} data-testid="rack-canvas-scale" className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, width, height, transition: ZOOM_TRANSITION }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}
          onClick={() => { props.onSelect(null); props.onSelectConnection(null); setSelectedPort(null); setPinShown(false); setPendingSource(null); }}>
          <RackFrame heightU={heightU} placements={placements} side={side} dragId={dragId}
            highlight={portHighlights} selectedId={selectedId} hoverU={hoverU} />
        </svg>
        {/* free-RU click strips — hovering one also lights that RU's rails (see RackFrame) */}
        {Array.from({ length: heightU }, (_, i) => i + 1).filter((u) => !occupied.has(u)).map((u) => (
          <div key={u} data-testid={`ru-hit-${u}`} title={`Add device at U${u}`}
            onClick={(e) => { e.stopPropagation(); props.onAddAt(u); }}
            onMouseEnter={() => setHoverU(u)}
            onMouseLeave={() => setHoverU((cur) => (cur === u ? null : cur))}
            className="absolute cursor-pointer rounded hover:bg-blue-50/60"
            style={{ left: ix, top: ruTopY(u, 1, heightU), width: RACK_INTERIOR_W, height: RU_PX }} />
        ))}
        {/* device hit boxes — ONLY the mounting ears select a device. The container is
           pointer-events:none so clicks on the faceplate body (and the port dots in the overlay
           painted above) are never intercepted — even when the device is selected and raised to
           z-10 — so a selected device's own ports stay patchable. */}
        {placements.map((p) => {
          // Base RU position; during a grip-drag the box is offset imperatively (see the drag effect).
          const top = ruTopY(p.startU, p.template.rackUnits, heightU);
          const h = p.template.rackUnits * RU_PX;
          const selected = p.id === selectedId;
          const earPx = frameDims({ widthIn: p.template.widthIn, rackUnits: p.template.rackUnits, rackMounted: p.template.rackMounted }).earWidthPx;
          // Selectable strips: the two ears when present, else the whole body (so an ear-less,
          // non-rack-mounted device isn't left unselectable).
          const ears = earPx > 0
            ? [{ key: "l", left: 0 }, { key: "r", left: RACK_INTERIOR_W - earPx }]
            : [{ key: "full", left: 0 }];
          const earW = earPx > 0 ? earPx : RACK_INTERIOR_W;
          // Centre the grip ON the right ear (it takes the ear's blue, so the two read as one
          // piece) instead of hanging it off the device's right edge. An ear-less device has no
          // ear to sit in, so tuck the grip just inside the body edge.
          const gripRight = earPx > 0 ? (earPx - GRIP_W) / 2 : 2;
          return (
            <div key={p.id} data-testid={`rack-dev-${p.id}`}
              className={`absolute ${selected ? "z-10" : ""}`}
              style={{ left: ix, top, width: RACK_INTERIOR_W, height: h, pointerEvents: "none" }}>
              {ears.map((ear) => (
                <div key={ear.key} data-testid={`rack-dev-ear-${ear.key}-${p.id}`}
                  onClick={(e) => { e.stopPropagation(); props.onSelect(p.id); }}
                  className="absolute top-0 h-full cursor-pointer"
                  style={{ left: ear.left, width: earW, pointerEvents: "auto" }} />
              ))}
              {selected && (
                <>
                  {/* Offsetting a rounded rect outward grows its radius by the same amount, so the
                      box only hugs the device's curve at CORNER_R + its own outset. Colour comes
                      from RK_SELECT, not a `border-blue-500` class — see that constant. */}
                  <div data-testid={`rack-select-box-${p.id}`} className="pointer-events-none absolute border-2"
                    style={{ inset: -SELECT_OUTSET, borderRadius: CORNER_R + SELECT_OUTSET,
                      borderStyle: "solid", borderColor: RK_SELECT }} />
                  <div data-testid={`rack-grip-${p.id}`} title="Drag to move"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      dragRef.current = { id: p.id, startY: e.clientY, origU: p.startU, ru: p.template.rackUnits, ghostU: p.startU };
                      setDragId(p.id);
                    }}
                    className="pointer-events-auto absolute top-1/2 flex h-8 w-4 -translate-y-1/2 cursor-grab items-center justify-center rounded text-white"
                    style={{ right: gripRight, backgroundColor: RK_GRIP }}>
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
            connections={props.connections} activeConnIds={activeConnIds}
            onConnectAttempt={attemptConnect} onPortClick={handlePortClick}
            onSelectConnection={props.onSelectConnection}
            onHoverPort={setHoveredPort} onHoverCable={setHoveredCable}
            pinPort={pinShown ? selectedPort : null}
            onDisconnect={(id) => { props.onDisconnect(id); setSelectedPort(null); setPinShown(false); props.onSelectConnection(null); }} />
        </svg>
      </div>

      {/* Replace-connection prompt: shown when a connect gesture involves an already-patched port —
          at EITHER end, since dragging a patched port somewhere new means "move this cable". */}
      {replacePrompt && (() => {
        const close = () => { setReplacePrompt(null); setPendingSource(null); };
        const { existing, source, target } = replacePrompt;
        return (
          <div className="rde-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={close}>
            <div className="rde-modal-card w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-neutral-900">
                {existing.length > 1 ? "Both ports are already connected" : "Port already connected"}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                Replacing will disconnect{existing.length > 1 ? ":" : " "}
                {existing.length > 1 ? null : (
                  <span className="font-medium text-neutral-900">
                    {props.portLabel(existing[0].a)} ↔ {props.portLabel(existing[0].b)}
                  </span>
                )}
                {existing.length > 1 && (
                  <span className="mt-1 block">
                    {existing.map((c) => (
                      <span key={c.id} className="block font-medium text-neutral-900">
                        {props.portLabel(c.a)} ↔ {props.portLabel(c.b)}
                      </span>
                    ))}
                  </span>
                )}
                {existing.length > 1 ? "" : " "}and connect{" "}
                <span className="font-medium text-neutral-900">{props.portLabel(source)} ↔ {props.portLabel(target)}</span>.
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <button type="button" onClick={close}
                  className="rounded-lg px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-100">Cancel</button>
                <button type="button" data-testid="replace-confirm"
                  onClick={() => { props.onReplace(existing.map((c) => c.id), source, target); close(); }}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-blue-700">Replace</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
});
