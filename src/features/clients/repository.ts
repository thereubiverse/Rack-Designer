import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomType } from "@/domain/hierarchy";
import type { ClientRow, SiteRow } from "@/lib/supabase/types";
import { normaliseCode, type CascadeCounts } from "./validation";

export interface ClientSummary {
  id: string;
  code: string;
  name: string;
  siteCount: number;
  rackCount: number;
  deviceCount: number;
}

export interface SiteSummary {
  id: string;
  code: string;
  name: string;
  address: string | null;
  rackCount: number;
  deviceCount: number;
}

export interface SiteRackRow {
  id: string;
  code: string;
  heightU: number;
  floorCode: string;
  roomCode: string;
  roomType: RoomType;
  deviceCount: number;
}

export async function listClients(db: SupabaseClient): Promise<ClientSummary[]> {
  const { data: clients, error } = await db
    .from("clients")
    .select("*")
    .order("code", { ascending: true });
  if (error) throw new Error(`listClients: ${error.message}`);

  const rows = (clients ?? []) as ClientRow[];
  return Promise.all(
    rows.map(async (client) => {
      const counts = await countClientCascade(db, client.id);
      return {
        id: client.id,
        code: client.code,
        name: client.name,
        siteCount: counts.sites ?? 0,
        rackCount: counts.racks ?? 0,
        deviceCount: counts.devices ?? 0,
      };
    })
  );
}

export async function getClientByCode(db: SupabaseClient, code: string): Promise<ClientRow | null> {
  // Codes are always stored normalised (uppercase, trimmed) — see normaliseCode. Matching on the
  // normalised segment with `.eq` is exact and case-insensitive by construction, so it never treats
  // the URL segment as a LIKE pattern (no wildcard surface from `_`/`%` in a legal code).
  const { data, error } = await db
    .from("clients")
    .select("*")
    .eq("code", normaliseCode(code))
    .maybeSingle();
  if (error) throw new Error(`getClientByCode: ${error.message}`);
  return (data as ClientRow | null) ?? null;
}

export async function listSitesForClient(db: SupabaseClient, clientId: string): Promise<SiteSummary[]> {
  const { data: sites, error } = await db
    .from("sites")
    .select("*")
    .eq("client_id", clientId)
    .order("code", { ascending: true });
  if (error) throw new Error(`listSitesForClient: ${error.message}`);

  const rows = (sites ?? []) as SiteRow[];
  return Promise.all(
    rows.map(async (site) => {
      const counts = await countSiteCascade(db, site.id);
      return {
        id: site.id,
        code: site.code,
        name: site.name,
        address: site.address,
        rackCount: counts.racks ?? 0,
        deviceCount: counts.devices ?? 0,
      };
    })
  );
}

export async function getSiteByCode(
  db: SupabaseClient,
  clientId: string,
  code: string
): Promise<SiteRow | null> {
  // Same fix as getClientByCode: exact match on the normalised code, never `.ilike` on raw input.
  const { data, error } = await db
    .from("sites")
    .select("*")
    .eq("client_id", clientId)
    .eq("code", normaliseCode(code))
    .maybeSingle();
  if (error) throw new Error(`getSiteByCode: ${error.message}`);
  return (data as SiteRow | null) ?? null;
}

interface SiteRackJoinRow {
  id: string;
  code: string;
  height_u: number;
  rooms: {
    code: string;
    type: RoomType;
    floors: { code: string; site_id: string };
  };
}

export async function listRacksForSite(db: SupabaseClient, siteId: string): Promise<SiteRackRow[]> {
  const { data, error } = await db
    .from("racks")
    .select("id, code, height_u, rooms!inner(code, type, floors!inner(code, site_id))")
    .eq("rooms.floors.site_id", siteId)
    .order("code", { ascending: true });
  if (error) throw new Error(`listRacksForSite: ${error.message}`);

  const rows = (data ?? []) as unknown as SiteRackJoinRow[];
  const rackIds = rows.map((r) => r.id);
  const deviceCounts = await countDevicesPerRack(db, rackIds);

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    heightU: r.height_u,
    floorCode: r.rooms.floors.code,
    roomCode: r.rooms.code,
    roomType: r.rooms.type,
    deviceCount: deviceCounts.get(r.id) ?? 0,
  }));
}

async function countDevicesPerRack(db: SupabaseClient, rackIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (rackIds.length === 0) return counts;
  const { data, error } = await db.from("rack_devices").select("rack_id").in("rack_id", rackIds);
  if (error) throw new Error(`countDevicesPerRack: ${error.message}`);
  for (const row of (data ?? []) as { rack_id: string }[]) {
    counts.set(row.rack_id, (counts.get(row.rack_id) ?? 0) + 1);
  }
  return counts;
}

export async function createClient(
  db: SupabaseClient,
  input: { code: string; name: string }
): Promise<ClientRow> {
  const { data, error } = await db
    .from("clients")
    .insert({ code: normaliseCode(input.code), name: input.name })
    .select("*")
    .single();
  if (error) throw new Error(`createClient: ${error.message}`);
  return data as ClientRow;
}

export async function renameClient(
  db: SupabaseClient,
  id: string,
  input: { code: string; name: string }
): Promise<void> {
  const { error } = await db
    .from("clients")
    .update({ code: normaliseCode(input.code), name: input.name })
    .eq("id", id);
  if (error) throw new Error(`renameClient: ${error.message}`);
}

export async function deleteClient(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("clients").delete().eq("id", id);
  if (error) throw new Error(`deleteClient: ${error.message}`);
}

export async function createSiteForClient(
  db: SupabaseClient,
  input: { clientId: string; code: string; name: string; address?: string | null }
): Promise<SiteRow> {
  const { data, error } = await db
    .from("sites")
    .insert({
      client_id: input.clientId,
      code: normaliseCode(input.code),
      name: input.name,
      address: input.address ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createSiteForClient: ${error.message}`);
  return data as SiteRow;
}

export async function renameSite(
  db: SupabaseClient,
  id: string,
  input: { code: string; name: string; address?: string | null }
): Promise<void> {
  const { error } = await db
    .from("sites")
    .update({
      code: normaliseCode(input.code),
      name: input.name,
      address: input.address ?? null,
    })
    .eq("id", id);
  if (error) throw new Error(`renameSite: ${error.message}`);
}

export async function deleteSite(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("sites").delete().eq("id", id);
  if (error) throw new Error(`deleteSite: ${error.message}`);
}

export async function countSiteCascade(db: SupabaseClient, siteId: string): Promise<CascadeCounts> {
  const { data: floors } = await db.from("floors").select("id").eq("site_id", siteId);
  const floorIds = (floors ?? []).map((f) => f.id as string);
  if (floorIds.length === 0) return { racks: 0, devices: 0 };
  const { data: rooms } = await db.from("rooms").select("id").in("floor_id", floorIds);
  const roomIds = (rooms ?? []).map((r) => r.id as string);
  if (roomIds.length === 0) return { racks: 0, devices: 0 };
  const { data: racks } = await db.from("racks").select("id").in("room_id", roomIds);
  const rackIds = (racks ?? []).map((r) => r.id as string);
  if (rackIds.length === 0) return { racks: 0, devices: 0 };
  const { count } = await db.from("rack_devices").select("id", { count: "exact", head: true }).in("rack_id", rackIds);
  return { racks: rackIds.length, devices: count ?? 0 };
}

export interface RackBreadcrumb {
  clientCode: string;
  clientName: string;
  siteCode: string;
  siteName: string;
  rackCode: string;
}

/** Resolves a rack's path upward — rack -> room -> floor -> site -> client — so the rack builder
 *  can render a breadcrumb back to its directory listing. One round trip per hop, matching the
 *  existing siteScope helper's style; returns null if any hop is missing (orphaned/racing delete). */
export async function getRackBreadcrumb(db: SupabaseClient, rackId: string): Promise<RackBreadcrumb | null> {
  const { data: rack, error: e1 } = await db.from("racks").select("code, room_id").eq("id", rackId).maybeSingle();
  if (e1) throw new Error(`getRackBreadcrumb(rack): ${e1.message}`);
  if (!rack) return null;

  const { data: room, error: e2 } = await db.from("rooms").select("floor_id").eq("id", rack.room_id).maybeSingle();
  if (e2) throw new Error(`getRackBreadcrumb(room): ${e2.message}`);
  if (!room) return null;

  const { data: floor, error: e3 } = await db.from("floors").select("site_id").eq("id", room.floor_id).maybeSingle();
  if (e3) throw new Error(`getRackBreadcrumb(floor): ${e3.message}`);
  if (!floor) return null;

  const { data: site, error: e4 } = await db
    .from("sites")
    .select("code, name, client_id")
    .eq("id", floor.site_id)
    .maybeSingle();
  if (e4) throw new Error(`getRackBreadcrumb(site): ${e4.message}`);
  if (!site) return null;

  const { data: client, error: e5 } = await db
    .from("clients")
    .select("code, name")
    .eq("id", site.client_id)
    .maybeSingle();
  if (e5) throw new Error(`getRackBreadcrumb(client): ${e5.message}`);
  if (!client) return null;

  return {
    clientCode: client.code,
    clientName: client.name,
    siteCode: site.code,
    siteName: site.name,
    rackCode: rack.code,
  };
}

export async function countClientCascade(db: SupabaseClient, clientId: string): Promise<CascadeCounts> {
  const { data: sites, error } = await db.from("sites").select("id").eq("client_id", clientId);
  if (error) throw new Error(`countClientCascade: ${error.message}`);
  const siteIds = (sites ?? []).map((s) => s.id as string);
  if (siteIds.length === 0) return { sites: 0, racks: 0, devices: 0 };

  const { data: floors } = await db.from("floors").select("id").in("site_id", siteIds);
  const floorIds = (floors ?? []).map((f) => f.id as string);
  if (floorIds.length === 0) return { sites: siteIds.length, racks: 0, devices: 0 };

  const { data: rooms } = await db.from("rooms").select("id").in("floor_id", floorIds);
  const roomIds = (rooms ?? []).map((r) => r.id as string);
  if (roomIds.length === 0) return { sites: siteIds.length, racks: 0, devices: 0 };

  const { data: racks } = await db.from("racks").select("id").in("room_id", roomIds);
  const rackIds = (racks ?? []).map((r) => r.id as string);
  if (rackIds.length === 0) return { sites: siteIds.length, racks: 0, devices: 0 };

  const { count } = await db.from("rack_devices").select("id", { count: "exact", head: true }).in("rack_id", rackIds);
  return { sites: siteIds.length, racks: rackIds.length, devices: count ?? 0 };
}
