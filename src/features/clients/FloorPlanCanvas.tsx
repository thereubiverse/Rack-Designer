"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "@iconify/react";
import { IconButton } from "./IconButton";
import type { FloorPlanRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import { resolveTypeIcon, resolveTypeColor } from "@/features/device-library/deviceTypeIcons";
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
  createFloorDeviceAction,
  createRoomAction,
} from "./actions";
import { discoverRoomsAction, discoverDevicesAction } from "./discoverActions";
import type { RoomProposal, DeviceProposal } from "./planDetect";
import { planDeviceCommit, planRoomCommit } from "./planProposals";
import { ProposalPanel } from "./ProposalPanel";

// A press that travels less than this counts as a tap (select), not a pan. Enough to absorb the
// pointer drift every physical click carries, small enough that a deliberate pan never selects.
const TAP_THRESHOLD_PX = 6;
// jsdom has no ResizeObserver (feature-detected below), so tests always land here — fixed numbers
// keep the fit-on-mount deterministic instead of depending on whatever jsdom's default (0-size)
// container measures as. The pane now FILLS its container (its real height is measured at runtime),
// so these are only the jsdom fallbacks.
const FALLBACK_PANE_WIDTH = 870;
const FALLBACK_PANE_HEIGHT = 560;

const ZOOM_MAX = 8;
const ZOOM_MIN_FACTOR = 0.5; // the floor is fit * this factor, not an absolute number

// Fit-to-area easing — the SAME transition the rack designer's Fit toggle uses
// (transform 340ms cubic-bezier(0.2, 0, 0, 1)), so the plan glides to the fitted view instead of
// snapping. The rack canvas gets this from a CSS transition on its DOM transform; the plan's
// transform is an SVG attribute driven by React state, so we tween the state itself with the same
// curve. `cubicBezier` returns the standard progress-remap y(x) for two control points, solved for
// t via a few Newton-Raphson steps (with a bisection fallback) — identical shape to the CSS timing.
const FIT_ANIM_MS = 340;
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const solveX = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-4) return t;
      const d = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 20; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-4) break;
      if (err > 0) hi = t; else lo = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (t: number) => sampleY(solveX(t));
}
const FIT_EASE = cubicBezier(0.2, 0, 0, 1);

// Wheel-zoom sensitivity, split by gesture. A macOS trackpad pinch arrives as a wheel event with
// ctrlKey set; its accumulated deltaY tracks the two-finger spread, so feeding it through
// exp(-deltaY * k) at k ~= 0.01 makes the zoom follow the fingers close to 1:1 — the direct,
// "as sensitive as a tablet" feel. K_SCROLL is deliberately far gentler: a scroll-wheel notch or
// a two-finger drag reports large deltas, and matching pinch's k there would tear through several
// zoom levels on one flick.
const K_SCROLL = 0.0015;
const K_PINCH = 0.01;

// A native double-click gesture delivers click, click, THEN dblclick — each `click` appends a
// draw point before `dblclick` ever commits — so a dblclick-close's raw drawPoints always carries
// a trailing duplicate. dedupePolygon (called once, in commitDrawnRoom, for BOTH the Enter and
// dblclick closing paths) collapses that; this is its distance threshold in normalized space.
const POLYGON_DEDUPE_EPSILON = 1e-3;

// Vertex snapping while tracing: a trace point within this many SCREEN pixels of an existing room's
// vertex jumps to it exactly, so rooms that share a wall meet on the same corners at any zoom.
const SNAP_PX = 12;

const ROOM_FILL = "rgb(59 130 246 / 0.10)";
const ROOM_STROKE = "#2563eb";

// AI proposals are drawn in amber, dashed — deliberately NOT the committed blue, so a glance at the
// plan separates "this is on the floor" from "the model thinks this is on the floor".
const PROPOSAL_FILL = "rgb(245 158 11 / 0.12)";
// The same amber, deepened, for the proposed room whose outline is being reshaped.
const PROPOSAL_FILL_ACTIVE = "rgb(245 158 11 / 0.24)";
const PROPOSAL_STROKE = "#d97706";

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
  glyphScale,
  typeName,
  icon,
  color,
  editMode,
  selected,
  dragPoint,
  onPointerDownPin,
}: {
  device: FloorDeviceRow;
  imgW: number;
  imgH: number;
  /** Constant scale for the pin glyph (1 / fit-zoom): the pin looks its design size at the fitted
   *  view and then scales WITH the plan as the user zooms, instead of staying screen-constant. */
  glyphScale: number;
  typeName: string;
  icon: string;
  /** Pin fill, colour-coded by device type. */
  color: string;
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

  return (
    // The OUTER group's transform is exactly translate(anchor) — nothing else — so a test can
    // hand-compute the expected string from normToScreen(p, identityView) alone, independent of
    // the live zoom. The counter-scale lives on the INNER group instead (see the comment on
    // FloorPlanCanvas for why the split exists).
    <g
      className="plan-pin-group"
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
      <g transform={`scale(${glyphScale})`}>
        <title>{typeName}</title>
        {selected && (
          <circle r={14} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="3 2" />
        )}
        <circle r={10} fill={color} />
        {/* The type's icon, white, centred in the pin. Iconify renders a nested <svg>; the wrapping
            group positions it so its 13x13 box is centred on the pin's origin. */}
        <g transform="translate(-6.5 -6.5)" style={{ pointerEvents: "none" }}>
          <Icon icon={icon} width={13} height={13} color="#ffffff" />
        </g>
        <text
          className="plan-pin-label"
          x={0}
          y={-15}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#171717"
          style={{ pointerEvents: "none" }}
        >
          {device.code}
        </text>
      </g>
    </g>
  );
}

/** A placed rack: a square marker (distinct from the round device pins) carrying the rack code.
 *  Like a device pin, it owns its pointer-down: a press with no travel selects it (popover), a
 *  drag moves it. `dragPoint`, when present, is a LIVE drag preview only — the committed move uses
 *  the pointer-up position computed fresh. */
function RackMarker({
  rack,
  imgW,
  imgH,
  glyphScale,
  color,
  icon,
  editMode,
  selected,
  dragPoint,
  onPointerDownRack,
}: {
  rack: SiteRackRow;
  imgW: number;
  imgH: number;
  /** Constant scale for the marker glyph (1 / fit-zoom) — scales with the plan on zoom, like pins. */
  glyphScale: number;
  /** Fill + glyph from the "Rack" device type (customisable), or its built-in default. */
  color: string;
  icon: string;
  editMode?: boolean;
  selected?: boolean;
  dragPoint?: NormPoint | null;
  onPointerDownRack?: (e: React.PointerEvent, rackId: string) => void;
}) {
  const p: NormPoint = dragPoint ?? [rack.x as number, rack.y as number];
  const anchor = normToScreen(p, identityView(imgW, imgH));
  return (
    <g
      className="plan-pin-group"
      data-testid={`plan-rack-${rack.code}`}
      transform={`translate(${anchor.x} ${anchor.y})`}
      // Owns its pointer-down (stopPropagation), or a drag on it would pan the canvas via the
      // SVG root's own onPointerDown — the same contract the device pins keep.
      onPointerDown={
        editMode
          ? (e) => {
              e.stopPropagation();
              onPointerDownRack?.(e, rack.id);
            }
          : undefined
      }
      onClick={editMode ? (e) => e.stopPropagation() : undefined}
      style={editMode ? { cursor: "grab" } : undefined}
    >
      <g transform={`scale(${glyphScale})`}>
        <title>Rack {rack.code}</title>
        {selected && (
          <rect x={-12} y={-12} width={24} height={24} rx={6} fill="none" stroke="#2563eb" strokeWidth={2} strokeDasharray="3 2" />
        )}
        <rect x={-9} y={-9} width={18} height={18} rx={4} fill={color} />
        {/* The rack (server) glyph, white, centred in the square. */}
        <g transform="translate(-6 -6)" style={{ pointerEvents: "none" }}>
          <Icon icon={icon} width={12} height={12} color="#ffffff" />
        </g>
        <text
          className="plan-pin-label"
          x={0}
          y={-15}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="#171717"
          style={{ pointerEvents: "none" }}
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
/** Imperative starts for the create-by-geometry flows, so the plan toolbar (owned by SiteDetail)
 *  can kick off tracing a brand-new room or placing a brand-new device without the canvas needing
 *  to know about the modals those flows finish in. */
export interface FloorPlanCanvasHandle {
  startTraceRoom: () => void;
  startPlaceDevice: () => void;
}

interface FloorPlanCanvasProps {
  plan: FloorPlanRow;
  planUrl: string;
  rooms: RoomRow[];
  devices: FloorDeviceRow[];
  racks: SiteRackRow[];
  deviceTypes: DeviceTypeRow[];
  editable: boolean;
  /** Plan-level controls (Replace / Delete plan) rendered into the pane's top-left toolbar,
   *  beneath the Edit-layout toggle. Supplied by SiteDetail because it owns the upload pipeline and
   *  the delete-confirm dialog; kept out of the canvas so the same controls stay reachable in the
   *  plan-unavailable recovery state where no canvas renders. */
  planTools?: ReactNode;
  /** Fired once when a brand-new room outline is finished (Enter / double-click). The canvas has no
   *  room id yet — SiteDetail opens the naming modal and creates + outlines the room on submit. */
  onRoomTraced?: (polygon: NormPoint[]) => void;
  /** Fired once when a brand-new device is dropped on the plan. SiteDetail knows the chosen type
   *  and opens the details modal, creating + placing the device on submit. */
  onDevicePlaced?: (point: NormPoint) => void;
}

export const FloorPlanCanvas = forwardRef<FloorPlanCanvasHandle, FloorPlanCanvasProps>(
  function FloorPlanCanvas(
    { plan, planUrl, rooms, devices, racks, deviceTypes, editable, planTools, onRoomTraced, onDevicePlaced },
    ref
  ) {
  const imgW = plan.width_px;
  const imgH = plan.height_px;

  const paneRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const fitZoomRef = useRef(1);
  const [view, setView] = useState<LiveView>({ panX: 0, panY: 0, zoom: 1 });
  const [paneW, setPaneW] = useState(FALLBACK_PANE_WIDTH);
  const [paneH, setPaneH] = useState(FALLBACK_PANE_HEIGHT);
  // The pre-fit view the Fit button remembers, so a second click returns to it (toggle). Null when
  // the button will fit; set to the captured view when the button will restore. Any manual pan/zoom
  // clears it, so the toggle only pairs a fit with an immediately-following restore.
  const [returnView, setReturnView] = useState<LiveView | null>(null);
  // Latest view, readable synchronously — the fit tween needs its start point without waiting for a
  // re-render, and it must not go stale between animation frames.
  const viewRef = useRef(view);
  viewRef.current = view;

  // Handle of the in-flight fit-to-area tween (rAF id), so a new fit or any manual pan/zoom can
  // cancel it cleanly instead of fighting it frame-by-frame.
  const fitAnimRef = useRef<number | null>(null);
  const cancelFitAnim = useCallback(() => {
    if (fitAnimRef.current != null) {
      cancelAnimationFrame(fitAnimRef.current);
      fitAnimRef.current = null;
    }
  }, []);
  // Ease the view from wherever it is now to `target` over FIT_ANIM_MS with the shared fit curve.
  const animateViewTo = useCallback((target: LiveView) => {
    cancelFitAnim();
    if (typeof requestAnimationFrame === "undefined") { setView(target); return; }
    const start = viewRef.current;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / FIT_ANIM_MS);
      const e = FIT_EASE(p);
      setView({
        zoom: start.zoom + (target.zoom - start.zoom) * e,
        panX: start.panX + (target.panX - start.panX) * e,
        panY: start.panY + (target.panY - start.panY) * e,
      });
      fitAnimRef.current = p < 1 ? requestAnimationFrame(step) : null;
    };
    fitAnimRef.current = requestAnimationFrame(step);
  }, [cancelFitAnim]);

  // Stop any in-flight fit tween if the canvas unmounts (e.g. switching floors) so its rAF callback
  // can't fire setView after teardown.
  useEffect(() => cancelFitAnim, [cancelFitAnim]);

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
    const fit = (w: number, h: number) => {
      const z = Math.min(w / imgW, h / imgH);
      fitZoomRef.current = z;
      setView({ zoom: z, panX: (w - imgW * z) / 2, panY: (h - imgH * z) / 2 });
    };
    if (typeof ResizeObserver === "undefined") {
      setPaneW(FALLBACK_PANE_WIDTH);
      setPaneH(FALLBACK_PANE_HEIGHT);
      fit(FALLBACK_PANE_WIDTH, FALLBACK_PANE_HEIGHT);
      return;
    }
    // Keep paneW/paneH current on every resize (the pane fills a viewport-sized container now, so
    // it changes with the window), but FIT only on the first real measurement — a later resize must
    // not clobber the user's own pan/zoom.
    let fitted = false;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r || !r.width || !r.height) return;
      setPaneW(r.width);
      setPaneH(r.height);
      if (!fitted) {
        fitted = true;
        fit(r.width, r.height);
      }
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
    cancelFitAnim();
    setReturnView(null);
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
  }, [clampZoom, cancelFitAnim]);

  // Reset the view to fit the whole plan in the pane and centre it — the same math the fit-on-mount
  // effect runs, but on demand. Uses the last-measured pane width so it tracks the current layout.
  const fitToArea = useCallback(() => {
    // Toggle: a click while a pre-fit view is remembered restores it instead of re-fitting.
    if (returnView) {
      animateViewTo(returnView);
      setReturnView(null);
      return;
    }
    const before = viewRef.current;
    const z = Math.min(paneW / imgW, paneH / imgH);
    const target = { zoom: z, panX: (paneW - imgW * z) / 2, panY: (paneH - imgH * z) / 2 };
    fitZoomRef.current = z;
    animateViewTo(target);
    // Arm the restore only if fitting actually moved the view — if we're already at the fit, there's
    // nothing meaningful to return to and the next click should just fit again.
    const moved =
      Math.abs(before.zoom - z) > 1e-3 ||
      Math.abs(before.panX - target.panX) > 0.5 ||
      Math.abs(before.panY - target.panY) > 0.5;
    setReturnView(moved ? before : null);
  }, [returnView, paneW, paneH, imgW, imgH, animateViewTo]);

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
  // When on, pin/rack code labels are hidden until that marker is hovered (declutters a busy plan).
  const [labelsOnHover, setLabelsOnHover] = useState(false);

  // ---- Tray selection / active gesture mode (mutually exclusive) ----
  const [placingDeviceId, setPlacingDeviceId] = useState<string | null>(null);
  const [placingRackId, setPlacingRackId] = useState<string | null>(null);
  const [drawingRoomId, setDrawingRoomId] = useState<string | null>(null);
  // Create-by-geometry modes (no id yet): tracing a NEW room, or placing a NEW device. These run
  // independently of editMode — the plan toolbar kicks them off directly.
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [creatingDevice, setCreatingDevice] = useState(false);
  const [drawPoints, setDrawPoints] = useState<NormPoint[]>([]);
  const [hoverPoint, setHoverPoint] = useState<NormPoint | null>(null);
  // The existing-room vertex the cursor is currently snapping to (for the highlight ring), or null.
  const [snapTarget, setSnapTarget] = useState<NormPoint | null>(null);

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
  const [rackPreview, setRackPreview] = useState<{ rackId: string; point: NormPoint } | null>(null);
  const [vertexPreview, setVertexPreview] = useState<
    { roomId: string; index: number; point: NormPoint } | null
  >(null);

  // ---- AI discovery (read the plan image, propose rooms/devices) ----
  // Proposals live ONLY here: nothing below writes them to the database. They are ghosts drawn over
  // the committed layer until the user accepts one.
  const [proposals, setProposals] = useState<{ rooms: RoomProposal[]; devices: DeviceProposal[] }>({
    rooms: [],
    devices: [],
  });
  const [wizardOpen, setWizardOpen] = useState(false);
  const [discovering, setDiscovering] = useState<null | "rooms" | "devices">(null);
  // Either a pass-outcome sentinel the notice renders specially ("no-key" from the action, or the
  // local "none-found"), or an error string to show verbatim.
  const [wizardNotice, setWizardNotice] = useState<string | null>(null);
  // The room proposal whose vertex handles are showing — the ghost equivalent of editingRoomId, so
  // a plain review can't be fumbled into an accidental reshape.
  const [proposalRoomEditId, setProposalRoomEditId] = useState<string | null>(null);
  const [selectedProposalVertex, setSelectedProposalVertex] = useState<
    { roomId: string; index: number } | null
  >(null);
  // True for the duration of an accept (single or batch): every commit control disables, so a
  // double-click can't create the same device twice.
  const [accepting, setAccepting] = useState(false);
  // Ghost drags. Unlike the committed pin/vertex drags there is nothing to commit on pointer-up —
  // a ghost moves in STATE as the pointer moves. They still carry the press origin and a `moved`
  // flag so a plain select-click's pointer drift can't nudge the geometry (same TAP_THRESHOLD_PX
  // contract the committed drags use).
  const proposalPinDragRef = useRef<
    { id: string; startX: number; startY: number; moved: boolean } | null
  >(null);
  const proposalVertexDragRef = useRef<
    { roomId: string; index: number; startX: number; startY: number; moved: boolean } | null
  >(null);
  // The wizard menu's anchor, so a press anywhere else can close the menu.
  const wizardRef = useRef<HTMLSpanElement | null>(null);

  // Rows this component has created since the `devices`/`rooms` props last refreshed. The decision
  // layer MUST see them: planDeviceCommit falls through to a GENERATED code whenever the label is
  // empty or isn't a clean code (a label with a space qualifies), which is ordinary output from a
  // plan pass — so two such proposals accepted before a refresh lands would generate the very same
  // code and the second create would die on the site-unique constraint. That is not a batch-only
  // hazard: `devices` stays stale until router.refresh() round-trips, so two single Accepts clicked
  // back to back collide the same way. planRoomCommit generates room codes the same way, hence the
  // room list too. Each prop change means the refresh landed and the prop is authoritative again.
  // Pruned by CONTENT, never by prop identity: SiteDetail derives these lists with an unmemoized
  // .filter(), so any unrelated re-render there hands down a fresh array holding the SAME stale
  // rows. Clearing on identity would drop the pending rows while the props still lack them — the
  // collision, re-armed. Each row drops exactly when the refreshed prop actually contains it.
  const pendingDevicesRef = useRef<FloorDeviceRow[]>([]);
  const pendingRoomsRef = useRef<RoomRow[]>([]);
  useEffect(() => {
    pendingDevicesRef.current = pendingDevicesRef.current.filter(
      (p) => !devices.some((d) => d.id === p.id)
    );
  }, [devices]);
  useEffect(() => {
    pendingRoomsRef.current = pendingRoomsRef.current.filter((p) => !rooms.some((r) => r.id === p.id));
  }, [rooms]);

  // The accept helpers below can outlive the render they were created in — a batch awaits a server
  // round-trip per proposal, and a refresh landing mid-batch re-renders underneath it. Reading the
  // lists through refs means each decision sees the LATEST props plus the surviving pending rows,
  // instead of whatever was in scope when the batch started.
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;

  // Proposals are per-floor and must never survive a floor switch. SiteDetail keys this component
  // by the active floor id, so a switch remounts it and the state is fresh anyway — this makes the
  // lifecycle explicit here rather than depending on another file's prop for correctness. The ref
  // guard keeps mount itself a no-op (it only fires when the floor actually CHANGES).
  const proposalFloorRef = useRef(plan.floor_id);
  useEffect(() => {
    if (proposalFloorRef.current === plan.floor_id) return;
    proposalFloorRef.current = plan.floor_id;
    setProposals({ rooms: [], devices: [] });
    setProposalRoomEditId(null);
    setSelectedProposalVertex(null);
    setWizardNotice(null);
    // The pending rows go too: they are pruned by CONTENT against this floor's props, so one left
    // over from the previous floor could never be pruned again — and could match a proposal here
    // into a PLACE against another floor's device.
    pendingDevicesRef.current = [];
    pendingRoomsRef.current = [];
  }, [plan.floor_id]);

  // Esc / outside-press closes the wizard menu. Deliberately its OWN effect, not a branch of the
  // gesture keydown handler below: that one is gated on edit/create mode, and the wizard opens
  // outside both.
  useEffect(() => {
    if (!wizardOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setWizardOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (!wizardRef.current?.contains(e.target as Node)) setWizardOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [wizardOpen]);

  /** Run one discovery pass and park its proposals in state. Never throws: the actions return
   *  `{ ok: false, error }` for every failure, including the "no-key" sentinel. */
  async function runDiscovery(kind: "rooms" | "devices") {
    // Never while an accept is in flight: proposal ids are index-based, so a pass landing mid-accept
    // could hand a freshly staged proposal the id the accept is about to drop.
    if (accepting) return;
    setWizardOpen(false);
    setWizardNotice(null);
    // Proposal ids are per-pass and index-based ("room-0"), so a re-run can hand the SAME id to a
    // different shape. Drop the geometry selections rather than let them re-point silently.
    setProposalRoomEditId(null);
    setSelectedProposalVertex(null);
    setDiscovering(kind);
    try {
      if (kind === "rooms") {
        const res = await discoverRoomsAction(plan.floor_id);
        if (!res.ok) {
          setWizardNotice(res.error);
          return;
        }
        setProposals((p) => ({ ...p, rooms: res.proposals }));
        if (res.proposals.length === 0) setWizardNotice("none-found");
      } else {
        const res = await discoverDevicesAction(plan.floor_id);
        if (!res.ok) {
          setWizardNotice(res.error);
          return;
        }
        setProposals((p) => ({ ...p, devices: res.proposals }));
        if (res.proposals.length === 0) setWizardNotice("none-found");
      }
    } finally {
      setDiscovering(null);
    }
  }

  // ---- Proposal editing (state ONLY — nothing below this line touches the database) ----
  /** The types a floor device can be. A proposal carries a type CODE; the create action needs the
   *  matching type's ID, and the panel's select offers exactly these. */
  const floorDeviceTypes = deviceTypes.filter((t) => t.category === "floor");

  function editDeviceProposal(id: string, patch: Partial<DeviceProposal>) {
    setProposals((p) => ({
      ...p,
      devices: p.devices.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    }));
  }

  function editRoomProposal(id: string, patch: Partial<RoomProposal>) {
    setProposals((p) => ({
      ...p,
      rooms: p.rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  }

  function dropDevice(id: string) {
    setProposals((p) => ({ ...p, devices: p.devices.filter((d) => d.id !== id) }));
  }

  function dropRoom(id: string) {
    setProposals((p) => ({ ...p, rooms: p.rooms.filter((r) => r.id !== id) }));
    // A dropped room can't stay the one being outline-edited, nor own a selected vertex.
    setProposalRoomEditId((cur) => (cur === id ? null : cur));
    setSelectedProposalVertex((cur) => (cur?.roomId === id ? null : cur));
  }

  function moveProposalVertex(roomId: string, index: number, point: NormPoint) {
    setProposals((p) => ({
      ...p,
      rooms: p.rooms.map((r) =>
        r.id === roomId ? { ...r, polygon: r.polygon.map((pt, i) => (i === index ? point : pt)) } : r
      ),
    }));
  }

  /** Midpoint insert on a proposed room's edge — the same geometry the committed rooms use, just
   *  written back into proposal state instead of the database. */
  function insertProposalVertex(roomId: string, edgeIndex: number) {
    setProposals((p) => ({
      ...p,
      rooms: p.rooms.map((r) =>
        r.id === roomId ? { ...r, polygon: insertVertexOnEdge(r.polygon, edgeIndex) } : r
      ),
    }));
  }

  function deleteSelectedProposalVertex() {
    const sel = selectedProposalVertex;
    if (!sel) return;
    setProposals((p) => ({
      ...p,
      rooms: p.rooms.map((r) => {
        if (r.id !== sel.roomId) return r;
        const next = removeVertex(r.polygon, sel.index);
        // removeVertex hands the SAME array back when it refuses (below 3 vertices) — that
        // reference equality is how a refusal is told apart from a real removal.
        return next === r.polygon ? r : { ...r, polygon: next };
      }),
    }));
    setSelectedProposalVertex(null);
  }

  // ---- Accepting a proposal (the only place a proposal reaches the database) ----
  /** Returns the error message if this proposal could not be committed, else null. The message is
   *  also shown immediately; the batch below re-shows the FIRST one at the end, so a later success
   *  (which clears the error) can't swallow it. */
  async function acceptDevice(dp: DeviceProposal): Promise<string | null> {
    const decision = planDeviceCommit(dp, [...devicesRef.current, ...pendingDevicesRef.current]);
    if (decision.kind === "duplicate") {
      // The code is site-unique and the matched device is already on the plan: there is nothing to
      // commit, so the proposal just goes away with an explanation.
      const message = `${dp.label} is already on the plan.`;
      dropDevice(dp.id);
      setError(message);
      return message;
    }
    if (decision.kind === "place") {
      const failure = await commitPlaceDevice(decision.deviceId, dp.point);
      // A failure keeps the proposal staged — nothing was created, so a retry is harmless.
      if (!failure) dropDevice(dp.id);
      return failure;
    }
    const type = floorDeviceTypes.find((t) => t.code === dp.typeCode);
    if (!type) {
      const message = `No device type "${dp.typeCode}" on this site.`;
      setError(message);
      return message;
    }
    const fd = new FormData();
    fd.set("floorId", plan.floor_id);
    fd.set("roomId", "");
    fd.set("deviceTypeId", type.id);
    fd.set("code", decision.code);
    fd.set("name", "");
    fd.set("status", "planned");
    const res = await createFloorDeviceAction(fd);
    if (!res.ok || !res.id) {
      const message = res.error ?? "Failed to create device";
      setError(message);
      return message;
    }
    // Record the row the moment it exists, BEFORE the placement that can fail: the code is taken
    // either way, so the next accept must generate around it.
    pendingDevicesRef.current = [
      ...pendingDevicesRef.current,
      {
        id: res.id,
        site_id: devicesRef.current[0]?.site_id ?? "",
        floor_id: plan.floor_id,
        room_id: null,
        device_type_id: type.id,
        code: decision.code,
        name: "",
        status: "planned",
        created_at: "",
        updated_at: "",
        // Unplaced until the placement below succeeds — and if it doesn't, this row is exactly the
        // "existing but unplaced" case the decision layer should PLACE rather than re-create.
        x: null,
        y: null,
      },
    ];
    const failure = await commitPlaceDevice(res.id, dp.point);
    if (!failure) {
      pendingDevicesRef.current = pendingDevicesRef.current.map((d) =>
        d.id === res.id ? { ...d, x: dp.point[0], y: dp.point[1] } : d
      );
    }
    // The device row EXISTS now, so the proposal is dropped either way: leaving it staged would
    // invite a second create (the props here are still pre-refresh, so the retry wouldn't match
    // the row it just made and the site-unique code would reject it). A failed placement instead
    // leaves an UNPLACED device in the tray and says so.
    dropDevice(dp.id);
    if (failure) {
      const message = `${decision.code} was created but couldn't be placed — drag it on from the tray. (${failure})`;
      setError(message);
      router.refresh();
      return message;
    }
    return null;
  }

  async function acceptRoom(rp: RoomProposal): Promise<string | null> {
    const decision = planRoomCommit(rp, [...roomsRef.current, ...pendingRoomsRef.current]);
    if (decision.kind === "attach") {
      const failure = await commitRoomPolygon(decision.roomId, rp.polygon);
      if (!failure) dropRoom(rp.id);
      return failure;
    }
    const fd = new FormData();
    fd.set("floorId", plan.floor_id);
    fd.set("code", decision.code);
    fd.set("name", rp.name);
    fd.set("type", rp.roomType);
    const res = await createRoomAction(fd);
    if (!res.ok || !res.id) {
      const message = res.error ?? "Failed to create room";
      setError(message);
      return message;
    }
    // Same as acceptDevice: the code is taken from here on, so record the row before the outline
    // that can fail. Left polygon-less until it succeeds, which is what makes a re-accept of the
    // same name ATTACH to this row instead of creating a second one.
    pendingRoomsRef.current = [
      ...pendingRoomsRef.current,
      {
        id: res.id,
        floor_id: plan.floor_id,
        code: decision.code,
        name: rp.name,
        type: rp.roomType,
        created_at: "",
        plan_polygon: null,
      },
    ];
    const failure = await commitRoomPolygon(res.id, rp.polygon);
    if (!failure) {
      pendingRoomsRef.current = pendingRoomsRef.current.map((r) =>
        r.id === res.id ? { ...r, plan_polygon: rp.polygon } : r
      );
    }
    // Same reasoning as acceptDevice: the room row exists, so the proposal always goes.
    dropRoom(rp.id);
    if (failure) {
      const message = `${decision.code} was created but its outline couldn't be saved — trace it from the tray. (${failure})`;
      setError(message);
      router.refresh();
      return message;
    }
    return null;
  }

  /** Accept every staged proposal, one at a time. Sequential, never Promise.all: each accept writes
   *  rows the next one's matching depends on (see pendingDevicesRef), and two placements racing on
   *  the same refresh is not worth the millisecond. A failure leaves ONLY its own proposal staged
   *  and never aborts the batch. */
  async function acceptAll() {
    if (accepting) return;
    setAccepting(true);
    let firstError: string | null = null;
    try {
      for (const rp of proposals.rooms) {
        const failure = await acceptRoom(rp);
        firstError ??= failure;
      }
      for (const dp of proposals.devices) {
        const failure = await acceptDevice(dp);
        firstError ??= failure;
      }
    } finally {
      setAccepting(false);
    }
    // A later success calls setError(null); re-show the first failure so the batch can't end quiet.
    if (firstError) setError(firstError);
  }

  /** One-proposal accept: the same guard as the batch, so a double-click can't double-commit. */
  async function acceptOne(run: () => Promise<string | null>) {
    if (accepting) return;
    setAccepting(true);
    try {
      await run();
    } finally {
      setAccepting(false);
    }
  }

  function dismissAll() {
    setProposals({ rooms: [], devices: [] });
    setProposalRoomEditId(null);
    setSelectedProposalVertex(null);
  }

  // Pointer-drag panning over empty plan space, via pointer capture so the drag keeps tracking
  // even if the cursor leaves the SVG mid-gesture.
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number; roomId: string | null } | null>(null);
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
  // Rack-move drag: same shape/contract as pinDragRef.
  const rackDragRef = useRef<{ rackId: string; moved: boolean; clientX: number; clientY: number } | null>(null);
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

  // Candidate snap points: every vertex of every OTHER outlined room on this floor. The room being
  // re-outlined (drawingRoomId) is excluded so a trace never snaps to its own corners; a brand-new
  // room (creatingRoom) has no id, so nothing is excluded.
  const snapVertices: NormPoint[] = [];
  for (const r of rooms) {
    if (!r.plan_polygon) continue;
    if (drawingRoomId && r.id === drawingRoomId) continue;
    for (const p of r.plan_polygon) snapVertices.push(p);
  }

  // Everything below measures distance in SCREEN space (norm * imgDim * zoom) so the magnet feels
  // the same at any zoom, and projects onto walls with the correct visual perpendicular (the plan is
  // wider than tall, so normalized space is anisotropic). Pan is a constant offset and cancels out.
  const toScreenX = (nx: number) => nx * imgW * view.zoom;
  const toScreenY = (ny: number) => ny * imgH * view.zoom;

  /** Nearest existing-room vertex within SNAP_PX screen pixels of `n`, or null. */
  function snapToVertex(n: NormPoint): NormPoint | null {
    let best: NormPoint | null = null;
    let bestDist = SNAP_PX;
    for (const v of snapVertices) {
      const dist = Math.hypot(toScreenX(v[0] - n[0]), toScreenY(v[1] - n[1]));
      if (dist < bestDist) {
        bestDist = dist;
        best = v;
      }
    }
    return best;
  }

  /** Nearest point ON an existing-room wall within SNAP_PX, or null — lets a trace drop a NEW point
   *  onto a shared wall between its corners. Same room exclusion as vertices. */
  function snapToEdge(n: NormPoint): NormPoint | null {
    const px = toScreenX(n[0]);
    const py = toScreenY(n[1]);
    let best: NormPoint | null = null;
    let bestDist = SNAP_PX;
    for (const r of rooms) {
      if (!r.plan_polygon) continue;
      if (drawingRoomId && r.id === drawingRoomId) continue;
      const poly = r.plan_polygon;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length]; // wrap: the closing wall counts too
        const ax = toScreenX(a[0]);
        const ay = toScreenY(a[1]);
        const bx = toScreenX(b[0]);
        const by = toScreenY(b[1]);
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        // Project the cursor onto the segment, clamped to its endpoints.
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        const dist = Math.hypot(px - cx, py - cy);
        if (dist < bestDist) {
          bestDist = dist;
          best = [cx / (imgW * view.zoom), cy / (imgH * view.zoom)];
        }
      }
    }
    return best;
  }

  /** Snap a traced point: prefer an exact existing corner, else a point on an existing wall. */
  function snapPoint(n: NormPoint): NormPoint | null {
    return snapToVertex(n) ?? snapToEdge(n);
  }

  // ---- Action commits — each is called exactly once per completed gesture ----
  /** Returns the error message on failure (already shown), or null on success — so an accept can
   *  chain on the outcome. Gesture callers ignore the value and rely on the setError above. */
  async function commitPlaceDevice(id: string, point: NormPoint): Promise<string | null> {
    const fd = new FormData();
    fd.set("id", id);
    fd.set("x", String(point[0]));
    fd.set("y", String(point[1]));
    const res = await placeFloorDeviceAction(fd);
    if (!res.ok) {
      const message = res.error ?? "Failed to place device";
      setError(message);
      return message;
    }
    setError(null);
    router.refresh();
    return null;
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

  /** Same contract as commitPlaceDevice: the error message, or null on success. */
  async function commitRoomPolygon(roomId: string, polygon: NormPoint[]): Promise<string | null> {
    const fd = new FormData();
    fd.set("roomId", roomId);
    fd.set("polygon", JSON.stringify(polygon));
    const res = await setRoomPolygonAction(fd);
    if (!res.ok) {
      const message = res.error ?? "Failed to save room outline";
      setError(message);
      return message;
    }
    setError(null);
    router.refresh();
    return null;
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
    setSnapTarget(null);
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
    if (drawingRoomId || creatingRoom) {
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

  // ---- Create-by-geometry (started from the plan toolbar via the imperative handle) ----
  /** Reset every selection/gesture so a fresh create mode starts from a clean slate. */
  function clearAllGestures() {
    setPlacingDeviceId(null);
    setPlacingRackId(null);
    setDrawingRoomId(null);
    setDrawPoints([]);
    setHoverPoint(null);
    setSnapTarget(null);
    setSelectedPinId(null);
    setSelectedRackId(null);
    setSelectedVertex(null);
    clearRoomSelection();
  }

  function startTraceRoom() {
    clearAllGestures();
    setCreatingDevice(false);
    setCreatingRoom(true);
  }

  function startPlaceDevice() {
    clearAllGestures();
    setCreatingRoom(false);
    setCreatingDevice(true);
  }

  useImperativeHandle(ref, () => ({ startTraceRoom, startPlaceDevice }));

  /** Close a brand-new room trace (Enter / double-click) and hand the outline up. Mirrors
   *  commitDrawnRoom's dedupe-then-min-3 guard, but there's no room to persist to yet. */
  function finishTracedRoom() {
    const deduped = dedupePolygon(drawPoints, POLYGON_DEDUPE_EPSILON);
    if (deduped.length < 3) return;
    setCreatingRoom(false);
    setDrawPoints([]);
    setHoverPoint(null);
    setSnapTarget(null);
    onRoomTraced?.(deduped);
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


  // ---- Pin / vertex drag start (attached by the child shapes; both stopPropagation first) ----
  const onPinPointerDown = (e: React.PointerEvent, deviceId: string) => {
    if (e.button !== 0) return;
    setSelectedPinId(deviceId);
    setSelectedRackId(null);
    clearRoomSelection();
    setSelectedVertex(null);
    setSelectedProposalVertex(null);
    pinDragRef.current = { deviceId, moved: false, clientX: e.clientX, clientY: e.clientY };
  };

  // A rack press selects it immediately (so a no-move release just shows the popover) and arms a
  // drag; the move only commits on pointer-up, and only if it actually moved.
  const onRackPointerDown = (e: React.PointerEvent, rackId: string) => {
    if (e.button !== 0) return;
    setSelectedRackId(rackId);
    setSelectedPinId(null);
    clearRoomSelection();
    setSelectedVertex(null);
    rackDragRef.current = { rackId, moved: false, clientX: e.clientX, clientY: e.clientY };
  };

  // ---- Ghost (proposal) drag start. Same stopPropagation contract as the committed shapes — a
  // ghost drag must never also pan the canvas — but nothing is ever committed: the drag rewrites
  // proposal state as it moves, and pointer-up just forgets it.
  const onProposalPinPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    proposalPinDragRef.current = { id, startX: e.clientX, startY: e.clientY, moved: false };
  };

  const onProposalVertexPointerDown = (e: React.PointerEvent, roomId: string, index: number) => {
    if (e.button !== 0) return;
    // Selections stay mutually exclusive, so Delete can never be ambiguous.
    setSelectedPinId(null);
    setSelectedRackId(null);
    setSelectedVertex(null);
    setSelectedProposalVertex({ roomId, index });
    proposalVertexDragRef.current = { roomId, index, startX: e.clientX, startY: e.clientY, moved: false };
  };

  /** A ghost must NOT eat the click while a placement or trace gesture is running: those are aimed
   *  at the plan underneath, and the toolbar's create gestures deliberately run OUTSIDE edit mode
   *  (which is what keeps the committed pins from eating them — DevicePin only attaches its
   *  handlers when editMode is on). Ghosts have no such gate of their own, so this is it. */
  const ghostInteractive =
    !creatingDevice && !creatingRoom && !drawingRoomId && !placingDeviceId && !placingRackId;

  /** True once the press has travelled past the tap threshold — below it the gesture is a plain
   *  select-click and must not nudge the geometry by the drift every physical click carries. */
  function ghostDragEngaged(
    drag: { startX: number; startY: number; moved: boolean },
    clientX: number,
    clientY: number
  ) {
    if (!drag.moved && Math.hypot(clientX - drag.startX, clientY - drag.startY) < TAP_THRESHOLD_PX) {
      return false;
    }
    drag.moved = true;
    return true;
  }

  const onVertexPointerDown = (e: React.PointerEvent, roomId: string, index: number, polygon: NormPoint[]) => {
    if (e.button !== 0) return;
    setSelectedVertex({ roomId, index });
    setSelectedProposalVertex(null);
    setSelectedPinId(null);
    vertexDragRef.current = { roomId, index, polygon, moved: false, clientX: e.clientX, clientY: e.clientY };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    cancelFitAnim();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Remember whether this press landed on a room polygon, read straight off the DOM so it can't
    // desync from event ordering. Pins/vertices stopPropagation and never reach here.
    const roomEl = (e.target as Element).closest?.("[data-room-id]");
    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      panX: view.panX,
      panY: view.panY,
      roomId: roomEl?.getAttribute("data-room-id") ?? null,
    };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    // Ghost drags first: they write straight to proposal state (no preview layer, no commit).
    if (proposalPinDragRef.current) {
      const drag = proposalPinDragRef.current;
      if (!ghostDragEngaged(drag, e.clientX, e.clientY)) return;
      const n = toNorm(e.clientX, e.clientY);
      if (n) editDeviceProposal(drag.id, { point: n });
      return;
    }
    if (proposalVertexDragRef.current) {
      const drag = proposalVertexDragRef.current;
      if (!ghostDragEngaged(drag, e.clientX, e.clientY)) return;
      const n = toNorm(e.clientX, e.clientY);
      if (n) moveProposalVertex(drag.roomId, drag.index, n);
      return;
    }
    if (pinDragRef.current) {
      const drag = pinDragRef.current;
      drag.moved = true;
      drag.clientX = e.clientX;
      drag.clientY = e.clientY;
      const n = toNorm(e.clientX, e.clientY);
      if (n) setPinPreview({ deviceId: drag.deviceId, point: n });
      return;
    }
    if (rackDragRef.current) {
      const drag = rackDragRef.current;
      drag.moved = true;
      drag.clientX = e.clientX;
      drag.clientY = e.clientY;
      const n = toNorm(e.clientX, e.clientY);
      if (n) setRackPreview({ rackId: drag.rackId, point: n });
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
    if (drawingRoomId || creatingRoom) {
      const raw = toNorm(e.clientX, e.clientY);
      const snapped = raw ? snapPoint(raw) : null;
      setSnapTarget(snapped);
      setHoverPoint(snapped ?? raw);
    }
    const d = dragRef.current;
    if (!d) return;
    setReturnView(null);
    setView((v) => ({ ...v, panX: d.panX + (e.clientX - d.x), panY: d.panY + (e.clientY - d.y) }));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    // A finished ghost drag has nothing to commit — the proposal already holds its new geometry.
    // The pan bookkeeping is still torn down first: the ghost's own stopPropagation should have
    // kept the root's pointer-down from ever arming one, but returning early with a live dragRef
    // would leave the NEXT pointer move dragging the whole plan with no button held.
    if (proposalPinDragRef.current || proposalVertexDragRef.current) {
      proposalPinDragRef.current = null;
      proposalVertexDragRef.current = null;
      dragRef.current = null;
      // Guarded because releasing an UNKNOWN pointer id throws NotFoundError (releasing a merely
      // uncaptured one is a spec no-op), and this gesture normally never captured the pointer.
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      return;
    }
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
    if (rackDragRef.current) {
      const drag = rackDragRef.current;
      rackDragRef.current = null;
      setRackPreview(null);
      // Only a drag that moved commits a new position — a still press was a plain select.
      if (drag.moved) {
        const n = toNorm(drag.clientX, drag.clientY);
        if (n) void commitPlaceRack(drag.rackId, n);
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
    if (d && editMode && !placingDeviceId && !placingRackId && !drawingRoomId && !creatingRoom && !creatingDevice) {
      const travel = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (travel < TAP_THRESHOLD_PX) {
        // Pins and racks own their own pointer-down (they stopPropagation), so a tap that reaches
        // here landed on a room polygon or empty space.
        if (d.roomId) selectRoom(d.roomId);
        else {
          clearRoomSelection();
          setSelectedRackId(null);
        }
      }
    }
  };

  // Simple taps (not drags) — device placement and room-outline vertex clicks.
  function handleCanvasClick(e: React.MouseEvent<SVGSVGElement>) {
    // Create-by-geometry modes run without edit mode (started from the toolbar).
    if (creatingDevice) {
      const n = toNorm(e.clientX, e.clientY);
      if (!n) return;
      setCreatingDevice(false);
      onDevicePlaced?.(n);
      return;
    }
    if (creatingRoom) {
      const n = toNorm(e.clientX, e.clientY);
      if (!n) return;
      setDrawPoints((prev) => [...prev, snapPoint(n) ?? n]);
      return;
    }
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
      setDrawPoints((prev) => [...prev, snapPoint(n) ?? n]);
    }
  }

  function handleCanvasDoubleClick(e: React.MouseEvent<SVGSVGElement>) {
    if (creatingRoom) {
      if (drawPoints.length >= 3) {
        e.preventDefault();
        finishTracedRoom();
      }
      return;
    }
    if (!editMode || !drawingRoomId) return;
    if (drawPoints.length >= 3) {
      e.preventDefault();
      void commitDrawnRoom(drawingRoomId, drawPoints);
    }
  }

  // Keyboard: Enter closes a ≥3-point draw, Esc cancels the current gesture/selection cleanly,
  // Delete/Backspace un-places a selected pin or removes a selected vertex.
  useEffect(() => {
    // Active in edit mode AND during a toolbar-started create gesture (which runs outside it) AND
    // while a proposal vertex is selected (proposal review also runs outside edit mode).
    if (!editMode && !creatingRoom && !creatingDevice && !selectedProposalVertex) return;
    function onKeyDown(e: KeyboardEvent) {
      // Never steal a keystroke aimed at a text field. The proposal panel put the first inputs on
      // this screen, and they coexist with a selected ghost vertex — so without this, Backspace to
      // fix a typo in a proposal's name would silently delete a corner of its outline, and Esc
      // would drop the selection out from under the user.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "Escape") {
        setPlacingDeviceId(null);
        setPlacingRackId(null);
        setDrawingRoomId(null);
        setCreatingRoom(false);
        setCreatingDevice(false);
        setDrawPoints([]);
        setHoverPoint(null);
        setSnapTarget(null);
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
        rackDragRef.current = null;
        vertexDragRef.current = null;
        setPinPreview(null);
        setRackPreview(null);
        setVertexPreview(null);
        // Ghost drags too: they write to proposal state on every move, so an in-flight one must be
        // let go rather than continuing to follow the pointer after Esc.
        proposalPinDragRef.current = null;
        proposalVertexDragRef.current = null;
        setSelectedProposalVertex(null);
        return;
      }
      if (e.key === "Enter") {
        if (creatingRoom && drawPoints.length >= 3) {
          finishTracedRoom();
          return;
        }
        if (drawingRoomId && drawPoints.length >= 3) {
          void commitDrawnRoom(drawingRoomId, drawPoints);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // A selected ghost vertex wins: selecting one clears the committed selections anyway, and
        // it's the only selection that can exist outside edit mode.
        if (selectedProposalVertex) {
          deleteSelectedProposalVertex();
          return;
        }
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
  }, [
    editMode,
    creatingRoom,
    creatingDevice,
    drawingRoomId,
    drawPoints,
    selectedPinId,
    selectedVertex,
    selectedProposalVertex,
    rooms,
  ]);

  const { placed, unplaced } = partitionPlacement(devices);
  const { placed: placedRacks, unplaced: unplacedRacks } = partitionPlacement(racks);
  const roomsWithoutPolygon = rooms.filter((r) => r.plan_polygon == null);
  const typeName = (id: string) => deviceTypes.find((t) => t.id === id)?.name ?? "—";
  const typeIcon = (id: string) => resolveTypeIcon(deviceTypes.find((t) => t.id === id));
  const typeColor = (id: string) => resolveTypeColor(deviceTypes.find((t) => t.id === id));
  // Racks follow the "Rack" (RK) device type's appearance so recolouring it recolours the markers.
  const rkType = deviceTypes.find((t) => t.code === "RK") ?? { code: "RK" };
  const rackColor = resolveTypeColor(rkType);
  const rackIcon = resolveTypeIcon(rkType);
  // Pins/racks are LOCKED to a fixed fraction of the print: the inner glyph is scaled purely by the
  // plan size, with no dependence on the live zoom, so a pin is always the same size RELATIVE to the
  // plan (it grows/shrinks 1:1 with the print). The factor sets a pin's radius as a fraction of the
  // plan width (~0.37%).
  const pinScale = imgW * 0.00037;
  const vertexPreviewForRoom = (roomId: string) =>
    vertexPreview && vertexPreview.roomId === roomId
      ? { index: vertexPreview.index, point: vertexPreview.point }
      : null;

  const selectedPin = selectedPinId ? devices.find((d) => d.id === selectedPinId) ?? null : null;
  const selectedRoom = selectedRoomId ? rooms.find((r) => r.id === selectedRoomId) ?? null : null;
  const selectedRack = selectedRackId ? racks.find((r) => r.id === selectedRackId) ?? null : null;

  return (
    // Fills the height its container gives it; the tray/pin-popover (edit mode) take their own
    // height and the plan pane flexes to fill the rest, so the plan can run to the viewport bottom.
    <div className="flex h-full flex-col gap-2">
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
          <IconButton
            icon="tabler:trash"
            tip="Remove from plan"
            variant="danger"
            onClick={() => void commitUnplace(selectedPin.id)}
          />
        </div>
      )}

      <div
        ref={paneRef}
        className={`no-select-ui relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-50 ${
          labelsOnHover ? "pins-hover-labels" : ""
        }`}
      >
        <svg
          ref={svgRef}
          data-testid="floor-plan-canvas"
          width="100%"
          height="100%"
          style={{
            display: "block",
            touchAction: "none",
            cursor:
              placingDeviceId || placingRackId || drawingRoomId || creatingRoom || creatingDevice
                ? "crosshair"
                : undefined,
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
            // creatingRoom (toolbar trace of a brand-new room) runs outside edit mode, so it's
            // checked on its own rather than under the editMode guard.
            if (creatingRoom || (editMode && (drawingRoomId || editingRoomId))) {
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
                glyphScale={pinScale}
                typeName={typeName(device.device_type_id)}
                icon={typeIcon(device.device_type_id)}
                color={typeColor(device.device_type_id)}
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
                glyphScale={pinScale}
                color={rackColor}
                icon={rackIcon}
                editMode={editMode}
                selected={selectedRackId === rack.id}
                dragPoint={rackPreview && rackPreview.rackId === rack.id ? rackPreview.point : null}
                onPointerDownRack={onRackPointerDown}
              />
            ))}
            {/* AI proposals — ghosts, drawn AFTER every committed shape so they read as an overlay
                on top of the floor rather than another layer of it. Positioned in the same
                IMAGE-PIXEL space as everything else (identityView), with stroke widths divided by
                the live zoom and labels counter-scaled, so they hold their look at any zoom.
                Editable in place (drag a ghost pin, reshape a proposed outline) — every edit writes
                to proposal state; only Accept in the panel ever reaches the database. */}
            {proposals.rooms.map((rp) => {
              const centroid = normToScreen(polygonCentroid(rp.polygon), identityView(imgW, imgH));
              const outlining = proposalRoomEditId === rp.id;
              return (
                <g key={rp.id} data-testid={`proposal-room-${rp.id}`}>
                  <polygon
                    points={rp.polygon
                      .map((pt) => {
                        const s = normToScreen(pt, identityView(imgW, imgH));
                        return `${s.x},${s.y}`;
                      })
                      .join(" ")}
                    fill={outlining ? PROPOSAL_FILL_ACTIVE : PROPOSAL_FILL}
                    stroke={PROPOSAL_STROKE}
                    strokeWidth={(outlining ? 3 : 2) / view.zoom}
                    strokeDasharray={`${6 / view.zoom} ${4 / view.zoom}`}
                  />
                  {/* Vertex handles, only while the panel's outline toggle is on for this room —
                      the ghost mirror of the committed rooms' select-then-Edit gate. Index `i` is
                      derived synchronously from the polygon being rendered, never cached. */}
                  {outlining &&
                    rp.polygon.map((pt, i) => {
                      const pos = normToScreen(pt, identityView(imgW, imgH));
                      const selected =
                        selectedProposalVertex?.roomId === rp.id && selectedProposalVertex.index === i;
                      return (
                        <circle
                          key={`pv-${i}`}
                          data-testid={`proposal-vertex-${rp.id}-${i}`}
                          cx={pos.x}
                          cy={pos.y}
                          r={6 / view.zoom}
                          fill={selected ? PROPOSAL_STROKE : "#ffffff"}
                          stroke={PROPOSAL_STROKE}
                          strokeWidth={2 / view.zoom}
                          // stopPropagation, or this drag would also pan the canvas — and stands
                          // down while a placement/trace gesture is aiming at the plan.
                          onPointerDown={
                            ghostInteractive
                              ? (e) => {
                                  e.stopPropagation();
                                  onProposalVertexPointerDown(e, rp.id, i);
                                }
                              : undefined
                          }
                          onClick={ghostInteractive ? (e) => e.stopPropagation() : undefined}
                          style={ghostInteractive ? { cursor: "grab" } : undefined}
                        />
                      );
                    })}
                  {outlining &&
                    rp.polygon.map((pt, i) => {
                      const next = rp.polygon[(i + 1) % rp.polygon.length];
                      const mid: NormPoint = [(pt[0] + next[0]) / 2, (pt[1] + next[1]) / 2];
                      const pos = normToScreen(mid, identityView(imgW, imgH));
                      return (
                        <circle
                          key={`pm-${i}`}
                          data-testid={`proposal-vertex-insert-${rp.id}-${i}`}
                          cx={pos.x}
                          cy={pos.y}
                          r={4 / view.zoom}
                          fill={PROPOSAL_STROKE}
                          opacity={0.55}
                          onPointerDown={ghostInteractive ? (e) => e.stopPropagation() : undefined}
                          onClick={
                            ghostInteractive
                              ? (e) => {
                                  e.stopPropagation();
                                  insertProposalVertex(rp.id, i);
                                }
                              : undefined
                          }
                          style={ghostInteractive ? { cursor: "copy" } : undefined}
                        />
                      );
                    })}
                  {/* Always shown (unlike the hover-gated committed room labels) — a proposal only
                      exists while it's being reviewed, and its name is what's under review. */}
                  <g transform={`translate(${centroid.x} ${centroid.y})`}>
                    <g transform={`scale(${1 / view.zoom})`}>
                      <text
                        data-testid={`proposal-room-label-${rp.id}`}
                        x={0}
                        y={4}
                        textAnchor="middle"
                        fontSize={12}
                        fontWeight={700}
                        fill={PROPOSAL_STROKE}
                        stroke="#ffffff"
                        strokeWidth={3}
                        paintOrder="stroke"
                        style={{ pointerEvents: "none" }}
                      >
                        {rp.name || "Room"}
                      </text>
                    </g>
                  </g>
                </g>
              );
            })}
            {proposals.devices.map((dp) => {
              const anchor = normToScreen(dp.point, identityView(imgW, imgH));
              return (
                <g
                  key={dp.id}
                  data-testid={`proposal-pin-${dp.id}`}
                  transform={`translate(${anchor.x} ${anchor.y})`}
                  // Owns its pointer-down (stopPropagation) exactly like a committed pin, or
                  // dragging the ghost would pan the plan underneath it — but stands down entirely
                  // while a placement/trace gesture is aiming at the plan (see ghostInteractive).
                  onPointerDown={
                    ghostInteractive
                      ? (e) => {
                          e.stopPropagation();
                          onProposalPinPointerDown(e, dp.id);
                        }
                      : undefined
                  }
                  onClick={ghostInteractive ? (e) => e.stopPropagation() : undefined}
                  style={ghostInteractive ? { cursor: "grab" } : undefined}
                >
                  {/* pinScale, not 1/zoom: a ghost pin has to sit at the same size as the committed
                      pins it will become. */}
                  <g transform={`scale(${pinScale})`}>
                    <circle r={14} fill="none" stroke={PROPOSAL_STROKE} strokeWidth={1.5} strokeDasharray="3 2" />
                    <circle r={10} fill={PROPOSAL_STROKE} opacity={0.85} />
                    {/* No `plan-pin-label` class: that class is the declutter toggle's hover-gate,
                        and this group isn't a `plan-pin-group`, so it would hide the label with no
                        way to reveal it. A proposal's label is always shown — it's under review. */}
                    <text
                      x={0}
                      y={-19}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={600}
                      fill={PROPOSAL_STROKE}
                      stroke="#ffffff"
                      strokeWidth={3}
                      paintOrder="stroke"
                      style={{ pointerEvents: "none" }}
                    >
                      {dp.label || dp.typeCode}
                    </text>
                  </g>
                </g>
              );
            })}
            {(drawingRoomId || creatingRoom) && (
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
                {snapTarget &&
                  (() => {
                    // Highlight the existing-room vertex the next point will snap to.
                    const s = normToScreen(snapTarget, identityView(imgW, imgH));
                    return (
                      <circle
                        data-testid="snap-target"
                        cx={s.x}
                        cy={s.y}
                        r={9 / view.zoom}
                        fill="none"
                        stroke="#2563eb"
                        strokeWidth={2 / view.zoom}
                      />
                    );
                  })()}
              </g>
            )}
          </g>
        </svg>

        {/* Embedded plan toolbar: Edit-layout toggle plus the plan-level tools (Replace / Delete),
            stacked top-left over the plan. The container ignores pointer events so panning still
            works between the buttons; each control re-enables them. Tooltips open to the right so
            the overflow-hidden pane doesn't clip them. */}
        {editable && (
          <div className="pointer-events-none absolute left-3 top-3 z-30 flex flex-col items-start gap-1.5">
            <span className="pointer-events-auto">
              <IconButton
                data-testid="edit-layout-toggle"
                icon={editMode ? "tabler:check" : "tabler:pencil"}
                tip={editMode ? "Done editing" : "Edit layout"}
                tipSide="right"
                variant={editMode ? "floatingActive" : "floating"}
                aria-pressed={editMode}
                onClick={() => setEditMode((m) => !m)}
              />
            </span>
            <span className="pointer-events-auto">
              <IconButton
                data-testid="fit-to-area"
                icon={returnView ? "tabler:arrows-minimize" : "tabler:arrows-maximize"}
                tip={returnView ? "Back to previous view" : "Fit to area"}
                tipSide="right"
                variant={returnView ? "floatingActive" : "floating"}
                aria-pressed={returnView != null}
                onClick={fitToArea}
              />
            </span>
            {/* AI discovery: one button, a two-item menu (rooms / devices). The menu is anchored to
                this span (relative) so it opens beside the stack rather than pushing it around. */}
            <span ref={wizardRef} className="pointer-events-auto relative">
              <IconButton
                data-testid="plan-wizard"
                icon="tabler:wand"
                tip="AI discovery"
                tipSide="right"
                variant={wizardOpen ? "floatingActive" : "floating"}
                aria-expanded={wizardOpen}
                onClick={() => {
                  setWizardOpen((o) => !o);
                  setWizardNotice(null);
                }}
              />
              {wizardOpen && (
                <div
                  data-testid="plan-wizard-menu"
                  className="absolute left-11 top-0 z-40 w-44 rounded-xl border border-neutral-200 bg-white p-1 shadow-lg"
                >
                  <button
                    type="button"
                    data-testid="discover-rooms"
                    disabled={discovering != null || accepting}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-50"
                    onClick={() => void runDiscovery("rooms")}
                  >
                    <Icon icon="tabler:vector" width={16} height={16} /> Discover rooms
                  </button>
                  <button
                    type="button"
                    data-testid="discover-devices"
                    disabled={discovering != null || accepting}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-neutral-100 disabled:opacity-50"
                    onClick={() => void runDiscovery("devices")}
                  >
                    <Icon icon="tabler:circle-plus" width={16} height={16} /> Discover devices
                  </button>
                </div>
              )}
            </span>
            {planTools && (
              <span className="pointer-events-auto flex flex-col items-start gap-1.5">{planTools}</span>
            )}
          </div>
        )}

        {/* Transient status: an error, or the click-to-place / click-to-draw instructions. Floated
            top-center so it reads as part of the plan rather than adding a row of chrome above it. */}
        {(error ||
          placingDeviceId ||
          placingRackId ||
          drawingRoomId ||
          creatingRoom ||
          creatingDevice ||
          discovering != null ||
          wizardNotice) && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 flex-col items-center gap-1.5">
            {error && (
              <p
                data-testid="canvas-error"
                className="rounded-lg bg-red-50 px-3 py-1 text-sm font-medium text-red-700 shadow-sm"
              >
                {error}
              </p>
            )}
            {!error &&
              (placingDeviceId || placingRackId || drawingRoomId || creatingRoom || creatingDevice) && (
                <p className="rounded-lg bg-neutral-900/85 px-3 py-1 text-xs font-medium text-white shadow-sm">
                  {(placingDeviceId || creatingDevice) && "Click on the plan to place the device. Esc to cancel."}
                  {placingRackId && "Click on the plan to place the rack. Esc to cancel."}
                  {(drawingRoomId || creatingRoom) &&
                    `Click to add points${
                      drawPoints.length >= 3 ? " — Enter or double-click to finish" : ` (${drawPoints.length}/3 minimum)`
                    }. Esc to cancel.`}
                </p>
              )}
            {/* Discovery's own line, so a pass can report while a placement gesture is still live.
                `no-key` and `none-found` are SENTINELS, not prose — each gets its own copy; anything
                else is already a caller-facing message from the action, shown verbatim. */}
            {(discovering != null || wizardNotice) && (
              <p
                data-testid="wizard-notice"
                className="pointer-events-auto rounded-lg bg-neutral-900/85 px-3 py-1 text-xs font-medium text-white shadow-sm"
              >
                {discovering != null ? (
                  "Reading the plan…"
                ) : wizardNotice === "no-key" ? (
                  <>
                    Add a Gemini API key in{" "}
                    <Link href="/settings" className="underline">
                      Settings
                    </Link>{" "}
                    to use AI discovery.
                  </>
                ) : wizardNotice === "none-found" ? (
                  "Nothing found — fine-tune by hand or try a clearer plan."
                ) : (
                  wizardNotice
                )}
              </p>
            )}
          </div>
        )}
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
        {/* The proposal review card: floated top-right, clear of the zoom-control column beside it.
            Presentational — it holds no proposal state and calls no action; every edit and commit
            comes back through these callbacks. */}
        <div className="absolute right-14 top-3 z-20 flex max-h-[calc(100%-1.5rem)]">
          <ProposalPanel
            rooms={proposals.rooms}
            devices={proposals.devices}
            deviceTypes={floorDeviceTypes}
            editingRoomId={proposalRoomEditId}
            busy={accepting}
            onEditDevice={editDeviceProposal}
            onEditRoom={editRoomProposal}
            onToggleRoomOutline={(id) => {
              setProposalRoomEditId((cur) => (cur === id ? null : id));
              setSelectedProposalVertex(null);
            }}
            onAcceptDevice={(dp) => void acceptOne(() => acceptDevice(dp))}
            onAcceptRoom={(rp) => void acceptOne(() => acceptRoom(rp))}
            onDismissDevice={dropDevice}
            onDismissRoom={dropRoom}
            onAcceptAll={() => void acceptAll()}
            onDismissAll={dismissAll}
          />
        </div>

        <div className="pointer-events-none absolute right-3 top-3 z-30 flex flex-col gap-1.5">
          <span className="pointer-events-auto">
            <IconButton
              data-testid="plan-zoom-in"
              icon="tabler:plus"
              tip="Zoom in"
              tipSide="left"
              variant="floating"
              onClick={() => zoomAt(1.25, paneW / 2, paneH / 2)}
            />
          </span>
          <span className="pointer-events-auto">
            <IconButton
              data-testid="plan-zoom-out"
              icon="tabler:minus"
              tip="Zoom out"
              tipSide="left"
              variant="floating"
              onClick={() => zoomAt(0.8, paneW / 2, paneH / 2)}
            />
          </span>
          <span className="pointer-events-auto">
            <IconButton
              data-testid="toggle-pin-labels"
              icon={labelsOnHover ? "tabler:tag-off" : "tabler:tag"}
              tip={labelsOnHover ? "Labels: on hover" : "Labels: always shown"}
              tipSide="left"
              variant={labelsOnHover ? "floatingActive" : "floating"}
              aria-pressed={labelsOnHover}
              onClick={() => setLabelsOnHover((v) => !v)}
            />
          </span>
        </div>
      </div>
    </div>
  );
});
