import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";
import type { DeviceProposal, RoomProposal } from "./planDetect";
import { pointInPolygon, polygonCentroid, type NormPoint } from "./floorPlanOps";
import { suggestDeviceCode } from "./floorDeviceOps";

export type DeviceCommit =
  | { kind: "place"; deviceId: string }
  | { kind: "duplicate" }
  | { kind: "create"; code: string };

export type RoomCommit =
  | { kind: "attach"; roomId: string }
  | { kind: "create"; code: string };

const CODE_RE = /^[A-Za-z0-9_-]+$/;

/** Match the proposal's label against the inventory by code (case-insensitive). Existing +
 *  unplaced → place it; existing + already placed → duplicate (never create, the code is
 *  site-unique); no match → create, preferring the plan's label as the code when it's clean/free.
 *
 *  The two lists are deliberately different scopes. `devices` is THIS FLOOR (what the canvas holds)
 *  and drives the MATCH — matching site-wide would place another floor's device onto this plan,
 *  where it wouldn't even render. `siteCodes` is every code at the SITE and is the code SPACE,
 *  because the database constrains codes with `unique (site_id, code)`: generating from the floor's
 *  codes alone hands back a code another floor already owns, and the create then fails. It defaults
 *  to the floor's own codes so a caller that genuinely has only one floor's worth stays correct. */
export function planDeviceCommit(
  p: DeviceProposal,
  devices: FloorDeviceRow[],
  siteCodes: string[] = devices.map((d) => d.code)
): DeviceCommit {
  const label = p.label.trim();
  const labelUp = label.toUpperCase();
  if (label) {
    const match = devices.find((d) => d.code.toUpperCase() === labelUp);
    if (match) {
      const placed = match.x != null && match.y != null;
      return placed ? { kind: "duplicate" } : { kind: "place", deviceId: match.id };
    }
  }
  const free = !!label && CODE_RE.test(label) && !siteCodes.some((c) => c.toUpperCase() === labelUp);
  return { kind: "create", code: free ? label : suggestDeviceCode(p.typeCode, siteCodes) };
}

/** How far apart two devices' Y can be and still count as the same run along a wall. In normalized
 *  plan units, so ~0.02 of a 1733px-tall sheet is ~35px — wider than the few pixels of jitter along
 *  one wall, far narrower than the gap between opposite walls of a room. */
const ROW_BAND = 0.02;

/** A room only participates in ordering if it has been traced; an untraced room contains nothing. */
type OrderingRoom = { code: string; plan_polygon: NormPoint[] | null };

/** Reading order with a tolerance band: top-to-bottom by row, left-to-right within a row.
 *
 *  The band is the point. A straight sort on Y alone interleaves two devices 1px apart vertically
 *  but a metre apart horizontally, which is exactly the "the numbers are random" complaint — a run
 *  of outlets along one wall has to come out consecutive. Banding is greedy from the topmost device
 *  rather than fixed buckets, so two devices 0.3px apart can never fall either side of a boundary. */
function readingOrder<T extends { point: NormPoint }>(items: T[]): T[] {
  const byY = [...items].sort((a, b) => a.point[1] - b.point[1]);
  const out: T[] = [];
  let row: T[] = [];
  let rowTop = 0;
  for (const it of byY) {
    if (row.length === 0 || it.point[1] - rowTop <= ROW_BAND) {
      if (row.length === 0) rowTop = it.point[1];
      row.push(it);
      continue;
    }
    out.push(...row.sort((a, b) => a.point[0] - b.point[0]));
    row = [it];
    rowTop = it.point[1];
  }
  out.push(...row.sort((a, b) => a.point[0] - b.point[0]));
  return out;
}

/**
 * Put device proposals into the order a cabling crew would walk them: room by room, and within a
 * room along each wall run.
 *
 * Without this the numbers follow whatever order the matcher happened to find clusters in, so two
 * outlets on the same wall can be TO03 and TO17. That is useless on site, where the numbering is
 * what tells someone which port they are standing in front of.
 *
 * Rooms come first when the floor has any TRACED — grouping by room is what makes a drop list read
 * "011 is TO05-TO08". Rooms themselves are visited in reading order, by centroid. Devices in no
 * traced room keep the same reading order and go last, so an untraced floor still numbers sensibly
 * rather than not at all.
 */
export function orderDeviceProposals(
  proposals: DeviceProposal[],
  rooms: OrderingRoom[] = []
): DeviceProposal[] {
  const traced = rooms.filter(
    (r): r is OrderingRoom & { plan_polygon: NormPoint[] } =>
      Array.isArray(r.plan_polygon) && r.plan_polygon.length >= 3
  );
  if (traced.length === 0) return readingOrder(proposals);

  const ordered = [...traced].sort((a, b) => {
    const [ax, ay] = polygonCentroid(a.plan_polygon);
    const [bx, by] = polygonCentroid(b.plan_polygon);
    // Same banding as devices: rooms side by side down a corridor read left-to-right, not by a
    // hair's difference in how their outlines were traced.
    if (Math.abs(ay - by) > ROW_BAND) return ay - by;
    return ax - bx || a.code.localeCompare(b.code);
  });

  const remaining = new Set(proposals);
  const out: DeviceProposal[] = [];
  for (const room of ordered) {
    const inside = [...remaining].filter((p) => pointInPolygon(p.point, room.plan_polygon));
    for (const p of inside) remaining.delete(p);
    out.push(...readingOrder(inside));
  }
  out.push(...readingOrder([...remaining]));
  return out;
}

/**
 * Label every device proposal `PREFIX + next free NN`, ignoring whatever text sits near it on the
 * plan.
 *
 * Labels used to be lifted from the nearest plan label, which is wrong often enough to be worse
 * than useless: a sheet's text sits where it fits, not where its device is, so a telecom outlet
 * would arrive named after the `GFI` tag or the dimension string that happened to be closest.
 *
 * Numbering runs against `takenCodes` AND accumulates its own output, so a batch of nineteen gets
 * nineteen distinct codes rather than nineteen copies of the first free one. Because every code it
 * produces is free at the site, `planDeviceCommit` reads them as `create` — they cannot collide with
 * an existing device and silently bind a proposal to it.
 */
export function numberDeviceProposals(
  proposals: DeviceProposal[],
  takenCodes: string[]
): DeviceProposal[] {
  const taken = [...takenCodes];
  return proposals.map((p) => {
    const code = suggestDeviceCode(p.typeCode, taken);
    taken.push(code);
    return { ...p, label: code };
  });
}

/** Attach to a polygon-less room matched by name OR code (case-insensitive); else create with a
 *  code prefixed by the room type (MDF/IDF) or "R" for generic rooms. suggestDeviceCode is a
 *  generic "prefix + next free NN" generator — reused here for room codes. */
export function planRoomCommit(p: RoomProposal, rooms: RoomRow[]): RoomCommit {
  const name = p.name.trim().toLowerCase();
  if (name) {
    const match = rooms.find(
      (r) => r.plan_polygon == null &&
        ((r.name ?? "").trim().toLowerCase() === name || r.code.toLowerCase() === name)
    );
    if (match) return { kind: "attach", roomId: match.id };
  }
  const prefix = p.roomType === "other" ? "R" : p.roomType;
  return { kind: "create", code: suggestDeviceCode(prefix, rooms.map((r) => r.code)) };
}

/** Fraction of a proposal's own area that must sit inside an already-traced room before we treat
 *  it as a re-discovery of that room. Deliberately generous: the model returns rough axis-aligned
 *  boxes (measured mean IoU ~0.5 against hand-traced outlines), so requiring a tight match would
 *  let obvious duplicates through. Adjacent rooms merely SHARING a wall have zero overlap area and
 *  are unaffected. */
const TRACED_OVERLAP_THRESHOLD = 0.35;

function bounds(polygon: NormPoint[]) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** Drop proposals that land on a room the user has ALREADY outlined by hand. Discovery exists to
 *  fill in what is missing; re-proposing finished work is noise the user has to dismiss every run.
 *  Rooms with no polygon are left alone — those are precisely what the pass is for.
 *
 *  Overlap is measured as a fraction of the PROPOSAL's area, not IoU: a small proposal sitting
 *  wholly inside a large traced room is a duplicate even though its IoU would be low. */
export function filterAlreadyTraced(proposals: RoomProposal[], rooms: RoomRow[]): RoomProposal[] {
  const traced = rooms
    .map((r) => r.plan_polygon)
    .filter((p): p is NormPoint[] => Array.isArray(p) && p.length >= 3)
    .map(bounds);
  if (traced.length === 0) return proposals;
  return proposals.filter((proposal) => {
    const p = bounds(proposal.polygon);
    const area = (p.x1 - p.x0) * (p.y1 - p.y0);
    if (area <= 0) return true;
    return !traced.some((t) => {
      const ix = Math.max(0, Math.min(p.x1, t.x1) - Math.max(p.x0, t.x0));
      const iy = Math.max(0, Math.min(p.y1, t.y1) - Math.max(p.y0, t.y0));
      return (ix * iy) / area >= TRACED_OVERLAP_THRESHOLD;
    });
  });
}
