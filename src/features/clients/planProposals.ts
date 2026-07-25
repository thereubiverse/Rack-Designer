import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";
import type { DeviceProposal, RoomProposal } from "./planDetect";
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
