import { describe, it, expect } from "vitest";
import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";
import { suggestDeviceCode, groupDevicesByRoom } from "./floorDeviceOps";

function device(over: Partial<FloorDeviceRow>): FloorDeviceRow {
  return {
    id: "d1", site_id: "s1", floor_id: "f1", room_id: null, device_type_id: "t1",
    code: "CAM01", name: "", status: "planned",
    created_at: "2026-01-01", updated_at: "2026-01-01", ...over,
  };
}
function room(over: Partial<RoomRow>): RoomRow {
  return { id: "r1", floor_id: "f1", code: "MDF", name: null, type: "MDF", created_at: "2026-01-01", ...over };
}

describe("suggestDeviceCode", () => {
  it("starts at 01 on an empty site", () => {
    expect(suggestDeviceCode("CAM", [])).toBe("CAM01");
  });
  it("fills the LOWEST gap, not max+1", () => {
    expect(suggestDeviceCode("CAM", ["CAM01", "CAM03"])).toBe("CAM02");
  });
  it("counts per type independently and ignores other types' codes", () => {
    expect(suggestDeviceCode("AP", ["CAM01", "CAM02", "AP01"])).toBe("AP02");
  });
  it("rolls over past two digits without colliding", () => {
    const taken = Array.from({ length: 99 }, (_, i) => `CAM${String(i + 1).padStart(2, "0")}`);
    expect(suggestDeviceCode("CAM", taken)).toBe("CAM100");
  });
  it("is not fooled by a type code that PREFIXES another (TO vs TOX)", () => {
    // TOX01 must not count as a TO code — the numeric suffix must be the WHOLE remainder.
    expect(suggestDeviceCode("TO", ["TOX01"])).toBe("TO01");
  });
});

describe("groupDevicesByRoom", () => {
  const mdf = room({ id: "r-mdf", code: "MDF" });
  const idf = room({ id: "r-idf", code: "IDF", type: "IDF" });
  it("puts each device under its room, rooms sorted by code, devices sorted by code", () => {
    const g = groupDevicesByRoom(
      [mdf, idf],
      [device({ id: "a", code: "CAM02", room_id: "r-mdf" }), device({ id: "b", code: "CAM01", room_id: "r-mdf" })]
    );
    expect(g.sections.map((s) => s.room.code)).toEqual(["IDF", "MDF"]);
    expect(g.sections[1].devices.map((d) => d.code)).toEqual(["CAM01", "CAM02"]);
  });
  it("keeps empty rooms as sections (a room exists even with no devices)", () => {
    const g = groupDevicesByRoom([mdf], []);
    expect(g.sections).toHaveLength(1);
    expect(g.sections[0].devices).toEqual([]);
  });
  it("collects roomless devices into floorLevel", () => {
    const g = groupDevicesByRoom([mdf], [device({ id: "a", room_id: null })]);
    expect(g.floorLevel.map((d) => d.id)).toEqual(["a"]);
  });
  it("NEVER silently drops a device whose room_id matches no known room", () => {
    // Defensive: status quo says this can't happen, but a device must never vanish from the page.
    const g = groupDevicesByRoom([mdf], [device({ id: "a", room_id: "r-gone" })]);
    expect(g.floorLevel.map((d) => d.id)).toEqual(["a"]);
  });
});
