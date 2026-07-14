"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RackPlacementRender } from "./RackFrame";
import { RACK_GUTTER_L } from "./RackFrame";
import { portCenters, type PortDot } from "./portGeometry";
import { samePort, type Connection, type PortRef } from "./connectionOps";

const keyOf = (p: PortRef) => `${p.rackDeviceId}-${p.side}-${p.groupId}-${p.portIndex}`;
const parsePort = (s: string): PortRef => {
  const [rackDeviceId, side, groupId, portIndex] = s.split("|");
  return { rackDeviceId, side: side as "front" | "back", groupId, portIndex: Number(portIndex) };
};
const serialize = (p: PortRef) => `${p.rackDeviceId}|${p.side}|${p.groupId}|${p.portIndex}`;

// Orthogonal cable: out of A to a left-margin lane, down/up to B's row, into B.
function cablePath(a: PortDot, b: PortDot, lane: number): string {
  return `M ${a.x} ${a.y} H ${lane} V ${b.y} H ${b.x}`;
}

export function PatchLayer(props: {
  placements: RackPlacementRender[];
  heightU: number;
  side: "FRONT" | "BACK";
  connections: Connection[];
  selectedConnectionId: string | null;
  onPatch: (a: PortRef, b: PortRef) => void;
  onSelectConnection: (id: string | null) => void;
}) {
  const { placements, heightU, side, connections, selectedConnectionId } = props;
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

  // Ports that are an endpoint of ANY connection (not just current-face ones don't apply here since
  // `dots` is already scoped to the current face) — used to render a filled dot under the hit-dot.
  const connectedKeys = useMemo(() => {
    const s = new Set<string>();
    for (const c of connections) { s.add(keyOf(c.a)); s.add(keyOf(c.b)); }
    return s;
  }, [connections]);

  const lane = RACK_GUTTER_L - 14; // vertical routing lane just left of the mount
  const [drag, setDrag] = useState<{ from: PortRef; x: number; y: number } | null>(null);
  const dragRef = useRef<PortRef | null>(null);
  const gRef = useRef<SVGGElement>(null);

  // Safety net: releasing a drag over empty space (no port dot under the pointer) should still
  // clear the rubber-band. A successful drop already clears state via the dot's own onPointerUp
  // (React root handlers fire before this window listener), so this is idempotent in that case.
  useEffect(() => {
    if (!drag) return;
    const onUp = () => { dragRef.current = null; setDrag(null); };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, [drag]);

  // Track the cursor while dragging so the rubber-band follows the pointer instead of staying
  // pinned at the origin dot. Client coords are converted to SVG user-space via the owning svg's
  // screen CTM so this stays correct under the canvas's pan/zoom transform.
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

  return (
    <g data-testid="patch-layer" ref={gRef}>
      {/* existing cables (only those whose both ends are on the current face) */}
      {connections.map((c) => {
        if (c.a.side !== faceSide || c.b.side !== faceSide) return null;
        const a = dotByKey.get(keyOf(c.a)), b = dotByKey.get(keyOf(c.b));
        if (!a || !b) return null;
        const selected = c.id === selectedConnectionId;
        return (
          <path key={c.id} data-testid={`cable-${c.id}`} d={cablePath(a, b, lane)}
            fill="none" stroke={selected ? "#f59e0b" : "#2d5bff"} strokeWidth={selected ? 3 : 2}
            style={{ cursor: "pointer", pointerEvents: "auto" }}
            onClick={(e) => { e.stopPropagation(); props.onSelectConnection(c.id); }} />
        );
      })}

      {/* rubber-band while dragging */}
      {drag && (() => {
        const from = dotByKey.get(keyOf(drag.from));
        return from ? <line data-testid="patch-rubber" x1={from.x} y1={from.y} x2={drag.x} y2={drag.y}
          stroke="#2d5bff" strokeWidth={2} strokeDasharray="5 4" pointerEvents="none" /> : null;
      })()}

      {/* port hit-dots — invisible, but carry their PortRef for deterministic drag resolution */}
      {dots.map((d) => (
        <g key={keyOf(d.port)}>
        {connectedKeys.has(keyOf(d.port)) && (
          <circle cx={d.x} cy={d.y} r={4} fill="#2d5bff" pointerEvents="none" />
        )}
        <circle data-testid={`port-dot-${keyOf(d.port)}`} data-port={serialize(d.port)}
          cx={d.x} cy={d.y} r={9} fill="transparent" style={{ cursor: "crosshair", pointerEvents: "all" }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            dragRef.current = d.port;
            setDrag({ from: d.port, x: d.x, y: d.y });
          }}
          onPointerUp={(e) => {
            if (!dragRef.current) return;
            e.stopPropagation();
            const target = (e.currentTarget.getAttribute("data-port"));
            const from = dragRef.current;
            dragRef.current = null;
            setDrag(null);
            if (!target) return;
            const to = parsePort(target);
            if (!samePort(from, to)) props.onPatch(from, to);
          }} />
        </g>
      ))}
    </g>
  );
}
