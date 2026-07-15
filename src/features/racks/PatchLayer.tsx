"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RackPlacementRender } from "./RackFrame";
import { RACK_CABLE_LANE_X, ruTopY } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { portCenters, type PortDot } from "./portGeometry";
import { portConnection, samePort, type Connection, type PortRef } from "./connectionOps";

// Exact PatchDocs cable colours (their --color-primary-blue / highlighted amber).
const BLUE = "#1a55d8";
const AMBER = "#fdc700";

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

type Pt = { x: number; y: number };

/** Evenly-spaced points along a path. Sampling both shapes is what lets a hanging cable morph into
 *  the routed patch line — the two `d` strings have completely different commands, so they can only
 *  be interpolated as geometry. */
function samplePath(d: string, n: number): Pt[] {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  const len = p.getTotalLength();
  return Array.from({ length: n + 1 }, (_, i) => {
    const pt = p.getPointAtLength((len * i) / n);
    return { x: pt.x, y: pt.y };
  });
}
const polyD = (pts: Pt[]) => pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");

function pathLength(d: string): number {
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  return p.getTotalLength();
}

/** Does a connection join the same two ports as the recoiling drop (either way round)? */
const pairsMatch = (r: { a: PortRef; b: PortRef }, c: Connection) =>
  (samePort(r.a, c.a) && samePort(r.b, c.b)) || (samePort(r.a, c.b) && samePort(r.b, c.a));

export function PatchLayer(props: {
  placements: RackPlacementRender[];
  heightU: number;
  side: "FRONT" | "BACK";
  connections: Connection[];
  activeConnIds: Set<string>;
  onConnectAttempt: (a: PortRef, b: PortRef) => void; // drag-drop from a onto b (parent resolves conflicts)
  onPortClick: (port: PortRef) => void;               // parent runs the select / connect / pin state machine
  onSelectConnection: (id: string | null) => void;
  onHoverPort?: (port: PortRef | null) => void;
  onHoverCable?: (id: string | null) => void;
  pinPort?: PortRef | null;                           // port whose red disconnect pin is showing (2nd click)
  onDisconnect?: (id: string) => void;
}) {
  const { placements, heightU, side, connections, activeConnIds, pinPort } = props;
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

  // Each device's top/bottom edges. A cable exits a port toward its NEAREST edge (up for a port in
  // the device's upper half, down for the lower half) and runs along the device edge, above/below
  // the port labels — the short segment onto the port is ANGLED (see LEAD below) so it clears the
  // port's own number label instead of covering it.
  const deviceEdges = useMemo(() => {
    const m = new Map<string, { top: number; bottom: number }>();
    for (const p of placements) {
      const top = ruTopY(p.startU, p.template.rackUnits, heightU);
      m.set(p.id, { top, bottom: top + p.template.rackUnits * RU_PX });
    }
    return m;
  }, [placements, heightU]);
  const EDGE_INSET = 4;
  const exitY = (port: PortRef, dot: PortDot) => {
    const e = deviceEdges.get(port.rackDeviceId);
    if (!e) return dot.y;
    const up = dot.y - e.top, down = e.bottom - dot.y;
    return up < down ? e.top + EDGE_INSET : e.bottom - EDGE_INSET;
  };

  const laneBase = RACK_CABLE_LANE_X; // shared vertical trunk, seated in the widened gutter
  const [drag, setDrag] = useState<{ from: PortRef; x: number; y: number; snap: PortRef | null } | null>(null);
  const dragRef = useRef<PortRef | null>(null);
  const gRef = useRef<SVGGElement>(null);
  // Live drag values the animation frame reads, so the band keeps springing between pointermoves
  // without re-rendering React every frame.
  const snapRef = useRef<PortRef | null>(null);
  const cursorRef = useRef({ x: 0, y: 0 });
  const rubberRef = useRef<SVGPathElement>(null);
  const plugRef = useRef<SVGCircleElement>(null);
  const springRef = useRef({ x: 0, y: 0, vx: 0, vy: 0 });
  // A dropped cable recoils into its routed position; while it does, the real cable is suppressed
  // and this path IS the cable.
  const [recoil, setRecoil] = useState<{ a: PortRef; b: PortRef } | null>(null);
  const recoilRef = useRef<SVGPathElement>(null);
  const recoilAnim = useRef<{ from: Pt[]; to: Pt[]; t0: number } | null>(null);
  // Cables being reeled back into their port: a dropped-short drag, or an unplugged connection.
  const [sucks, setSucks] = useState<{ id: string; d: string }[]>([]);
  const suckEls = useRef(new Map<string, SVGPathElement>());
  const suckAnim = useRef(new Map<string, { len: number; t0: number }>());

  /** How near a port has to be for the cable to grab it (SVG units; the dot itself is r=9). */
  const SNAP_R = 16;
  /** Cable paid out per unit dragged: the farther from the port, the more slack hangs. */
  const SLACK = 0.18;

  /** The routed patch line for a connection — the shape a dropped cable recoils into. */
  const cableD = (aRef: PortRef, a: PortDot, bRef: PortRef, b: PortDot) => {
    const aRail = exitY(aRef, a), bRail = exitY(bRef, b);
    // The segment onto the port leaves at an ANGLE — leaning toward the trunk (left) as it
    // rises/drops to the rail — so the diagonal clears the port's centred number label instead of
    // covering it with a vertical stub.
    const LEAD = 18;
    return roundedPath([
      { x: a.x, y: a.y }, { x: a.x - LEAD, y: aRail }, { x: laneBase, y: aRail },
      { x: laneBase, y: bRail }, { x: b.x - LEAD, y: bRail }, { x: b.x, y: b.y },
    ], 14);
  };

  /** Reel a cable back into the port it came out of: the strand shortens along its own curve, tip
   *  first, accelerating as it goes. `d` must START at the port doing the sucking. */
  const startSuck = (d: string) => {
    let len: number;
    try { len = pathLength(d); } catch { return; }
    if (!(len > 0)) return;
    const id = crypto.randomUUID();
    suckAnim.current.set(id, { len, t0: performance.now() });
    setSucks((s) => [...s, { id, d }]);
  };

  /** Kick off the recoil from the cable's current hanging shape into its routed position. Returns
   *  false when the drop won't actually connect — a patched endpoint raises the replace prompt or
   *  an error instead, and there would be no cable to land on — so the caller reels it back in. */
  const startRecoil = (from: PortRef, to: PortRef): boolean => {
    const a = dotByKey.get(keyOf(from)), b = dotByKey.get(keyOf(to));
    const hangD = rubberRef.current?.getAttribute("d");
    if (!a || !b || !hangD) return false;
    if (portConnection(connections, from) || portConnection(connections, to)) return false;
    const N = 48;
    try {
      recoilAnim.current = {
        from: samplePath(hangD, N), to: samplePath(cableD(from, a, to, b), N), t0: performance.now(),
      };
    } catch { return false; } // getTotalLength can throw on a degenerate path; skip the flourish
    setRecoil({ a: from, b: to });
    return true;
  };

  /** Every drag ends here: it either recoils into a new cable, or gets reeled back into its port. */
  const endDrag = (from: PortRef | null, to: PortRef | null) => {
    const hangD = rubberRef.current?.getAttribute("d") ?? null;
    let recoiled = false;
    if (from && to && !samePort(from, to)) {
      recoiled = startRecoil(from, to);
      props.onConnectAttempt(from, to);
    }
    if (!recoiled && hangD) startSuck(hangD);
    setDrag(null);
  };
  // Held in a ref so the window listeners can subscribe once per drag without going stale.
  const endDragRef = useRef(endDrag);
  useEffect(() => { endDragRef.current = endDrag; });

  // Effects below key on drag?.from, NOT drag: setDrag spreads the same `from` object every
  // pointermove, so they subscribe once per drag instead of re-subscribing on every move.
  const dragFrom = drag?.from ?? null;

  // Safety net: releasing over empty space clears the band. It also completes a patch when the
  // band had SNAPPED to a nearby port but the pointer came up just outside its dot — a drop
  // straight onto a dot is handled by the dot's own onPointerUp, which stops propagation before
  // this ever runs.
  useEffect(() => {
    if (!dragFrom) return;
    const onUp = () => {
      const from = dragRef.current, snap = snapRef.current;
      dragRef.current = null; snapRef.current = null;
      endDragRef.current(from, snap); // recoils onto a snapped port, else reels back in
    };
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, [dragFrom]);

  // Rubber-band follows the cursor while dragging (client coords → SVG user-space via the CTM),
  // grabbing the nearest port within SNAP_R.
  useEffect(() => {
    if (!dragFrom) return;
    const move = (e: PointerEvent) => {
      const svg = gRef.current?.ownerSVGElement;
      if (!svg) return;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX; pt.y = e.clientY;
      const p = pt.matrixTransform(ctm.inverse());
      cursorRef.current = { x: p.x, y: p.y };
      let snap: PortRef | null = null;
      let best = SNAP_R;
      for (const d of dots) {
        if (samePort(d.port, dragFrom)) continue;
        const dist = Math.hypot(d.x - p.x, d.y - p.y);
        if (dist <= best) { best = dist; snap = d.port; }
      }
      snapRef.current = snap;
      setDrag((d) => (d ? { ...d, x: p.x, y: p.y, snap } : d));
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, [dragFrom, dots]);

  // The cable pulls out of the port like a retractable reel: the farther you drag, the more it pays
  // out, and the slack HANGS — the curve's control point is a damped spring chasing a point sagged
  // below the midpoint, so the loop swings and settles as you move it around. Grabbing a port pulls
  // it taut. Driven imperatively per frame — React never re-renders for it.
  useEffect(() => {
    if (!dragFrom) return;
    const from = dotByKey.get(keyOf(dragFrom));
    if (!from) return;
    springRef.current = { x: from.x, y: from.y, vx: 0, vy: 0 }; // unspools from the port
    const STIFF = 0.18, DAMP = 0.78; // underdamped → the loop swings before it settles
    let raf = 0;
    const tick = () => {
      const snapDot = snapRef.current ? dotByKey.get(keyOf(snapRef.current)) : undefined;
      const end = snapDot ?? cursorRef.current;
      const s = springRef.current;
      const dist = Math.hypot(end.x - from.x, end.y - from.y);
      // Sag grows with how much cable is out; snapping to a port takes up the slack.
      const sag = snapDot ? 0 : dist * SLACK;
      const midX = (from.x + end.x) / 2;
      const midY = (from.y + end.y) / 2 + sag * 2; // a quadratic dips half its control offset
      s.vx = (s.vx + (midX - s.x) * STIFF) * DAMP;
      s.vy = (s.vy + (midY - s.y) * STIFF) * DAMP;
      s.x += s.vx; s.y += s.vy;
      rubberRef.current?.setAttribute("d", `M ${from.x} ${from.y} Q ${s.x} ${s.y} ${end.x} ${end.y}`);
      plugRef.current?.setAttribute("cx", String(end.x));
      plugRef.current?.setAttribute("cy", String(end.y));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragFrom, dotByKey]);

  // Drop → the slack whips out of the cable and it settles into its routed position. Both shapes
  // are sampled to points so they can be interpolated; easeOutBack overshoots slightly, which is
  // what sells the recoil.
  useEffect(() => {
    if (!recoil) return;
    const anim = recoilAnim.current;
    if (!anim) { setRecoil(null); return; }
    const DUR = 420;
    const ease = (t: number) => { const c1 = 1.5, c3 = c1 + 1, u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };
    let raf = 0;
    const tick = () => {
      const t = Math.min(1, (performance.now() - anim.t0) / DUR);
      const e = ease(t);
      recoilRef.current?.setAttribute("d", polyD(anim.from.map((p, i) => ({
        x: p.x + (anim.to[i].x - p.x) * e,
        y: p.y + (anim.to[i].y - p.y) * e,
      }))));
      if (t < 1) raf = requestAnimationFrame(tick);
      else { recoilAnim.current = null; setRecoil(null); } // hand off to the real cable
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recoil]);

  // Unplugging a cable reels it in too: the parent just drops it from the list, so diff for
  // removals. A cable whose device went with it has no port left to retract into — skip those.
  const prevConns = useRef(connections);
  useEffect(() => {
    const prev = prevConns.current;
    prevConns.current = connections;
    for (const c of prev) {
      if (connections.some((x) => x.id === c.id)) continue;
      if (c.a.side !== faceSide || c.b.side !== faceSide) continue;
      const a = dotByKey.get(keyOf(c.a)), b = dotByKey.get(keyOf(c.b));
      if (!a || !b) continue;
      startSuck(cableD(c.a, a, c.b, b)); // routed path starts at `a` → it reels into that port
    }
  }, [connections]); // eslint-disable-line react-hooks/exhaustive-deps

  // The reel-in: shorten the visible strand along its own curve, tip first. easeInCubic makes it
  // accelerate into the port — the slurp. One frame loop drives every strand in flight.
  useEffect(() => {
    if (sucks.length === 0) return;
    const DUR = 380;
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const done: string[] = [];
      for (const s of sucks) {
        const a = suckAnim.current.get(s.id), el = suckEls.current.get(s.id);
        if (!a) { done.push(s.id); continue; }
        const t = Math.min(1, (now - a.t0) / DUR);
        const visible = a.len * (1 - t * t * t);
        el?.setAttribute("stroke-dasharray", `${visible} ${a.len + 10}`);
        if (t >= 1) done.push(s.id);
      }
      if (done.length) {
        for (const id of done) { suckAnim.current.delete(id); suckEls.current.delete(id); }
        setSucks((s) => s.filter((x) => !done.includes(x.id)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [sucks]);

  // Only cables whose both ends are on the current face are drawable.
  const faceCables = connections.filter((c) => c.a.side === faceSide && c.b.side === faceSide);

  return (
    <g data-testid="patch-layer" ref={gRef}>
      {/* patch cables — every cable routes down out of its ports to a SINGLE shared lane next to
          the rack, so the vertical runs overlap perfectly (PatchDocs). Blue by default; the active
          run is amber and rendered LAST so it sits on top of the overlapping blue lines. */}
      {[...faceCables]
        .sort((x, y) => Number(activeConnIds.has(x.id)) - Number(activeConnIds.has(y.id)))
        .map((c) => {
          const a = dotByKey.get(keyOf(c.a)), b = dotByKey.get(keyOf(c.b));
          if (!a || !b) return null;
          // Hidden while its drop is still recoiling — the recoil path IS the cable until it lands.
          if (recoil && pairsMatch(recoil, c)) return null;
          const d = cableD(c.a, a, c.b, b);
          const active = activeConnIds.has(c.id);
          return (
            <path key={c.id} data-testid={`cable-${c.id}`} d={d}
              fill="none" stroke={active ? AMBER : BLUE} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round"
              style={{ cursor: "pointer", pointerEvents: "auto" }}
              onPointerEnter={() => props.onHoverCable?.(c.id)}
              onPointerLeave={() => props.onHoverCable?.(null)}
              onClick={(e) => { e.stopPropagation(); props.onSelectConnection(c.id); }} />
          );
        })}

      {/* the cable being pulled out of the port. The `d` here is only the first frame's — the
          spring effect drives it imperatively after that. */}
      {drag && (() => {
        const from = dotByKey.get(keyOf(drag.from));
        if (!from) return null;
        const snapDot = drag.snap ? dotByKey.get(keyOf(drag.snap)) : undefined;
        const end = snapDot ?? { x: drag.x, y: drag.y };
        return (
          <g pointerEvents="none">
            <path ref={rubberRef} data-testid="patch-rubber" data-snapped={snapDot ? "true" : "false"}
              d={`M ${from.x} ${from.y} Q ${from.x} ${from.y} ${end.x} ${end.y}`}
              fill="none" stroke={BLUE} strokeWidth={snapDot ? 2.5 : 2} strokeLinecap="round" />
            {snapDot && (
              <circle data-testid="patch-snap-ring" className="patch-snap-ring"
                cx={snapDot.x} cy={snapDot.y} r={7} fill="none" stroke={BLUE} strokeWidth={1.6} />
            )}
            {/* the plug end you're holding */}
            <circle ref={plugRef} data-testid="patch-plug" cx={end.x} cy={end.y} r={3.5} fill={BLUE} />
          </g>
        );
      })()}

      {/* a dropped cable snapping back into its routed position */}
      {recoil && (
        <path ref={recoilRef} data-testid="patch-recoil" fill="none" stroke={BLUE} strokeWidth={2}
          strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
      )}

      {/* cables being reeled back into their port */}
      {sucks.map((s) => (
        <path key={s.id} data-testid="patch-suck" d={s.d}
          ref={(el) => { if (el) suckEls.current.set(s.id, el); else suckEls.current.delete(s.id); }}
          fill="none" stroke={BLUE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
          pointerEvents="none" />
      ))}

      {/* port hit-dots — invisible, carry their PortRef; hovering reports the port (patched or not),
          clicking a patched port selects its run. */}
      {dots.map((d) => (
        <circle key={keyOf(d.port)} data-testid={`port-dot-${keyOf(d.port)}`} data-port={serialize(d.port)}
          cx={d.x} cy={d.y} r={9} fill="transparent" style={{ cursor: "crosshair", pointerEvents: "all" }}
          onPointerEnter={() => props.onHoverPort?.(d.port)}
          onPointerLeave={() => props.onHoverPort?.(null)}
          onClick={(e) => { e.stopPropagation(); props.onPortClick(d.port); }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            dragRef.current = d.port;
            snapRef.current = null;
            cursorRef.current = { x: d.x, y: d.y };
            setDrag({ from: d.port, x: d.x, y: d.y, snap: null });
          }}
          onPointerUp={(e) => {
            if (!dragRef.current) return;
            e.stopPropagation();
            const target = e.currentTarget.getAttribute("data-port");
            const from = dragRef.current;
            dragRef.current = null;
            snapRef.current = null;
            // endDrag reads the cable's current hanging shape, so it must run before the clear.
            endDrag(from, target ? parsePort(target) : null);
          }} />
      ))}

      {/* red disconnect pin above a patched port on its SECOND click — click it to remove the run */}
      {(() => {
        if (!pinPort || pinPort.side !== faceSide) return null;
        const dot = dotByKey.get(keyOf(pinPort));
        const conn = portConnection(connections, pinPort);
        if (!dot || !conn) return null;
        const cx = dot.x, tip = dot.y - 10, cy = tip - 20; // pin tip just above the port; body centre
        return (
          <g data-testid="disconnect-pin" style={{ cursor: "pointer", pointerEvents: "auto" }}
            onClick={(e) => { e.stopPropagation(); props.onDisconnect?.(conn.id); }}>
            <path d={`M ${cx} ${tip} C ${cx - 7} ${tip - 8} ${cx - 13} ${tip - 14} ${cx - 13} ${cy} A 13 13 0 1 1 ${cx + 13} ${cy} C ${cx + 13} ${tip - 14} ${cx + 7} ${tip - 8} ${cx} ${tip} Z`}
              fill="#ef4444" stroke="#fff" strokeWidth={1} />
            {/* white crossed-out plug glyph */}
            <g stroke="#fff" strokeWidth={1.6} strokeLinecap="round" fill="none">
              <line x1={cx - 3} y1={cy - 6} x2={cx - 3} y2={cy - 3} />
              <line x1={cx + 3} y1={cy - 6} x2={cx + 3} y2={cy - 3} />
              <path d={`M ${cx - 4} ${cy - 3} h 8 v 2 a 4 4 0 0 1 -8 0 z`} fill="#fff" stroke="none" />
              <line x1={cx} y1={cy + 1} x2={cx} y2={cy + 5} />
              <line x1={cx - 7} y1={cy + 6} x2={cx + 7} y2={cy - 7} strokeWidth={2} />
            </g>
          </g>
        );
      })()}
    </g>
  );
}
