"use client";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { RackPlacementRender } from "./RackFrame";
import { RACK_CABLE_LANE_X, ruTopY } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { portCenters, type PortDot } from "./portGeometry";
import { portConnection, samePort, type Connection, type PortRef } from "./connectionOps";

// Exact PatchDocs cable colours (their --color-primary-blue / highlighted amber).
const BLUE = "#1a55d8";
const AMBER = "#fdc700";
/** Patch-cable stroke weight. */
const CABLE_W = 3;

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

// ── The cable is simulated as a rope, not drawn as a curve ────────────────────────────────
// A chain of points under gravity, with each link relaxed back to a rest length (Verlet). That is
// what makes it behave like a noodle: it has momentum, so it swings, overshoots and whips instead
// of easing tidily from A to B. Slurping is just the same rope with its rest length driven to zero.
// Everything below is tuned to run at HALF speed, so the flailing is easy to watch. Slowing a
// Verlet sim means shrinking the time step, not just stretching a duration: at half rate gravity
// scales by ¼ and per-frame damping by ^½, which keeps the SAME trajectory and just plays it out
// slower. (Stretching only the slurp's duration would let gravity settle the rope instead of
// whipping it — the chaos would drain away.)
const ROPE_N = 24;      // points in the chain
const GRAVITY = 0.29;   // svg units per frame², pulling the slack down (1.15 at full rate)
const DAMP = 0.98;      // near-1 keeps momentum, which is where the chaos comes from (0.96 full)
const RELAX = 10;       // constraint passes per frame — fewer = floppier links

type Rope = { pts: Pt[]; prev: Pt[] };
const makeRope = (pts: Pt[]): Rope => ({ pts: pts.map((p) => ({ ...p })), prev: pts.map((p) => ({ ...p })) });
const polyLength = (p: Pt[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.y - p[i - 1].y) : 0), 0);

/** One Verlet step: integrate, then relax every link toward `rest`. `pins` are held fixed. */
function stepRope(r: Rope, rest: number, pins: Map<number, Pt>) {
  const { pts, prev } = r;
  for (let i = 0; i < pts.length; i++) {
    if (pins.has(i)) continue;
    const p = pts[i], q = prev[i];
    const vx = (p.x - q.x) * DAMP, vy = (p.y - q.y) * DAMP; // implicit velocity
    q.x = p.x; q.y = p.y;
    p.x += vx; p.y += vy + GRAVITY;
  }
  for (let k = 0; k < RELAX; k++) {
    for (const [i, pos] of pins) { pts[i].x = pos.x; pts[i].y = pos.y; }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const k2 = ((d - rest) / d) * 0.5;
      const ox = dx * k2, oy = dy * k2;
      if (!pins.has(i)) { a.x += ox; a.y += oy; }
      if (!pins.has(i + 1)) { b.x -= ox; b.y -= oy; }
    }
  }
  for (const [i, pos] of pins) { pts[i].x = pos.x; pts[i].y = pos.y; }
}

/** Smooth a chain of points into a path (midpoint quadratics), so the noodle reads as a cable. */
function smoothD(p: Pt[]): string {
  if (p.length < 2) return "";
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    d += ` Q ${p[i].x} ${p[i].y} ${(p[i].x + p[i + 1].x) / 2} ${(p[i].y + p[i + 1].y) / 2}`;
  }
  return `${d} L ${p[p.length - 1].x} ${p[p.length - 1].y}`;
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
  dragId?: string | null;                             // device being grip-dragged, or null
  dragDYRef?: MutableRefObject<number>;               // its live vertical offset (px), read per frame
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
  // 0 => the cable's edge-run sits ON the device's top/bottom edge, overlapping the outline, rather
  // than parallel to it a few px inside.
  const EDGE_INSET = 0;
  // `dy` shifts the device's edges while it is grip-dragged, so the cable's edge-run follows it. The
  // dot passed in is already shifted by the same dy, so the nearest-edge choice is unchanged.
  const exitY = (port: PortRef, dot: PortDot, dy = 0) => {
    const e = deviceEdges.get(port.rackDeviceId);
    if (!e) return dot.y;
    const top = e.top + dy, bottom = e.bottom + dy;
    const up = dot.y - top, down = bottom - dot.y;
    return up < down ? top + EDGE_INSET : bottom - EDGE_INSET;
  };

  const laneBase = RACK_CABLE_LANE_X; // shared vertical trunk, seated in the widened gutter
  const [drag, setDrag] = useState<{ from: PortRef; x: number; y: number; snap: PortRef | null } | null>(null);
  const dragRef = useRef<PortRef | null>(null);
  const gRef = useRef<SVGGElement>(null);
  const cableEls = useRef(new Map<string, SVGPathElement>());
  // Live drag values the animation frame reads, so the band keeps springing between pointermoves
  // without re-rendering React every frame.
  const snapRef = useRef<PortRef | null>(null);
  const cursorRef = useRef({ x: 0, y: 0 });
  const rubberRef = useRef<SVGPathElement>(null);
  const plugRef = useRef<SVGCircleElement>(null);
  const ropeRef = useRef<Rope | null>(null);
  // A dropped cable recoils into its routed position; while it does, the real cable is suppressed
  // and this path IS the cable.
  const [recoil, setRecoil] = useState<{ a: PortRef; b: PortRef } | null>(null);
  const recoilRef = useRef<SVGPathElement>(null);
  const recoilAnim = useRef<{ from: Pt[]; to: Pt[]; t0: number } | null>(null);
  // Cables being reeled back into their port: a dropped-short drag, or an unplugged connection.
  const [sucks, setSucks] = useState<{ id: string }[]>([]);
  const suckEls = useRef(new Map<string, SVGPathElement>());
  const suckSim = useRef(new Map<string, { rope: Rope; anchor: Pt; L0: number; t0: number }>());

  // While a device is grip-dragged, keep the cables attached to it: recompute the affected cables'
  // paths each frame from the device's live vertical offset. The device itself moves imperatively
  // (no re-render), so the cables must too, or they detach until the drag commits. Only cables
  // touching the dragged device are recomputed; the rest are already correct.
  useEffect(() => {
    const dyRef = props.dragDYRef;
    const dragId = props.dragId;
    if (!dragId || !dyRef) return;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dy = dyRef.current;
      for (const c of connections) {
        const aOn = c.a.rackDeviceId === dragId, bOn = c.b.rackDeviceId === dragId;
        if (!aOn && !bOn) continue;
        const el = cableEls.current.get(c.id);
        const a = dotByKey.get(keyOf(c.a)), b = dotByKey.get(keyOf(c.b));
        if (!el || !a || !b) continue;
        el.setAttribute("d", cableD(c.a, a, c.b, b, aOn ? dy : 0, bOn ? dy : 0));
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [props.dragId, props.dragDYRef, connections, dotByKey]);

  /** How near a port has to be for the cable to grab it (SVG units; the dot itself is r=9). */
  const SNAP_R = 16;
  /** Cable paid out per unit dragged: the farther from the port, the more slack hangs. */
  const SLACK = 0.35;

  /** The routed patch line for a connection — the shape a dropped cable recoils into. */
  const cableD = (aRef: PortRef, a: PortDot, bRef: PortRef, b: PortDot, dyA = 0, dyB = 0) => {
    // A grip-dragged device carries its cable ends with it: dyA/dyB shift each side's port and rail.
    const ay = a.y + dyA, by = b.y + dyB;
    const aRail = exitY(aRef, { ...a, y: ay }, dyA), bRail = exitY(bRef, { ...b, y: by }, dyB);
    // The segment onto the port leaves at an ANGLE — leaning toward the trunk (left) as it
    // rises/drops to the rail — so the diagonal clears the port's centred number label instead of
    // covering it with a vertical stub.
    const LEAD = 18;
    return roundedPath([
      { x: a.x, y: ay }, { x: a.x - LEAD, y: aRail }, { x: laneBase, y: aRail },
      { x: laneBase, y: bRail }, { x: b.x - LEAD, y: bRail }, { x: b.x, y: by },
    ], 14);
  };

  /** Slurp a cable back into the port it came out of. The strand keeps simulating as it goes — its
   *  rest length is driven to zero while gravity and momentum stay on, so it whips and flails its
   *  way in rather than tidily shrinking. `pts[0]` must be the port doing the sucking. */
  const startSuck = (pts: Pt[]) => {
    if (pts.length < 2) return;
    const L0 = polyLength(pts);
    if (!(L0 > 0)) return;
    const id = crypto.randomUUID();
    suckSim.current.set(id, { rope: makeRope(pts), anchor: { ...pts[0] }, L0, t0: performance.now() });
    setSucks((s) => [...s, { id }]);
  };

  const RECOIL_N = 48;

  /** Morph `fromD` into the routed line for from↔to — the connect animation. */
  const recoilFrom = (fromD: string, from: PortRef, to: PortRef): boolean => {
    const a = dotByKey.get(keyOf(from)), b = dotByKey.get(keyOf(to));
    if (!a || !b) return false;
    try {
      recoilAnim.current = {
        from: samplePath(fromD, RECOIL_N), to: samplePath(cableD(from, a, to, b), RECOIL_N),
        t0: performance.now(),
      };
    } catch { return false; } // getTotalLength can throw on a degenerate path; skip the flourish
    setRecoil({ a: from, b: to });
    return true;
  };

  /** Kick off the recoil from the cable's current hanging shape. Returns false when the drop won't
   *  actually connect — a patched endpoint raises the replace prompt instead, and there would be no
   *  cable to land on — so the caller reels it back in. */
  const startRecoil = (from: PortRef, to: PortRef): boolean => {
    const hangD = rubberRef.current?.getAttribute("d");
    if (!hangD) return false;
    if (portConnection(connections, from) || portConnection(connections, to)) return false;
    return recoilFrom(hangD, from, to);
  };

  /** Every drag ends here: it either recoils into a new cable, or gets slurped back into its port. */
  const endDrag = (from: PortRef | null, to: PortRef | null) => {
    const rope = ropeRef.current;
    let recoiled = false;
    if (from && to && !samePort(from, to)) {
      recoiled = startRecoil(from, to);
      props.onConnectAttempt(from, to);
    }
    // Hand the LIVE rope to the slurp so it keeps whatever swing it had — it does not restart.
    if (!recoiled && rope) startSuck(rope.pts);
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

  // The cable is a rope pinned at the port and at the plug in your hand. It pays out MORE length
  // than the straight run, so the excess hangs and swings under gravity as you drag it around;
  // grabbing a port takes the slack up and pulls it taut. Driven imperatively per frame — React
  // never re-renders for it.
  useEffect(() => {
    if (!dragFrom) return;
    const from = dotByKey.get(keyOf(dragFrom));
    if (!from) return;
    // Starts coiled inside the port: every link sits on the glyph and gets dragged out.
    ropeRef.current = makeRope(Array.from({ length: ROPE_N }, () => ({ x: from.x, y: from.y })));
    let raf = 0;
    const tick = () => {
      const rope = ropeRef.current;
      if (!rope) return;
      const snapDot = snapRef.current ? dotByKey.get(keyOf(snapRef.current)) : undefined;
      const end = snapDot ?? cursorRef.current;
      const dist = Math.hypot(end.x - from.x, end.y - from.y);
      const total = dist * (snapDot ? 1 : 1 + SLACK); // the farther you pull, the more slack hangs
      stepRope(rope, total / (ROPE_N - 1), new Map([[0, from], [ROPE_N - 1, end]]));
      rubberRef.current?.setAttribute("d", smoothD(rope.pts));
      plugRef.current?.setAttribute("cx", String(end.x));
      plugRef.current?.setAttribute("cy", String(end.y));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); ropeRef.current = null; };
  }, [dragFrom, dotByKey]);

  // Drop → the slack whips out of the cable and it settles into its routed position. Both shapes
  // are sampled to points so they can be interpolated; easeOutBack overshoots slightly, which is
  // what sells the recoil.
  useEffect(() => {
    if (!recoil) return;
    const anim = recoilAnim.current;
    if (!anim) { setRecoil(null); return; }
    // Connecting is the satisfying half, so it lands a little quicker than the slurp (which stays
    // at 1240ms). This is a plain point-morph, so the duration is its only knob — the rope's
    // gravity/damping are untouched and the disconnect is unaffected.
    const DUR = 1100;
    // easeOutElastic: overshoots the routed line and rings past it a few times before settling —
    // the cable snapping taut and bouncing, rather than gliding into place.
    const ease = (t: number) =>
      t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -8 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
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

  // The parent only ever hands us a new list, so diff it for what changed and animate both sides.
  // Removals reel in (unplug, or the cable a Replace dropped). Additions with no drag behind them —
  // a Replace, click-to-connect, a redo — still snap in with the connect animation, drawn from a
  // straight run since there is no hanging rope to start from.
  const prevConns = useRef(connections);
  useEffect(() => {
    const prev = prevConns.current;
    prevConns.current = connections;
    for (const c of connections) {
      if (prev.some((x) => x.id === c.id)) continue;              // not new
      if (recoil && pairsMatch(recoil, c)) continue;              // a drop is already recoiling it
      if (c.a.side !== faceSide || c.b.side !== faceSide) continue;
      const a = dotByKey.get(keyOf(c.a)), b = dotByKey.get(keyOf(c.b));
      if (!a || !b) continue;
      recoilFrom(`M ${a.x} ${a.y} L ${b.x} ${b.y}`, c.a, c.b);
    }
    for (const c of prev) {
      if (connections.some((x) => x.id === c.id)) continue;
      if (c.a.side !== faceSide || c.b.side !== faceSide) continue;
      const a = dotByKey.get(keyOf(c.a)), b = dotByKey.get(keyOf(c.b));
      if (!a || !b) continue;
      // Sampled into a rope; the routed path starts at `a`, so that is the port it slurps into.
      try { startSuck(samplePath(cableD(c.a, a, c.b, b), ROPE_N - 1)); } catch { /* degenerate */ }
    }
  }, [connections]); // eslint-disable-line react-hooks/exhaustive-deps

  // The slurp: keep simulating the rope, but haul its rest length to zero. Only the port end is
  // pinned, so the free tail keeps its swing and gets whipped in — gravity and momentum do the
  // flailing, no easing curve could. One frame loop drives every strand in flight.
  useEffect(() => {
    if (sucks.length === 0) return;
    const DUR = 1240; // 2× the old 620 — matches the half-rate physics above
    let raf = 0;
    const tick = () => {
      const now = performance.now();
      const done: string[] = [];
      for (const s of sucks) {
        const sim = suckSim.current.get(s.id);
        if (!sim) { done.push(s.id); continue; }
        const t = Math.min(1, (now - sim.t0) / DUR);
        const total = sim.L0 * (1 - t * t); // reels in faster the further it goes
        stepRope(sim.rope, total / (ROPE_N - 1), new Map([[0, sim.anchor]]));
        suckEls.current.get(s.id)?.setAttribute("d", smoothD(sim.rope.pts));
        if (t >= 1) done.push(s.id);
      }
      if (done.length) {
        for (const id of done) { suckSim.current.delete(id); suckEls.current.delete(id); }
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
            <path key={c.id} ref={(el) => { const m = cableEls.current; if (el) m.set(c.id, el); else m.delete(c.id); }}
              data-testid={`cable-${c.id}`} d={d}
              fill="none" stroke={active ? AMBER : BLUE} strokeWidth={CABLE_W}
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
              fill="none" stroke={BLUE} strokeWidth={snapDot ? CABLE_W + 0.5 : CABLE_W} strokeLinecap="round" />
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
        <path ref={recoilRef} data-testid="patch-recoil" fill="none" stroke={BLUE} strokeWidth={CABLE_W}
          strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
      )}

      {/* cables being slurped back into their port — the `d` is driven by the rope sim each frame */}
      {sucks.map((s) => (
        <path key={s.id} data-testid="patch-suck"
          ref={(el) => { if (el) suckEls.current.set(s.id, el); else suckEls.current.delete(s.id); }}
          fill="none" stroke={BLUE} strokeWidth={CABLE_W} strokeLinejoin="round" strokeLinecap="round"
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
