// The other racks on this rack's site, and the Switch-type devices inside them. Walks
// rack -> room -> floor -> site with plain queries (one round trip per hop is fine at this scale,
// matching the rack page's existing per-type template fan-out).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Face } from "@/domain/faceplate";

export interface SiteRackTarget { id: string; code: string }
export interface SiteSwitchTarget {
  id: string; code: string; rackId: string; rackCode: string;
  frontFace: Face | null; heightU: number | null;
}
export interface SiteScope { racks: SiteRackTarget[]; switches: SiteSwitchTarget[] }

const EMPTY: SiteScope = { racks: [], switches: [] };

export async function listSiteScope(db: SupabaseClient, rackId: string): Promise<SiteScope> {
  const { data: rack, error: e1 } = await db.from("racks").select("id, room_id").eq("id", rackId).single();
  if (e1) throw new Error(`listSiteScope(rack): ${e1.message}`);
  const { data: room, error: e2 } = await db.from("rooms").select("id, floor_id").eq("id", rack.room_id).single();
  if (e2) throw new Error(`listSiteScope(room): ${e2.message}`);
  const { data: floor, error: e3 } = await db.from("floors").select("id, site_id").eq("id", room.floor_id).single();
  if (e3) throw new Error(`listSiteScope(floor): ${e3.message}`);

  // site -> floors -> rooms -> racks
  const { data: floors, error: e4 } = await db.from("floors").select("id").eq("site_id", floor.site_id);
  if (e4) throw new Error(`listSiteScope(floors): ${e4.message}`);
  if (floors.length === 0) return EMPTY;
  const { data: rooms, error: e5 } = await db.from("rooms").select("id").in("floor_id", floors.map((f) => f.id));
  if (e5) throw new Error(`listSiteScope(rooms): ${e5.message}`);
  if (rooms.length === 0) return EMPTY;
  const { data: racks, error: e6 } = await db.from("racks").select("id, code").in("room_id", rooms.map((r) => r.id));
  if (e6) throw new Error(`listSiteScope(racks): ${e6.message}`);

  const others: SiteRackTarget[] = racks.filter((r) => r.id !== rackId).map((r) => ({ id: r.id, code: r.code }));
  if (others.length === 0) return { racks: [], switches: [] };

  // Switch-type templates -> the devices in those other racks that use them.
  const { data: swType, error: e7 } = await db.from("device_types")
    .select("id").eq("category", "rack").eq("code", "SW").maybeSingle();
  if (e7) throw new Error(`listSiteScope(swType): ${e7.message}`);
  if (!swType) return { racks: others, switches: [] };

  const { data: tpls, error: e8 } = await db.from("device_templates").select("id").eq("device_type_id", swType.id);
  if (e8) throw new Error(`listSiteScope(templates): ${e8.message}`);
  if (tpls.length === 0) return { racks: others, switches: [] };

  const { data: devs, error: e9 } = await db.from("rack_devices")
    .select("id, code, rack_id, front_face, height_u")
    .in("rack_id", others.map((r) => r.id))
    .in("device_template_id", tpls.map((t) => t.id));
  if (e9) throw new Error(`listSiteScope(devices): ${e9.message}`);

  const rackCode = Object.fromEntries(others.map((r) => [r.id, r.code]));
  const switches: SiteSwitchTarget[] = devs.map((d) => ({
    id: d.id, code: d.code, rackId: d.rack_id, rackCode: rackCode[d.rack_id] ?? "?",
    frontFace: (d.front_face as Face | null) ?? null, heightU: d.height_u,
  }));
  return { racks: others, switches };
}
