"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FloorPlanRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import {
  normToScreen,
  polygonCentroid,
  partitionPlacement,
  type NormPoint,
  type PlanView,
} from "./floorPlanOps";

const CANVAS_HEIGHT = 560;
// jsdom has no ResizeObserver (feature-detected below), so tests always land here — a fixed
// number keeps the fit-on-mount deterministic instead of depending on whatever jsdom's default
// (0-width) container measures as.
const FALLBACK_PANE_WIDTH = 870;

const ZOOM_MAX = 8;
const ZOOM_MIN_FACTOR = 0.5; // the floor is fit * this factor, not an absolute number

// Wheel-zoom sensitivity. A macOS trackpad pinch arrives as a wheel event with ctrlKey set, and
// reports much smaller per-event deltas than a real scroll wheel notch — the sites map hit this
// exact issue (see SitesMap.tsx's PINCH_PX_PER_ZOOM_LEVEL comment) and needed a gentler divisor
// for pinch specifically, or a light flick tore through multiple zoom levels at once.
const K_SCROLL = 0.0015;
const K_PINCH = K_SCROLL / 3;

const ROOM_FILL = "rgb(59 130 246 / 0.10)";
const ROOM_STROKE = "#2563eb";
const STATUS_PIN_COLOR: Record<FloorDeviceRow["status"], string> = {
  planned: "#525252",
  installed: "#15803d",
};

/** The view every child shape is positioned with: zero pan, unit zoom, so normToScreen(p, this)
 *  collapses to (nx * imgW, ny * imgH) — plain IMAGE-PIXEL space. See the coordinate-model
 *  comment on FloorPlanCanvas below for why the live pan/zoom never appears in this call. */
function identityView(imgW: number, imgH: number): PlanView {
  return { panX: 0, panY: 0, zoom: 1, imgW, imgH };
}

interface LiveView {
  panX: number;
  panY: number;
  zoom: number;
}

function RoomPolygon({
  room,
  imgW,
  imgH,
  zoom,
}: {
  room: RoomRow;
  imgW: number;
  imgH: number;
  zoom: number;
}) {
  const polygon = room.plan_polygon;
  if (!polygon) return null;

  const view = identityView(imgW, imgH);
  const points = polygon.map((p) => {
    const s = normToScreen(p, view);
    return `${s.x},${s.y}`;
  }).join(" ");
  const centroid = normToScreen(polygonCentroid(polygon), view);

  return (
    <g>
      <polygon
        data-testid={`plan-room-${room.code}`}
        points={points}
        fill={ROOM_FILL}
        stroke={ROOM_STROKE}
        strokeWidth={2}
      />
      {/* Counter-scaled label chip — see the pin comment below for why translate/scale are split
          across two nested groups instead of one combined transform. */}
      <g transform={`translate(${centroid.x} ${centroid.y})`}>
        <g transform={`scale(${1 / zoom})`}>
          <rect x={-22} y={-11} width={44} height={22} rx={6} fill={ROOM_STROKE} />
          <text x={0} y={4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#ffffff">
            {room.code}
          </text>
        </g>
      </g>
    </g>
  );
}

function DevicePin({
  device,
  imgW,
  imgH,
  zoom,
  typeName,
}: {
  device: FloorDeviceRow;
  imgW: number;
  imgH: number;
  zoom: number;
  typeName: string;
}) {
  // device.x/device.y are guaranteed non-null by partitionPlacement's `!= null` check before this
  // component is ever rendered — x === 0 / y === 0 is a real placement, not "unset" (the same
  // both-non-null rule partitionPlacement itself enforces).
  const p: NormPoint = [device.x as number, device.y as number];
  const anchor = normToScreen(p, identityView(imgW, imgH));
  const color = STATUS_PIN_COLOR[device.status];

  return (
    // The OUTER group's transform is exactly translate(anchor) — nothing else — so a test can
    // hand-compute the expected string from normToScreen(p, identityView) alone, independent of
    // the live zoom. The counter-scale lives on the INNER group instead (see the comment on
    // FloorPlanCanvas for why the split exists).
    <g data-testid={`plan-pin-${device.code}`} transform={`translate(${anchor.x} ${anchor.y})`}>
      <g transform={`scale(${1 / zoom})`}>
        <title>{typeName}</title>
        <circle r={7} fill={color} stroke="#ffffff" strokeWidth={2} />
        <text
          x={0}
          y={-12}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#171717"
          stroke="#ffffff"
          strokeWidth={3}
          paintOrder="stroke"
        >
          {device.code}
        </text>
      </g>
    </g>
  );
}

/** The SVG surface for a floor plan: the plan image, room polygons, and device pins, with
 *  pan/zoom. This task (view mode) renders everything read-only, plus the `editable` toggle
 *  shell that Task 7 hangs its edit-mode gestures/tray off of — flipping `editMode` here does
 *  nothing else yet.
 *
 *  COORDINATE MODEL — read before touching pan/zoom.
 *
 *  Every shape below (room polygons, their label centroids, device pins) is positioned with
 *  normToScreen(point, identityView(imgW, imgH)) — zero pan, zoom = 1 — which collapses to
 *  (nx * imgW, ny * imgH): plain IMAGE-PIXEL space, not screen space. The live pan/zoom state
 *  (`view`) never touches per-shape math. It lives in exactly ONE place: the single
 *  `<g transform="translate(panX panY) scale(zoom)">` that wraps every shape below it.
 *
 *  That single transform is not a shortcut, it's algebraically the SAME formula as calling
 *  normToScreen with the live view directly. Composing translate(panX,panY) . scale(zoom) over a
 *  point already placed at (nx*imgW, ny*imgH) yields (panX + nx*imgW*zoom, panY + ny*imgH*zoom)
 *  — exactly normToScreen(p, {panX, panY, zoom, imgW, imgH}). So the split (identity math on
 *  children + one live transform on their shared ancestor) is free: it's the same math, factored
 *  so the browser's own transform pipeline does the pan/zoom multiply once per frame instead of
 *  this component recomputing every point's screen position on every wheel/drag event.
 *
 *  This is also why zoom here is fully continuous — no snapping — with zero visual wiggle,
 *  unlike the sites map (see SitesMap.tsx's INTERACTIVE_ZOOM_SNAP comment). Leaflet re-rounds
 *  each marker's screen position to whole pixels every frame while its tile layer scales
 *  continuously underneath, so a fractional zoom visibly drifts markers off the map. That
 *  mechanism doesn't exist here: one <g> transform is the only thing that ever moves, every
 *  child rides it exactly (no rounding, ever), so there is nothing for a shape to wiggle against.
 *
 *  Pins and room labels DO carry a second, LOCAL transform — but it's a counter-scale, not an
 *  independent position: `<g transform="translate(x y)"><g transform="scale(1/zoom)">...glyph...
 *  </g></g>`. The outer translate places the anchor in image-pixel space exactly like every other
 *  shape; the inner scale(1/zoom) cancels the outer live `<g>`'s zoom for just that glyph's
 *  children, so pins/chips stay a constant screen size while the plan image scales under them.
 *  Nothing here rounds to integers either, so it composes with the "one transform, no wiggle"
 *  rule above rather than reintroducing it.
 */
export function FloorPlanCanvas({
  plan,
  planUrl,
  rooms,
  devices,
  deviceTypes,
  editable,
}: {
  plan: FloorPlanRow;
  planUrl: string;
  rooms: RoomRow[];
  devices: FloorDeviceRow[];
  deviceTypes: DeviceTypeRow[];
  editable: boolean;
}) {
  const imgW = plan.width_px;
  const imgH = plan.height_px;

  const paneRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fitZoomRef = useRef(1);
  const [view, setView] = useState<LiveView>({ panX: 0, panY: 0, zoom: 1 });
  const [paneW, setPaneW] = useState(FALLBACK_PANE_WIDTH);

  const clampZoom = useCallback((z: number) => {
    const floor = fitZoomRef.current * ZOOM_MIN_FACTOR;
    return Math.min(ZOOM_MAX, Math.max(floor, z));
  }, []);

  // Fit-on-mount: measure the pane once (ResizeObserver when available, a fixed fallback width
  // in jsdom so tests are deterministic — see FALLBACK_PANE_WIDTH), then compute the zoom that
  // fits the whole plan image and centre it. Only the FIRST successful measurement fits; later
  // resizes just update `paneW` for the zoom-button centring math, they don't re-fit — the user's
  // own pan/zoom should not be clobbered by e.g. a sidebar collapsing.
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const fit = (w: number) => {
      setPaneW(w);
      const z = Math.min(w / imgW, CANVAS_HEIGHT / imgH);
      fitZoomRef.current = z;
      setView({ zoom: z, panX: (w - imgW * z) / 2, panY: (CANVAS_HEIGHT - imgH * z) / 2 });
    };
    if (typeof ResizeObserver === "undefined") {
      fit(FALLBACK_PANE_WIDTH);
      return;
    }
    let fitted = false;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (!w || fitted) return;
      fitted = true;
      fit(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
    // imgW/imgH come from `plan`, which is stable per mounted floor — a plan swap remounts this
    // component (new floor -> new key upstream), so this intentionally only runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zoom about a fixed viewport point (SVG-local coordinates), keeping that point visually still.
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((v) => {
      const nextZoom = clampZoom(v.zoom * factor);
      if (nextZoom === v.zoom) return v;
      const ratio = nextZoom / v.zoom;
      return {
        zoom: nextZoom,
        panX: cx - (cx - v.panX) * ratio,
        panY: cy - (cy - v.panY) * ratio,
      };
    });
  }, [clampZoom]);

  // Native (non-passive) wheel listener: React's onWheel is attached passively, which silently
  // ignores preventDefault(), so a plain React handler here could not stop the page from
  // scrolling underneath the plan while the user zooms it.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const k = e.ctrlKey ? K_PINCH : K_SCROLL;
      zoomAt(Math.exp(-e.deltaY * k), cx, cy);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  // Pointer-drag panning over empty plan space, via pointer capture so the drag keeps tracking
  // even if the cursor leaves the SVG mid-gesture.
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, panX: view.panX, panY: view.panY };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, panX: d.panX + (e.clientX - d.x), panY: d.panY + (e.clientY - d.y) }));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const { placed } = partitionPlacement(devices);
  const typeName = (id: string) => deviceTypes.find((t) => t.id === id)?.name ?? "—";

  // Task 7's edit-mode internals hang off this flag; nothing beyond the flag itself lives here
  // yet — no tray, no gestures, no actions.
  const [editMode, setEditMode] = useState(false);

  return (
    <div className="space-y-2">
      {editable && (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="edit-layout-toggle"
            onClick={() => setEditMode((m) => !m)}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-neutral-200 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
          >
            {editMode ? "Done" : "Edit layout"}
          </button>
        </div>
      )}
      <div
        ref={paneRef}
        className="no-select-ui relative overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50"
        style={{ height: CANVAS_HEIGHT }}
      >
        <svg
          ref={svgRef}
          data-testid="floor-plan-canvas"
          width="100%"
          height={CANVAS_HEIGHT}
          style={{ display: "block", touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <g transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
            <image href={planUrl} x={0} y={0} width={imgW} height={imgH} preserveAspectRatio="xMidYMid meet" />
            {rooms.map((room) => (
              <RoomPolygon key={room.id} room={room} imgW={imgW} imgH={imgH} zoom={view.zoom} />
            ))}
            {placed.map((device) => (
              <DevicePin
                key={device.id}
                device={device}
                imgW={imgW}
                imgH={imgH}
                zoom={view.zoom}
                typeName={typeName(device.device_type_id)}
              />
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col gap-1.5">
          <button
            type="button"
            data-testid="plan-zoom-in"
            onClick={() => zoomAt(1.25, paneW / 2, CANVAS_HEIGHT / 2)}
            className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-lg bg-white text-base font-semibold text-neutral-600 shadow-[0_1px_3px_rgba(0,0,0,0.15),0_1px_2px_rgba(0,0,0,0.08)] hover:bg-neutral-50"
          >
            +
          </button>
          <button
            type="button"
            data-testid="plan-zoom-out"
            onClick={() => zoomAt(0.8, paneW / 2, CANVAS_HEIGHT / 2)}
            className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-lg bg-white text-base font-semibold text-neutral-600 shadow-[0_1px_3px_rgba(0,0,0,0.15),0_1px_2px_rgba(0,0,0,0.08)] hover:bg-neutral-50"
          >
            −
          </button>
        </div>
      </div>
    </div>
  );
}
