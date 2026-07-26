import { describe, it, expect } from "vitest";
import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";
import {
  numberDeviceProposals,
  planDeviceCommit,
  planRoomCommit,
  filterAlreadyTraced,
} from "./planProposals";
import type { DeviceProposal, RoomProposal } from "./planDetect";

function dev(over: Partial<FloorDeviceRow>): FloorDeviceRow {
  return {
    id: "d1", site_id: "s1", floor_id: "f1", room_id: null, device_type_id: "t1",
    code: "CAM01", name: "", status: "planned", x: null, y: null,
    created_at: "2026-01-01", updated_at: "2026-01-01", ...over,
  };
}
// NOTE: RoomRow has NO updated_at (verified in src/lib/supabase/types.ts) — do not add one.
function room(over: Partial<RoomRow>): RoomRow {
  return {
    id: "r1", floor_id: "f1", code: "MDF", name: null, type: "other",
    plan_polygon: null, created_at: "2026-01-01", ...over,
  };
}
const dprop = (over: Partial<DeviceProposal>): DeviceProposal =>
  ({ id: "dev-0", label: "CAM01", typeCode: "CAM", point: [0.5, 0.5], confidence: "high", ...over });
const rprop = (over: Partial<RoomProposal>): RoomProposal =>
  ({ id: "room-0", name: "MDF", roomType: "other", polygon: [[0, 0], [1, 0], [1, 1]], confidence: "high", ...over });

describe("planDeviceCommit", () => {
  it("places an existing UNPLACED device whose code matches the label (case-insensitive)", () => {
    const devices = [dev({ id: "x", code: "AP01" }), dev({ id: "cam", code: "CAM01", x: null, y: null })];
    expect(planDeviceCommit(dprop({ label: "cam01" }), devices)).toEqual({ kind: "place", deviceId: "cam" });
  });
  it("treats a label matching an already-PLACED device as a duplicate (no colliding create)", () => {
    const devices = [dev({ id: "cam", code: "CAM01", x: 0.2, y: 0.2 })];
    expect(planDeviceCommit(dprop({ label: "CAM01" }), devices)).toEqual({ kind: "duplicate" });
  });
  it("creates with the plan label as code when it is free and well-formed", () => {
    expect(planDeviceCommit(dprop({ label: "CAM07", typeCode: "CAM" }), [dev({ code: "CAM01" })]))
      .toEqual({ kind: "create", code: "CAM07" });
  });
  // Device codes are `unique (site_id, code)` but the canvas only ever holds ONE FLOOR's devices,
  // so the code space has to be passed in separately or every generated code is a coin flip on a
  // multi-floor site.
  it("generates around codes taken ELSEWHERE at the site, not just on this floor", () => {
    const thisFloor = [dev({ code: "CAM01" })];
    const siteCodes = ["CAM01", "CAM02", "CAM03"]; // CAM02/CAM03 live on other floors
    expect(planDeviceCommit(dprop({ label: "", typeCode: "CAM" }), thisFloor, siteCodes))
      .toEqual({ kind: "create", code: "CAM04" });
  });
  it("refuses a label already used at the site even though this floor is free of it", () => {
    const thisFloor = [dev({ code: "CAM01" })];
    // CAM07 is another floor's device: creating with it would break the site-unique constraint,
    // and matching it would place a device that isn't even on this plan.
    const res = planDeviceCommit(dprop({ label: "CAM07", typeCode: "CAM" }), thisFloor, ["CAM01", "CAM07"]);
    expect(res).toEqual({ kind: "create", code: "CAM02" });
  });
  it("defaults the code space to the given devices when the caller has no site-wide list", () => {
    const devices = [dev({ code: "CAM01" }), dev({ code: "CAM02" })];
    expect(planDeviceCommit(dprop({ label: "", typeCode: "CAM" }), devices))
      .toEqual({ kind: "create", code: "CAM03" });
  });
  it("falls back to suggestDeviceCode when the label is empty or malformed", () => {
    const devices = [dev({ code: "CAM01" }), dev({ code: "CAM02" })];
    expect(planDeviceCommit(dprop({ label: "", typeCode: "CAM" }), devices)).toEqual({ kind: "create", code: "CAM03" });
    expect(planDeviceCommit(dprop({ label: "cam 7!", typeCode: "CAM" }), devices)).toEqual({ kind: "create", code: "CAM03" });
  });
});

describe("planRoomCommit", () => {
  it("attaches to an existing polygon-less room matched by name (case-insensitive)", () => {
    const rooms = [
      room({ id: "other", code: "STORAGE", name: "Storage Closet" }),
      room({ id: "a", code: "MDF", name: "Main Dist Frame" }),
    ];
    expect(planRoomCommit(rprop({ name: "main dist frame" }), rooms)).toEqual({ kind: "attach", roomId: "a" });
  });
  it("also matches a polygon-less room by code", () => {
    const rooms = [
      room({ id: "other", code: "IDF", name: "Secondary" }),
      room({ id: "a", code: "MDF" }),
    ];
    expect(planRoomCommit(rprop({ name: "MDF" }), rooms))
      .toEqual({ kind: "attach", roomId: "a" });
  });
  it("does NOT attach to a room that already has a polygon", () => {
    const rooms = [
      room({ id: "a", code: "MDF", name: "Main Dist Frame", plan_polygon: [[0, 0], [1, 0], [1, 1]] }),
      room({ id: "b", code: "OTHER", name: "Other Room" }),
    ];
    const res = planRoomCommit(rprop({ name: "MDF", roomType: "other" }), rooms);
    expect(res.kind).toBe("create");
  });
  it("skips a polygon-having match and keeps searching for a polygon-less one", () => {
    const rooms = [
      room({ id: "a", code: "MDF", name: "BACKUP", plan_polygon: [[0, 0], [1, 0], [1, 1]] }),
      room({ id: "b", code: "BACKUP", name: "Spare Room", plan_polygon: null }),
    ];
    expect(planRoomCommit(rprop({ name: "BACKUP" }), rooms)).toEqual({ kind: "attach", roomId: "b" });
  });
  it("creates with an R-prefixed code for other-type rooms, type prefix otherwise", () => {
    expect(planRoomCommit(rprop({ name: "Community", roomType: "other" }), [room({ code: "R01" })]))
      .toEqual({ kind: "create", code: "R02" });
    expect(planRoomCommit(rprop({ name: "Closet", roomType: "IDF" }), [room({ code: "IDF01" })]))
      .toEqual({ kind: "create", code: "IDF02" });
  });
  it("creates when rooms array is empty", () => {
    const res = planRoomCommit(rprop({ name: "MDF", roomType: "other" }), []);
    expect(res.kind).toBe("create");
  });
  it("creates when proposal name is whitespace-only", () => {
    const rooms = [room({ id: "a", code: "MDF", name: "Main Dist Frame" })];
    const res = planRoomCommit(rprop({ name: "   " }), rooms);
    expect(res.kind).toBe("create");
  });
  it("trims whitespace around proposal name before matching", () => {
    const rooms = [room({ id: "a", code: "MDF", name: "Main Dist Frame" })];
    expect(planRoomCommit(rprop({ name: "  MDF  " }), rooms)).toEqual({ kind: "attach", roomId: "a" });
  });
});

describe("filterAlreadyTraced", () => {
  const prop = (id: string, poly: [number, number][]): RoomProposal =>
    ({ id, name: "X", roomType: "other", polygon: poly, confidence: "high" });
  // A room the user has already outlined by hand, occupying the top-left quarter.
  const tracedRoom = room({
    id: "traced", code: "MO", plan_polygon: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]],
  });

  it("drops a proposal that lands on an already-traced room", () => {
    const p = prop("room-0", [[0.12, 0.12], [0.38, 0.12], [0.38, 0.38], [0.12, 0.38]]);
    expect(filterAlreadyTraced([p], [tracedRoom])).toEqual([]);
  });

  it("keeps a proposal somewhere else entirely", () => {
    const p = prop("room-0", [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]]);
    expect(filterAlreadyTraced([p], [tracedRoom]).map((r) => r.id)).toEqual(["room-0"]);
  });

  it("keeps a proposal that merely abuts a traced room (shared wall, no real overlap)", () => {
    // Sits immediately to the right, sharing the x=0.4 wall.
    const p = prop("room-0", [[0.4, 0.1], [0.7, 0.1], [0.7, 0.4], [0.4, 0.4]]);
    expect(filterAlreadyTraced([p], [tracedRoom]).map((r) => r.id)).toEqual(["room-0"]);
  });

  it("ignores rooms that have NO polygon — those are exactly what discovery is for", () => {
    const untraced = room({ id: "untraced", code: "NEW", plan_polygon: null });
    const p = prop("room-0", [[0.12, 0.12], [0.38, 0.12], [0.38, 0.38], [0.12, 0.38]]);
    expect(filterAlreadyTraced([p], [untraced]).map((r) => r.id)).toEqual(["room-0"]);
  });

  it("drops only the overlapping proposals, keeping the rest (non-first fixture)", () => {
    const a = prop("room-0", [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]]);
    const b = prop("room-1", [[0.12, 0.12], [0.38, 0.12], [0.38, 0.38], [0.12, 0.38]]);
    const c = prop("room-2", [[0.5, 0.05], [0.6, 0.05], [0.6, 0.15], [0.5, 0.15]]);
    expect(filterAlreadyTraced([a, b, c], [tracedRoom]).map((r) => r.id)).toEqual(["room-0", "room-2"]);
  });

  it("returns everything when there are no traced rooms at all", () => {
    const p = prop("room-0", [[0.12, 0.12], [0.38, 0.12], [0.38, 0.38], [0.12, 0.38]]);
    expect(filterAlreadyTraced([p], []).map((r) => r.id)).toEqual(["room-0"]);
  });
});

describe("numberDeviceProposals", () => {
  const dp = (id: string, typeCode: string, label = "GFI"): DeviceProposal => ({
    id,
    label,
    typeCode,
    point: [0.5, 0.5],
    confidence: "high",
  });

  it("replaces the plan's text with PREFIX + number", () => {
    // The whole point: a telecom outlet must not be named after the `GFI` tag that happened to be
    // nearest it on the sheet.
    const out = numberDeviceProposals([dp("a", "TO"), dp("b", "TO")], []);
    expect(out.map((p) => p.label)).toEqual(["TO01", "TO02"]);
  });

  it("gives a batch DISTINCT codes, not N copies of the first free one", () => {
    const out = numberDeviceProposals(Array.from({ length: 19 }, (_, i) => dp(`d${i}`, "TO")), []);
    expect(new Set(out.map((p) => p.label)).size).toBe(19);
    expect(out[18].label).toBe("TO19");
  });

  it("steps over codes the site already uses", () => {
    const out = numberDeviceProposals([dp("a", "TO")], ["TO01", "TO02"]);
    expect(out[0].label).toBe("TO03");
  });

  it("numbers each type independently", () => {
    const out = numberDeviceProposals([dp("a", "TO"), dp("b", "CAM"), dp("c", "TO")], []);
    expect(out.map((p) => p.label)).toEqual(["TO01", "CAM01", "TO02"]);
  });

  it("leaves everything except the label alone", () => {
    const [out] = numberDeviceProposals([dp("a", "TO")], []);
    expect(out).toMatchObject({ id: "a", typeCode: "TO", point: [0.5, 0.5], confidence: "high" });
  });

  it("produces codes that commit as CREATE — never silently binding to an existing device", () => {
    // A generated code is free by construction, so planDeviceCommit can't read it as "place that
    // one". Numbering must not quietly attach nineteen proposals to whatever is in the inventory.
    const [out] = numberDeviceProposals([dp("a", "TO")], ["TO01"]);
    expect(planDeviceCommit(out, [], ["TO01"])).toEqual({ kind: "create", code: "TO02" });
  });
});
