"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import type { FloorPlanRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import type { SiteRackRow } from "./repository";
import {
  normToScreen,
  screenToNorm,
  polygonCentroid,
  partitionPlacement,
  insertVertexOnEdge,
  removeVertex,
  dedupePolygon,
  type NormPoint,
  type PlanView,
} from "./floorPlanOps";
import {
  placeFloorDeviceAction,
  clearFloorDevicePlacementAction,
  placeRackAction,
  clearRackPlacementAction,
  setRoomPolygonAction,
  clearRoomPolygonAction,
} from "./actions";

const CANVAS_HEIGHT = 560;
// A press that travels less than this counts as a tap (select), not a pan. Enough to absorb the
// pointer drift every physical click carries, small enough that a deliberate pan never selects.
const TAP_THRESHOLD_PX = 6;
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

// A native double-click gesture delivers click, click, THEN dblclick — each `click` appends a
// draw point before `dblclick` ever commits — so a dblclick-close's raw drawPoints always carries
// a trailing duplicate. dedupePolygon (called once, in commitDrawnRoom, for BOTH the Enter and
// dblclick closing paths) collapses that; this is its distance threshold in normalized space.
const POLYGON_DEDUPE_EPSILON = 1e-3;

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

/** A vertex being dragged, or a vertex just committed via insert-on-edge, superimposed over the
 *  room's own committed polygon for the SINGLE room it belongs to — never carries a room id,
 *  because the caller only ever passes it into the RoomPolygon instance it applies to. */
interface VertexPreview {
  index: number;
  point: NormPoint;
}

function RoomPolygon({
  room,
  imgW,
  imgH,
  zoom,
  editMode,
  selected,
  editing,
  vertexPreview,
  onVertexPointerDown,
  onInsertVertex,
}: {
  room: RoomRow;
  imgW: number;
  imgH: number;
  zoom: number;
  editMode?: boolean;
  selected?: boolean;
  editing?: boolean;
  vertexPreview?: VertexPreview | null;
  onVertexPointerDown?: (e: React.PointerEvent, roomId: string, index: number, polygon: NormPoint[]) => void;
  onInsertVertex?: (roomId: string, polygon: NormPoint[], edgeIndex: number) => void;
}) {
  const basePolygon = room.plan_polygon;
  if (!basePolygon) return null;

  // The live-dragged vertex overrides its index for rendering only — the committed action, on
  // pointer-up, always maps over the ORIGINAL polygon captured at drag-start (see
  // FloorPlanCanvas's vertexDragRef), so this substitution is purely visual.
  const polygon = vertexPreview
    ? basePolygon.map((pt, i) => (i === vertexPreview.index ? vertexPreview.point : pt))
    : basePolygon;

  const view = identityView(imgW, imgH);
  const points = polygon.map((p) => {
    const s = normToScreen(p, view);
    return `${s.x},${s.y}`;
  }).join(" ");
  const centroid = normToScreen(polygonCentroid(polygon), view);

  return (
    <g className="plan-room-group">
      {/* No onClick/stopPropagation here: the press bubbles to the SVG root, which decides
          tap-vs-pan from pointer travel and reads this room via data-room-id. A click handler
          was the old, drift-fragile path. */}
      <polygon
        data-testid={`plan-room-${room.code}`}
        data-room-id={room.id}
        points={points}
        fill={selected ? "rgb(37 99 235 / 0.18)" : ROOM_FILL}
        stroke={ROOM_STROKE}
        strokeWidth={selected ? 3 : 2}
        style={editMode ? { cursor: "pointer" } : undefined}
      />
      {/* Label: hidden until the room is hovered (globals.css `.plan-room-group:hover`), so a
          plan crowded with rooms isn't a wall of chips. Halo text (no fixed box) so a long name
          can't clip. `pointer-events: none` keeps it out of the tap/hit path. */}
      <g className="plan-room-label" transform={`translate(${centroid.x} ${centroid.y})`}>
        <g transform={`scale(${1 / zoom})`}>
          <text
            data-testid={`plan-room-label-${room.code}`}
            x={0}
            y={4}
            textAnchor="middle"
            fontSize={12}
            fontWeight={700}
            fill="#171717"
            stroke="#ffffff"
            strokeWidth={3}
            paintOrder="stroke"
          >
            {room.name || room.code}
          </text>
        </g>
      </g>
      {editMode &&
        editing &&
        // Vertex handles: index `i` is derived HERE, synchronously, from the polygon this
        // instance is actually rendering — never a cached/stale index (Task 2 review note).
        polygon.map((p, i) => {
          const pos = normToScreen(p, view);
          return (
            <circle
              key={`v-${i}`}
              data-testid={`vertex-${room.code}-${i}`}
              cx={pos.x}
              cy={pos.y}
              r={6 / zoom}
              fill="#ffffff"
              stroke={ROOM_STROKE}
              strokeWidth={2 / zoom}
              // A per-shape pointer-down MUST stopPropagation, or a vertex drag would also pan
              // the canvas via the SVG root's own onPointerDown (Task 6 review note).
              onPointerDown={(e) => {
                e.stopPropagation();
                onVertexPointerDown?.(e, room.id, i, polygon);
              }}
              onClick={(e) => e.stopPropagation()}
              style={{ cursor: "grab" }}
            />
          );
        })}
      {editMode &&
        editing &&
        polygon.map((p, i) => {
          const next = polygon[(i + 1) % polygon.length];
          const mid: NormPoint = [(p[0] + next[0]) / 2, (p[1] + next[1]) / 2];
          const pos = normToScreen(mid, view);
          return (
            <circle
              key={`m-${i}`}
              data-testid={`vertex-insert-${room.code}-${i}`}
              cx={pos.x}
              cy={pos.y}
              r={4 / zoom}
              fill={ROOM_STROKE}
              opacity={0.55}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onInsertVertex?.(room.id, polygon, i);
              }}
              style={{ cursor: "copy" }}
            />
          );
        })}
    </g>
  );
}

function DevicePin({
  device,
  imgW,
  imgH,
  zoom,
  typeName,
  editMode,
  selected,
  dragPoint,
  onPointerDownPin,
}: {
  device: FloorDeviceRow;
  imgW: number;
  imgH: number;
  zoom: number;
  typeName: string;
  editMode?: boolean;
  selected?: boolean;
  dragPoint?: NormPoint | null;
  onPointerDownPin?: (e: React.PointerEvent, deviceId: string) => void;
}) {
  // device.x/device.y are guaranteed non-null by partitionPlacement's `!= null` check before this
  // component is ever rendered — x === 0 / y === 0 is a real placement, not "unset" (the same
  // both-non-null rule partitionPlacement itself enforces). `dragPoint`, when present, is a LIVE
  // drag preview only — the committed action always uses the pointer-up position computed fresh,
  // never this prop.
  const p: NormPoint = dragPoint ?? [device.x as number, device.y as number];
  const anchor = normToScreen(p, identityView(imgW, imgH));
  const color = STATUS_PIN_COLOR[device.status];

  return (
    // The OUTER group's transform is exactly translate(anchor) — nothing else — so a test can
    // hand-compute the expected string from normToScreen(p, identityView) alone, independent of
    // the live zoom. The counter-scale lives on the INNER group instead (see the comment on
    // FloorPlanCanvas for why the split exists).
    <g
      data-testid={`plan-pin-${device.code}`}
      transform={`translate(${anchor.x} ${anchor.y})`}
      // A per-shape pointer-down MUST stopPropagation, or a pin drag would also pan the canvas
      // via the SVG root's own onPointerDown (Task 6 review note).
      onPointerDown={
        editMode
          ? (e) => {
              e.stopPropagation();
              onPointerDownPin?.(e, device.id);
            }
          : undefined
      }
      onClick={editMode ? (e) => e.stopPropagation() : undefined}
      style={editMode ? { cursor: "grab" } : undefined}
    >
      <g transform={`scale(${1 / zoom})`}>
        <title>{typeName}</title>
        {selected && (
          <circle r={12} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="3 2" />
        )}
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

/** A placed rack: a square marker (distinct from the round device pins) carrying the rack code.
 *  Selection is decided by the SVG root's tap detection via `data-rack-id` — the same drift-proof
 *  path rooms use — so this renders no pointer handlers of its own. */
function RackMarker({
  rack,
  imgW,
  imgH,
  zoom,
  editMode,
  selected,
}: {
  rack: SiteRackRow;
  imgW: number;
  imgH: number;
  zoom: number;
  editMode?: boolean;
  selected?: boolean;
}) {
  const anchor = normToScreen([rack.x as number, rack.y as number], identityView(imgW, imgH));
  return (
    <g
      data-testid={`plan-rack-${rack.code}`}
      data-rack-id={rack.id}
      transform={`translate(${anchor.x} ${anchor.y})`}
      style={editMode ? { cursor: "pointer" } : undefined}
    >
      <g transform={`scale(${1 / zoom})`}>
        <title>Rack {rack.code}</title>
        {selected && (
          <rect x={-11} y={-11} width={22} height={22} rx={5} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="3 2" />
        )}
        <rect x={-8} y={-8} width={16} height={16} rx={3} fill="#0f172a" stroke="#ffffff" strokeWidth={2} />
        <text
          x={0}
          y={-14}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#171717"
          stroke="#ffffff"
          strokeWidth={3}
          paintOrder="stroke"
        >
          {rack.code}
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
  racks,
  deviceTypes,
  editable,
}: {
  plan: FloorPlanRow;
  planUrl: string;
  rooms: RoomRow[];
  devices: FloorDeviceRow[];
  racks: SiteRackRow[];
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
    // component because SiteDetail keys it by `activeFloor.id`, so this intentionally only runs
    // once. If that key is ever removed, this effect goes stale on plan swaps: switching floors
    // would update props (imgW/imgH, planUrl) without remounting, leaving the fit zoom/pan frozen
    // at whichever floor mounted first.
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

  const router = useRouter();
  const [editMode, setEditMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Tray selection / active gesture mode (mutually exclusive) ----
  const [placingDeviceId, setPlacingDeviceId] = useState<string | null>(null);
  const [placingRackId, setPlacingRackId] = useState<string | null>(null);
  const [drawingRoomId, setDrawingRoomId] = useState<string | null>(null);
  const [drawPoints, setDrawPoints] = useState<NormPoint[]>([]);
  const [hoverPoint, setHoverPoint] = useState<NormPoint | null>(null);

  // ---- Selection for move / un-place / vertex-edit ----
  const [selectedPinId, setSelectedPinId] = useState<string | null>(null);
  // A tapped room shows its edit/delete popover (selectedRoomId). Its vertex handles only appear
  // once the popover's Edit icon promotes it to editingRoomId — so a plain select can't be
  // fumbled into an accidental vertex drag.
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [selectedRackId, setSelectedRackId] = useState<string | null>(null);
  const [selectedVertex, setSelectedVertex] = useState<{ roomId: string; index: number } | null>(null);

  // ---- Live drag previews (visual only — the action commits ONCE, on pointer-up) ----
  const [pinPreview, setPinPreview] = useState<{ deviceId: string; point: NormPoint } | null>(null);
  const [vertexPreview, setVertexPreview] = useState<
    { roomId: string; index: number; point: NormPoint } | null
  >(null);

  // Pointer-drag panning over empty plan space, via pointer capture so the drag keeps tracking
  // even if the cursor leaves the SVG mid-gesture.
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; roomId: string | null; rackId: string | null } | null>(null);
  // Undo stack for the room CURRENTLY being vertex-edited: each committed change (move / insert /
  // delete) first pushes the polygon as it was, so a right-click can step back through them. Reset
  // whenever the edited room changes (see the effect below). Tracing uses drawPoints directly.
  const editHistoryRef = useRef<NormPoint[][]>([]);

  // The vertex-edit undo stack is per edited room — switching rooms (or leaving edit) starts fresh.
  useEffect(() => {
    editHistoryRef.current = [];
  }, [editingRoomId]);
  // Pin-move drag: set by DevicePin's onPointerDown (which stopPropagation's, so the ROOT's own
  // onPointerDown above never fires — panning and pin-dragging can never both start from the same
  // gesture). `moved` distinguishes a plain select-click (no commit) from an actual drag (commits
  // once, here, on pointer-up).
  const pinDragRef = useRef<{ deviceId: string; moved: boolean; clientX: number; clientY: number } | null>(
    null
  );
  // Vertex-move drag: same shape/contract as pinDragRef. `polygon` is the room's polygon AS
  // RENDERED at drag-start — the commit on pointer-up maps over this exact array using `index`,
  // never a re-derived or stale one (Task 2 review note).
  const vertexDragRef = useRef<{
    roomId: string;
    index: number;
    polygon: NormPoint[];
    moved: boolean;
    clientX: number;
    clientY: number;
  } | null>(null);

  // Screen (client) coordinates -> plan-normalized coordinates, against the SVG's own bounding
  // rect and the LIVE view (pan/zoom) — the one conversion path, per the coordinate-model note.
  const toNorm = useCallback(
    (clientX: number, clientY: number): NormPoint | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      return screenToNorm(
        { x: clientX - rect.left, y: clientY - rect.top },
        { panX: view.panX, panY: view.panY, zoom: view.zoom, imgW, imgH }
      );
    },
    [view, imgW, imgH]
  );

  // ---- Action commits — each is called exactly once per completed gesture ----
  async function commitPlaceDevice(id: string, point: NormPoint) {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("x", String(point[0]));
    fd.set("y", String(point[1]));
    const res = await placeFloorDeviceAction(fd);
    if (!res.ok) {
      setError(res.error ?? "Failed to place device");
      return;
    }
    setError(null);
    router.refresh();
  }

  async function commitUnplace(id: string) {
    const fd = new FormData();
    fd.set("id", id);
    const res = await clearFloorDevicePlacementAction(fd);
    if (!res.ok) {
      setError(res.error ?? "Failed to remove device");
      return;
    }
    setSelectedPinId(null);
    setError(null);
    router.refresh();
  }

  async function commitRoomPolygon(roomId: string, polygon: NormPoint[]) {
    const fd = new FormData();
    fd.set("roomId", roomId);
    fd.set("polygon", JSON.stringify(polygon));
    const res = await setRoomPolygonAction(fd);
    if (!res.ok) {
      setError(res.error ?? "Failed to save room outline");
      return;
    }
    setError(null);
    router.refresh();
  }

  /** Commit a vertex edit, first recording the polygon as it was so a right-click can undo it. */
  function commitRoomPolygonEdit(roomId: string, priorPolygon: NormPoint[], nextPolygon: NormPoint[]) {
    editHistoryRef.current.push(priorPolygon);
    void commitRoomPolygon(roomId, nextPolygon);
  }

  async function commitDrawnRoom(roomId: string, points: NormPoint[]) {
    // Dedupe BEFORE validating/saving, uniformly for both closing gestures (Enter and
    // dblclick funnel through this single function). If enough vertices collapse to drop below
    // 3, refuse the close exactly like any other <3 polygon — leave the draw in progress rather
    // than persisting junk.
    const deduped = dedupePolygon(points, POLYGON_DEDUPE_EPSILON);
    if (deduped.length < 3) return;
    const fd = new FormData();
    fd.set("roomId", roomId);
    fd.set("polygon", JSON.stringify(deduped));
    const res = await setRoomPolygonAction(fd);
    if (!res.ok) {
      setError(res.error ?? "Failed to save room outline");
      return;
    }
    setDrawingRoomId(null);
    setDrawPoints([]);
    setHoverPoint(null);
    setError(null);
    router.refresh();
  }

  async function commitClearRoomPolygon(roomId: string) {
    const fd = new FormData();
    fd.set("roomId", roomId);
    const res = await clearRoomPolygonAction(fd);
    if (!res.ok) {
      setError(res.error ?? "Failed to clear outline");
      return;
    }
    setSelectedRoomId(null);
    setError(null);
    router.refresh();
  }

  function handleDeleteSelectedVertex() {
    if (!selectedVertex) return;
    const room = rooms.find((r) => r.id === selectedVertex.roomId);
    if (!room?.plan_polygon) return;
    const result = removeVertex(room.plan_polygon, selectedVertex.index);
    // removeVertex returns the SAME array reference when it refuses (below 3 vertices) — that
    // reference equality is exactly how a refusal is told apart from a real removal here.
    if (result === room.plan_polygon) return;
    setSelectedVertex(null);
    commitRoomPolygonEdit(room.id, room.plan_polygon, result);
  }

  function onInsertVertexClick(roomId: string, polygon: NormPoint[], edgeIndex: number) {
    // `edgeIndex` came from a synchronous polygon.map in RoomPolygon (Task 2 review note) — never
    // stale — so it's always in-range for insertVertexOnEdge, which throws otherwise.
    const next = insertVertexOnEdge(polygon, edgeIndex);
    commitRoomPolygonEdit(roomId, polygon, next);
  }

  /** Right-click undo. While tracing, removes the last placed point. While vertex-editing, reverts
   *  the last committed change (move / insert / delete) by replaying the recorded polygon. */
  function undoLastPoint() {
    if (drawingRoomId) {
      setDrawPoints((prev) => (prev.length > 0 ? prev.slice(0, -1) : prev));
      return;
    }
    if (editingRoomId && editHistoryRef.current.length > 0) {
      const prevPolygon = editHistoryRef.current.pop()!;
      void commitRoomPolygon(editingRoomId, prevPolygon);
    }
  }

  // ---- Tray selection ----
  function selectDeviceForPlacement(id: string) {
    setPlacingDeviceId(id);
    setPlacingRackId(null);
    setDrawingRoomId(null);
    setDrawPoints([]);
    setHoverPoint(null);
    setSelectedPinId(null);
    setSelectedRackId(null);
    setSelectedVertex(null);
    clearRoomSelection();
  }

  function selectRoomForDrawing(id: string) {
    setDrawingRoomId(id);
    setDrawPoints([]);
    setHoverPoint(null);
    setPlacingDeviceId(null);
    setPlacingRackId(null);
    setSelectedPinId(null);
    setSelectedRackId(null);
    setSelectedVertex(null);
    setSelectedRoomId(null);
  }

  /** Select an outlined room (tapping its polygon) → shows the edit/delete popover. Switching to a
   *  different room drops any in-progress vertex editing; re-selecting the same room leaves it be. */
  function selectRoom(id: string) {
    if (id !== selectedRoomId) setEditingRoomId(null);
    setSelectedRoomId(id);
    setPlacingDeviceId(null);
    setPlacingRackId(null);
    setDrawingRoomId(null);
    setDrawPoints([]);
    setHoverPoint(null);
    setSelectedPinId(null);
    setSelectedRackId(null);
    setSelectedVertex(null);
  }

  function clearRoomSelection() {
    setSelectedRoomId(null);
    setEditingRoomId(null);
    setSelectedVertex(null);
  }

  async function deleteSelectedRoomOutline(roomId: string) {
    // Clears the OUTLINE, never the room — the room and its devices stay in the lists below.
    clearRoomSelection();
    await commitClearRoomPolygon(roomId);
  }

  async function commitPlaceRack(id: string, point: NormPoint) {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("x", String(point[0]));
    fd.set("y", String(point[1]));
    const res = await placeRackAction(fd);
    if (!res.ok) {
      setError(res.error ?? "Failed to place rack");
      return;
    }
    setError(null);
    router.refresh();
  }

  /** Deletes the PLACEMENT only — the rack (and its devices) stays in the lists below. */
  async function deleteRackPlacement(rackId: string) {
    setSelectedRackId(null);
    const fd = new FormData();
    fd.set("id", rackId);
    const res = await clearRackPlacementAction(fd);
    if (!res.ok) {
      setError(res.error ?? "Failed to remove rack from plan");
      return;
    }
    setError(null);
    router.refresh();
  }

  function selectRackForPlacement(id: string) {
    setPlacingRackId(id);
    setPlacingDeviceId(null);
    setDrawingRoomId(null);
    setDrawPoints([]);
    setHoverPoint(null);
    setSelectedPinId(null);
    setSelectedVertex(null);
    clearRoomSelection();
    setSelectedRackId(null);
  }

  /** Tapping a placed rack marker selects it → shows the edit/delete popover. */
  function selectRack(id: string) {
    setSelectedRackId(id);
    setPlacingDeviceId(null);
    setPlacingRackId(null);
    setDrawingRoomId(null);
    setDrawPoints([]);
    setHoverPoint(null);
    setSelectedPinId(null);
    setSelectedVertex(null);
    clearRoomSelection();
  }

  // ---- Pin / vertex drag start (attached by the child shapes; both stopPropagation first) ----
  const onPinPointerDown = (e: React.PointerEvent, deviceId: string) => {
    if (e.button !== 0) return;
    setSelectedPinId(deviceId);
    setSelectedRackId(null);
    clearRoomSelection();
    setSelectedVertex(null);
    pinDragRef.current = { deviceId, moved: false, clientX: e.clientX, clientY: e.clientY };
  };

  const onVertexPointerDown = (e: React.PointerEvent, roomId: string, index: number, polygon: NormPoint[]) => {
    if (e.button !== 0) return;
    setSelectedVertex({ roomId, index });
    setSelectedPinId(null);
    vertexDragRef.current = { roomId, index, polygon, moved: false, clientX: e.clientX, clientY: e.clientY };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Remember whether this press landed on a room polygon, read straight off the DOM so it can't
    // desync from event ordering. Pins/vertices stopPropagation and never reach here.
    const target = e.target as Element;
    const roomEl = target.closest?.("[data-room-id]");
    const rackEl = target.closest?.("[data-rack-id]");
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: view.panX,
      panY: view.panY,
      roomId: roomEl?.getAttribute("data-room-id") ?? null,
      rackId: rackEl?.getAttribute("data-rack-id") ?? null,
    };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pinDragRef.current) {
      const drag = pinDragRef.current;
      drag.moved = true;
      drag.clientX = e.clientX;
      drag.clientY = e.clientY;
      const n = toNorm(e.clientX, e.clientY);
      if (n) setPinPreview({ deviceId: drag.deviceId, point: n });
      return;
    }
    if (vertexDragRef.current) {
      const drag = vertexDragRef.current;
      drag.moved = true;
      drag.clientX = e.clientX;
      drag.clientY = e.clientY;
      const n = toNorm(e.clientX, e.clientY);
      if (n) setVertexPreview({ roomId: drag.roomId, index: drag.index, point: n });
      return;
    }
    if (drawingRoomId) {
      setHoverPoint(toNorm(e.clientX, e.clientY));
    }
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, panX: d.panX + (e.clientX - d.x), panY: d.panY + (e.clientY - d.y) }));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (pinDragRef.current) {
      const drag = pinDragRef.current;
      pinDragRef.current = null;
      setPinPreview(null);
      // Commits ONCE here, never per pointermove — and only when the pointer actually moved
      // (otherwise this was a plain select-click, not a drag).
      if (drag.moved) {
        const n = toNorm(drag.clientX, drag.clientY);
        if (n) void commitPlaceDevice(drag.deviceId, n);
      }
      return;
    }
    if (vertexDragRef.current) {
      const drag = vertexDragRef.current;
      vertexDragRef.current = null;
      setVertexPreview(null);
      if (drag.moved) {
        const n = toNorm(drag.clientX, drag.clientY);
        if (n) {
          const nextPolygon = drag.polygon.map((p, i) => (i === drag.index ? n : p));
          commitRoomPolygonEdit(drag.roomId, drag.polygon, nextPolygon);
        }
      }
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    // Tap vs pan: a press that barely moved is a TAP, not a pan — and the browser's own `click`
    // event is unreliable here because any sub-threshold pan still fires pointermove. So selection
    // is decided from the pointer travel, not from `click`, which is exactly what made a real
    // click on a room fail before (the smallest drift suppressed it).
    if (d && editMode && !placingDeviceId && !placingRackId && !drawingRoomId) {
      const travel = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (travel < TAP_THRESHOLD_PX) {
        // A rack marker sits above the room polygons, so a tap on one takes precedence.
        if (d.rackId) selectRack(d.rackId);
        else if (d.roomId) selectRoom(d.roomId);
        else {
          clearRoomSelection();
          setSelectedRackId(null);
        }
      }
    }
  };

  // Simple taps (not drags) — device placement and room-outline vertex clicks.
  function handleCanvasClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!editMode) return;
    if (placingDeviceId) {
      const n = toNorm(e.clientX, e.clientY);
      if (!n) return;
      const id = placingDeviceId;
      setPlacingDeviceId(null);
      void commitPlaceDevice(id, n);
      return;
    }
    if (placingRackId) {
      const n = toNorm(e.clientX, e.clientY);
      if (!n) return;
      const id = placingRackId;
      setPlacingRackId(null);
      void commitPlaceRack(id, n);
      return;
    }
    if (drawingRoomId) {
      const n = toNorm(e.clientX, e.clientY);
      if (!n) return;
      setDrawPoints((prev) => [...prev, n]);
    }
  }

  function handleCanvasDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (!editMode || !drawingRoomId) return;
    if (drawPoints.length >= 3) {
      e.preventDefault();
      void commitDrawnRoom(drawingRoomId, drawPoints);
    }
  }

  // Keyboard: Enter closes a ≥3-point draw, Esc cancels the current gesture/selection cleanly,
  // Delete/Backspace un-places a selected pin or removes a selected vertex.
  useEffect(() => {
    if (!editMode) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setPlacingDeviceId(null);
        setPlacingRackId(null);
        setDrawingRoomId(null);
        setDrawPoints([]);
        setHoverPoint(null);
        setSelectedPinId(null);
        setSelectedRackId(null);
        setSelectedRoomId(null);
        setEditingRoomId(null);
        setSelectedVertex(null);
        // A pin or vertex drag in progress must be cancelled too, not just its selection UI: the
        // subsequent pointerup handler commits based on `pinDragRef`/`vertexDragRef` (and
        // `drag.moved`) alone, so leaving those set would still fire the commit with the drag's
        // last coordinates even though the drag "looked" cancelled. Clearing the live preview
        // state as well snaps the pin/vertex back to its pre-drag, committed position visually.
        pinDragRef.current = null;
        vertexDragRef.current = null;
        setPinPreview(null);
        setVertexPreview(null);
        return;
      }
      if (e.key === "Enter") {
        if (drawingRoomId && drawPoints.length >= 3) {
          void commitDrawnRoom(drawingRoomId, drawPoints);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedPinId) {
          void commitUnplace(selectedPinId);
          return;
        }
        if (selectedVertex) {
          handleDeleteSelectedVertex();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // The handler closes over drawingRoomId/drawPoints/selectedPinId/selectedVertex/rooms
    // directly, so it must re-subscribe whenever any of them changes to avoid acting on stale
    // state (mirrors the existing eslint-disable precedent in the fit-on-mount effect above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMode, drawingRoomId, drawPoints, selectedPinId, selectedVertex, rooms]);

  const { placed, unplaced } = partitionPlacement(devices);
  const { placed: placedRacks, unplaced: unplacedRacks } = partitionPlacement(racks);
  const roomsWithoutPolygon = rooms.filter((r) => r.plan_polygon == null);
  const typeName = (id: string) => deviceTypes.find((t) => t.id === id)?.name ?? "—";
  const vertexPreviewForRoom = (roomId: string) =>
    vertexPreview && vertexPreview.roomId === roomId
      ? { index: vertexPreview.index, point: vertexPreview.point }
      : null;

  const selectedPin = selectedPinId ? devices.find((d) => d.id === selectedPinId) ?? null : null;
  const selectedRoom = selectedRoomId ? rooms.find((r) => r.id === selectedRoomId) ?? null : null;
  const selectedRack = selectedRackId ? racks.find((r) => r.id === selectedRackId) ?? null : null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-h-[1.25rem] flex-1">
          {error && (
            <p
              data-testid="canvas-error"
              className="inline-flex rounded-lg bg-red-50 px-3 py-1 text-sm font-medium text-red-700"
            >
              {error}
            </p>
          )}
          {!error && placingDeviceId && (
            <p className="text-sm text-neutral-500">Click on the plan to place the device. Esc to cancel.</p>
          )}
          {!error && placingRackId && (
            <p className="text-sm text-neutral-500">Click on the plan to place the rack. Esc to cancel.</p>
          )}
          {!error && drawingRoomId && (
            <p className="text-sm text-neutral-500">
              Click to add points
              {drawPoints.length >= 3 ? " — Enter or double-click to finish" : ` (${drawPoints.length}/3 minimum)`}.
              Esc to cancel.
            </p>
          )}
        </div>
        {editable && (
          <button
            type="button"
            data-testid="edit-layout-toggle"
            onClick={() => setEditMode((m) => !m)}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-neutral-200 px-4 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
          >
            {editMode ? "Done" : "Edit layout"}
          </button>
        )}
      </div>

      {editMode && (
        <div data-testid="plan-tray" className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
          {unplaced.length === 0 &&
            unplacedRacks.length === 0 &&
            roomsWithoutPolygon.length === 0 &&
            !placingDeviceId &&
            !placingRackId &&
            !drawingRoomId && <p className="text-sm text-neutral-400">Everything is placed</p>}
          {unplacedRacks.length > 0 && (
            <div className="mb-3">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Racks not on the plan
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {unplacedRacks.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    data-testid={`tray-rack-${r.code}`}
                    aria-pressed={placingRackId === r.id}
                    onClick={() => selectRackForPlacement(r.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                      placingRackId === r.id
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    {r.code}
                  </button>
                ))}
              </div>
            </div>
          )}
          {unplaced.length > 0 && (
            <div className="mb-3">
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Devices not on the plan
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {unplaced.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    data-testid={`tray-device-${d.code}`}
                    aria-pressed={placingDeviceId === d.id}
                    onClick={() => selectDeviceForPlacement(d.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                      placingDeviceId === d.id
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    {d.code}
                  </button>
                ))}
              </div>
            </div>
          )}
          {roomsWithoutPolygon.length > 0 && (
            <div>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Rooms not outlined
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {roomsWithoutPolygon.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    data-testid={`tray-room-${r.code}`}
                    aria-pressed={drawingRoomId === r.id}
                    onClick={() => selectRoomForDrawing(r.id)}
                    className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${
                      drawingRoomId === r.id
                        ? "border-blue-600 bg-blue-50 text-blue-700"
                        : "border-neutral-200 text-neutral-700 hover:bg-neutral-50"
                    }`}
                  >
                    {r.code}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {editMode && selectedPin && (
        <div
          data-testid="pin-popover"
          className="flex items-center justify-between rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm shadow-sm"
        >
          <span className="font-semibold text-neutral-900">
            {selectedPin.code} <span className="font-normal text-neutral-500">{selectedPin.name}</span>
          </span>
          <button
            type="button"
            onClick={() => void commitUnplace(selectedPin.id)}
            className="text-sm font-semibold text-red-600 hover:text-red-700"
          >
            Remove from plan
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
          style={{
            display: "block",
            touchAction: "none",
            cursor: placingDeviceId || placingRackId || drawingRoomId ? "crosshair" : undefined,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onClick={handleCanvasClick}
          onDoubleClick={handleCanvasDoubleClick}
          onContextMenu={(e) => {
            // Right-click = undo the last point, while tracing or vertex-editing. Suppress the
            // browser menu only in those modes so a normal right-click works everywhere else.
            if (editMode && (drawingRoomId || editingRoomId)) {
              e.preventDefault();
              undoLastPoint();
            }
          }}
        >
          <g transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
            <image href={planUrl} x={0} y={0} width={imgW} height={imgH} preserveAspectRatio="xMidYMid meet" />
            {rooms.map((room) => (
              <RoomPolygon
                key={room.id}
                room={room}
                imgW={imgW}
                imgH={imgH}
                zoom={view.zoom}
                editMode={editMode}
                selected={selectedRoomId === room.id || editingRoomId === room.id}
                editing={editingRoomId === room.id}
                vertexPreview={vertexPreviewForRoom(room.id)}
                onVertexPointerDown={onVertexPointerDown}
                onInsertVertex={onInsertVertexClick}
              />
            ))}
            {placed.map((device) => (
              <DevicePin
                key={device.id}
                device={device}
                imgW={imgW}
                imgH={imgH}
                zoom={view.zoom}
                typeName={typeName(device.device_type_id)}
                editMode={editMode}
                selected={selectedPinId === device.id}
                dragPoint={pinPreview && pinPreview.deviceId === device.id ? pinPreview.point : null}
                onPointerDownPin={onPinPointerDown}
              />
            ))}
            {placedRacks.map((rack) => (
              <RackMarker
                key={rack.id}
                rack={rack}
                imgW={imgW}
                imgH={imgH}
                zoom={view.zoom}
                editMode={editMode}
                selected={selectedRackId === rack.id}
              />
            ))}
            {drawingRoomId && (
              <g>
                {drawPoints.map((p, i) => {
                  const pos = normToScreen(p, identityView(imgW, imgH));
                  return (
                    <circle
                      key={i}
                      data-testid={`draw-point-${i}`}
                      cx={pos.x}
                      cy={pos.y}
                      r={5 / view.zoom}
                      fill={ROOM_STROKE}
                      stroke="#ffffff"
                      strokeWidth={1.5 / view.zoom}
                    />
                  );
                })}
                {drawPoints.length > 0 && (
                  <polyline
                    points={[...drawPoints, ...(hoverPoint ? [hoverPoint] : [])]
                      .map((p) => {
                        const s = normToScreen(p, identityView(imgW, imgH));
                        return `${s.x},${s.y}`;
                      })
                      .join(" ")}
                    fill="none"
                    stroke={ROOM_STROKE}
                    strokeDasharray="4 4"
                    strokeWidth={2 / view.zoom}
                  />
                )}
              </g>
            )}
          </g>
        </svg>
        {/* Edit/Delete popover, anchored over the selected room's centroid. Edit promotes the room
            to vertex editing (handles); Delete clears the OUTLINE only (the room survives). Both
            are plain buttons — a click here can't be lost to the pan gesture the way a canvas tap
            once was. */}
        {editMode && selectedRoom && selectedRoom.plan_polygon && (
          (() => {
            const c = normToScreen(polygonCentroid(selectedRoom.plan_polygon), identityView(imgW, imgH));
            const left = view.panX + c.x * view.zoom;
            const top = view.panY + c.y * view.zoom;
            const editingThis = editingRoomId === selectedRoom.id;
            return (
              <div
                data-testid="room-actions-popover"
                className="pointer-events-auto absolute z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-md"
                style={{ left, top }}
              >
                <button
                  type="button"
                  data-testid="room-action-edit"
                  aria-pressed={editingThis}
                  title={editingThis ? "Done editing" : "Edit outline"}
                  onClick={() => setEditingRoomId(editingThis ? null : selectedRoom.id)}
                  className={`flex h-8 w-8 items-center justify-center rounded-md ${
                    editingThis ? "bg-blue-50 text-blue-700" : "text-neutral-600 hover:bg-neutral-100"
                  }`}
                >
                  <Icon icon={editingThis ? "tabler:check" : "tabler:pencil"} width={17} height={17} />
                </button>
                <button
                  type="button"
                  data-testid="room-action-delete"
                  title="Delete outline"
                  onClick={() => void deleteSelectedRoomOutline(selectedRoom.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-red-600 hover:bg-red-50"
                >
                  <Icon icon="tabler:trash" width={17} height={17} />
                </button>
              </div>
            );
          })()
        )}
        {/* Rack popover, anchored over the selected rack. Edit opens the rack in the rack designer;
            Delete removes the PLACEMENT only (the rack stays in the lists below). */}
        {editMode && selectedRack && selectedRack.x != null && selectedRack.y != null && (
          (() => {
            const c = normToScreen([selectedRack.x, selectedRack.y], identityView(imgW, imgH));
            const left = view.panX + c.x * view.zoom;
            const top = view.panY + c.y * view.zoom;
            return (
              <div
                data-testid="rack-actions-popover"
                className="pointer-events-auto absolute z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-neutral-200 bg-white p-1 shadow-md"
                style={{ left, top: top - 26 }}
              >
                <button
                  type="button"
                  data-testid="rack-action-edit"
                  title="Open in rack designer"
                  onClick={() => router.push(`/racks/${selectedRack.id}`)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100"
                >
                  <Icon icon="tabler:pencil" width={17} height={17} />
                </button>
                <button
                  type="button"
                  data-testid="rack-action-delete"
                  title="Remove from plan"
                  onClick={() => void deleteRackPlacement(selectedRack.id)}
                  className="flex h-8 w-8 items-center justify-center rounded-md text-red-600 hover:bg-red-50"
                >
                  <Icon icon="tabler:trash" width={17} height={17} />
                </button>
              </div>
            );
          })()
        )}
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
