import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";
import type { DeviceProposal, RoomProposal } from "./planDetect";
import type { NormPoint } from "./floorPlanOps";
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
