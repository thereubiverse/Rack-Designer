"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RackPlacementRender } from "./RackFrame";
import { RACK_GUTTER_L, ruTopY } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { portCenters, type PortDot } from "./portGeometry";
import { portConnection, samePort, type Connection, type PortRef } from "./connectionOps";

const BLUE = "#2d5bff";
const AMBER = "#f59e0b";

const keyOf = (p: PortRef) => `${p.rackDeviceId}-${p.side}-${p.groupId}-${p.portIndex}`;
const parsePort = (s: string): PortRef => {
  const [rackDeviceId, side, groupId, portIndex] = s.split("|");
  return { rackDeviceId, side: side as "front" | "back", groupId, portIndex: Number(portIndex) };
};
const serialize = (p: PortRef) => `${p.rackDeviceId}|${p.side}|${p.groupId}|${p.portIndex}`;

// Build a rounded orthogonal path through the given points (right-angle corners smoothed with a
// quadratic of radius r, clamped to half the shorter adjacent segment). Consecutive duplicate
// points are dropped so a degenerate corner (same-row/same-device runs) doesn't break the curve.
function roundedPath(pts: { x: number; y: number }[], r: number): string {
  const p = pts.filter((pt, i) => i === 0 || pt.x !== pts[i - 1].x || pt.y !== pts[i - 1].y);
  if (p.length < 2) return "";
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
  const toward = (from: { x: number; y: number }, to: { x: number; y: number }, d: number) => {
    const len = dist(from, to) || 1;
    return { x: from.x + ((to.x - from.x) / len) * d, y: from.y + ((to.y - from.y) / len) * d };
  };
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const before = toward(b, a, Math.min(r, dist(a, b) / 2));
    const after = toward(b, c, Math.min(r, dist(b, c) / 2));
    d += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  const last = p[p.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

export function PatchLayer(props: {
  placements: RackPlacementRender[];
  heightU: number;
  side: "FRONT" | "BACK";
  connections: Connection[];
  activeConnIds: Set<string>;
  onPatch: (a: PortRef, b: PortRef) => void;
  onSelectConnection: (id: string | null) => void;
  onHoverPort?: (port: PortRef | null) => void;
  onHoverCable?: (id: string | null) => void;
}) {
  const { placements, heightU, side, connections, activeConnIds } = props;
  const faceSide = side === "FRONT" ? "front" : "back";

  // All port centres on the current face, keyed for O(1) lookup by PortRef.
  const dots = useMemo(() => {
    const all: PortDot[] = [];
    for (const p of placements) {
      const face = faceSide === "front" ? p.template.frontFace : p.template.backFace;
      all.push(...portCenters({
        rackDeviceId: p.id, side: faceSide, face,
        startU: p.startU, rackUnits: p.template.rackUnits,
        widthIn: p.template.widthIn, rackMounted: p.template.rackMounted, heightU,
      }));
    }
    return all;
  }, [placements, faceSide, heightU]);
  const dotByKey = useMemo(() => new Map(dots.map((d) => [keyOf(d.port), d])), [dots]);

  // Each device's bottom edge — cables drop to just below it and route in the gap/left gutter so the
  // line never crosses the port glyphs ("through the middle of the device").
  const deviceBottom = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of placements) m.set(p.id, ruTopY(p.startU, p.template.rackUnits, heightU) + p.template.rackUnits * RU_PX);
    return m;
  }, [placements, heightU]);

  const laneBase = RACK_GUTTER_L - 14; // vertical routing lane just left of the mount
  const [drag, setDrag] = useState<{ from: PortRef; x: number; y: number } | null>(null);
  const dragRef = useRef<PortRef | null>(null);
  const gRef = useRef<SVGGElement>(null);

  // Safety net: releasing a drag over empty space still clears the rubber-band (a successful drop
  // already cleared state via the dot's own onPointerUp, which fires first).
  useEffect(() => {
    if (!drag) return;
    const onUp = () => { dragRef.current = null; setDrag(null); };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, [drag]);

  // Rubber-band follows the cursor while dragging (client coords → SVG user-space via the CTM).
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const svg = gRef.current?.ownerSVGElement;
      if (!svg) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const p = pt.matrixTransform(ctm.inverse());
      setDrag((d) => (d ? { ...d, x: p.x, y: p.y } : d));
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [drag]);

  // Only cables whose both ends are on the current face are drawable.
  const faceCables = connections.filter((c) => c.a.side === faceSide && c.b.side === faceSide);

  return (
    <g data-testid="patch-layer" ref={gRef}>
      {/* patch cables — route down out of each port, along the gap to the left gutter, up/down the
          lane, then symmetrically into the far port. Blue by default, amber when the run is active. */}
      {faceCables.map((c, i) => {
        const a = dotByKey.get(keyOf(c.a)), b = dotByKey.get(keyOf(c.b));
        if (!a || !b) return null;
        const aBottom = (deviceBottom.get(c.a.rackDeviceId) ?? a.y) + 5;
        const bBottom = (deviceBottom.get(c.b.rackDeviceId) ?? b.y) + 5;
        const lane = laneBase - (i % 6) * 5; // nest overlapping runs like PatchDocs
        const d = roundedPath([
          { x: a.x, y: a.y }, { x: a.x, y: aBottom }, { x: lane, y: aBottom },
          { x: lane, y: bBottom }, { x: b.x, y: bBottom }, { x: b.x, y: b.y },
        ], 6);
        const active = activeConnIds.has(c.id);
        return (
          <path key={c.id} data-testid={`cable-${c.id}`} d={d}
            fill="none" stroke={active ? AMBER : BLUE} strokeWidth={active ? 3 : 2}
            strokeLinejoin="round" strokeLinecap="round"
            style={{ cursor: "pointer", pointerEvents: "auto" }}
            onPointerEnter={() => props.onHoverCable?.(c.id)}
            onPointerLeave={() => props.onHoverCable?.(null)}
            onClick={(e) => { e.stopPropagation(); props.onSelectConnection(c.id); }} />
        );
      })}

      {/* rubber-band while dragging */}
      {drag && (() => {
        const from = dotByKey.get(keyOf(drag.from));
        return from ? <line data-testid="patch-rubber" x1={from.x} y1={from.y} x2={drag.x} y2={drag.y}
          stroke={BLUE} strokeWidth={2} strokeDasharray="5 4" pointerEvents="none" /> : null;
      })()}

      {/* port hit-dots — invisible, carry their PortRef; hovering reports the port (patched or not),
          clicking a patched port selects its run. */}
      {dots.map((d) => (
        <circle key={keyOf(d.port)} data-testid={`port-dot-${keyOf(d.port)}`} data-port={serialize(d.port)}
          cx={d.x} cy={d.y} r={9} fill="transparent" style={{ cursor: "crosshair", pointerEvents: "all" }}
          onPointerEnter={() => props.onHoverPort?.(d.port)}
          onPointerLeave={() => props.onHoverPort?.(null)}
          onClick={(e) => {
            const conn = portConnection(connections, d.port);
            if (conn) { e.stopPropagation(); props.onSelectConnection(conn.id); }
          }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            dragRef.current = d.port;
            setDrag({ from: d.port, x: d.x, y: d.y });
          }}
          onPointerUp={(e) => {
            if (!dragRef.current) return;
            e.stopPropagation();
            const target = e.currentTarget.getAttribute("data-port");
            const from = dragRef.current;
            dragRef.current = null;
            setDrag(null);
            if (!target) return;
            const to = parsePort(target);
            if (!samePort(from, to)) props.onPatch(from, to);
          }} />
      ))}
    </g>
  );
}
