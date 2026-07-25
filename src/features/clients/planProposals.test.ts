import { describe, it, expect } from "vitest";
import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";
import { planDeviceCommit, planRoomCommit } from "./planProposals";
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
  it("prefers a polygon-less room matching by code over a polygon-having room matching by name", () => {
    const rooms = [
      room({ id: "a", code: "MDF", name: "Main Dist Frame", plan_polygon: [[0, 0], [1, 0], [1, 1]] }),
      room({ id: "b", code: "BACKUP", plan_polygon: null }),
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
});
