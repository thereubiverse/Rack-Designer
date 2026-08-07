import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomType } from "@/domain/hierarchy";
import type { ClientRow, SiteRow } from "@/lib/supabase/types";
import type { GeocodeResult } from "./geocodeOps";
import { normaliseCode, type CascadeCounts } from "./validation";
import type { ArchivedClient, ArchivedFloor, ArchivedSite } from "./archiveOps";

export interface ClientSummary {
  id: string;
  code: string;
  name: string;
  siteCount: number;
  rackCount: number;
  /** EVERY device: mounted in racks AND placed on floor plans. The two live in different tables,
   *  and counting only the rack ones reported 0 for a client whose work so far was floor plans —
   *  and, worse, under-stated what a delete was about to destroy. */
  deviceCount: number;
}

export interface SiteSummary {
  id: string;
  code: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  geocodeStatus: SiteRow["geocode_status"];
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
  x: number | null;
  y: number | null;
}

export async function listClients(db: SupabaseClient): Promise<ClientSummary[]> {
  const { data: clients, error } = await db
    .from("clients")
    .select("*")
    // Archived clients are hidden everywhere they are LISTED. Cascade counters and upward scope
    // resolvers deliberately still see them — see the archive spec, section 4.
    .is("archived_at", null)
    .order("code", { ascending: true });
  if (error) throw new Error(`listClients: ${error.message}`);

  const rows = (clients ?? []) as ClientRow[];
  return Promise.all(
    rows.map(async (client) => {
      // NOT countClientCascade: that cascade deliberately counts archived sites/floors too (it
      // answers "what would a permanent delete destroy"), which is exactly wrong for a listing —
      // this row's counts must match what the client's own page actually lists below it. So the
      // site count comes straight from the live sites query, and rack/device counts are walked
      // through only THOSE sites' live floors via countLiveCascadeForSites.
      const { data: liveSites, error: sitesErr } = await db
        .from("sites")
        .select("id")
        .eq("client_id", client.id)
        .is("archived_at", null);
      if (sitesErr) throw new Error(`listClients(sites): ${sitesErr.message}`);
      const liveSiteIds = ((liveSites ?? []) as { id: string }[]).map((s) => s.id);
      const counts = await countLiveCascadeForSites(db, liveSiteIds);
      return {
        id: client.id,
        code: client.code,
        name: client.name,
        siteCount: liveSiteIds.length,
        rackCount: counts.racks,
        deviceCount: counts.devices,
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
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`getClientByCode: ${error.message}`);
  return (data as ClientRow | null) ?? null;
}

export async function listSitesForClient(db: SupabaseClient, clientId: string): Promise<SiteSummary[]> {
  const { data: sites, error } = await db
    .from("sites")
    .select("*")
    .eq("client_id", clientId)
    .is("archived_at", null)
    .order("code", { ascending: true });
  if (error) throw new Error(`listSitesForClient: ${error.message}`);

  const rows = (sites ?? []) as SiteRow[];
  return Promise.all(
    rows.map(async (site) => {
      // NOT countSiteCascade: see the matching comment in listClients — a listing's counts must
      // only reflect what's actually still visible, so archived floors under this (live) site are
      // excluded here even though the cascade counter deliberately keeps them.
      const counts = await countLiveCascadeForSites(db, [site.id]);
      return {
        id: site.id,
        code: site.code,
        name: site.name,
        address: site.address,
        latitude: site.latitude,
        longitude: site.longitude,
        geocodeStatus: site.geocode_status,
        rackCount: counts.racks,
        deviceCount: counts.devices,
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
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`getSiteByCode: ${error.message}`);
  return (data as SiteRow | null) ?? null;
}

export async function getSiteById(db: SupabaseClient, id: string): Promise<SiteRow | null> {
  const { data, error } = await db.from("sites").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getSiteById: ${error.message}`);
  return (data as SiteRow | null) ?? null;
}

interface SiteRackJoinRow {
  id: string;
  code: string;
  height_u: number;
  x: number | null;
  y: number | null;
  rooms: {
    code: string;
    type: RoomType;
    floors: { code: string; site_id: string };
  };
}

export async function listRacksForSite(db: SupabaseClient, siteId: string): Promise<SiteRackRow[]> {
  // SiteDetail.tsx builds its floor/room code datalists straight from this list (`floorOptions`,
  // `roomOptions` — the pickers offered when adding a rack), so a rack sitting under an archived
  // floor must not surface that floor's code here: the floor is already unreachable (its tab is
  // gone from `listFloorsForSite`), and offering the code would just walk a user back into the
  // findOrCreateFloor collision that finding 1 fixes. This is a LISTING, so it follows the same
  // archived_at is null rule as every other list query.
  const { data, error } = await db
    .from("racks")
    .select("id, code, height_u, x, y, rooms!inner(code, type, floors!inner(code, site_id, archived_at))")
    .eq("rooms.floors.site_id", siteId)
    .is("rooms.floors.archived_at", null)
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
    x: r.x,
    y: r.y,
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
  input: { code: string; name: string; orgId: string }
): Promise<ClientRow> {
  const { data, error } = await db
    .from("clients")
    .insert({ code: normaliseCode(input.code), name: input.name, org_id: input.orgId })
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

/** Archive rather than delete. The flag goes on THIS row only — children are untouched, which is
 *  what lets restoreClient put everything back exactly as it was, ids and all. Nothing in Slice G1
 *  calls `.delete()` on clients, sites or floors. */
export async function archiveClient(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from("clients")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`archiveClient: ${error.message}`);
}

export async function restoreClient(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("clients").update({ archived_at: null }).eq("id", id);
  if (error) throw new Error(`restoreClient: ${error.message}`);
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

export async function archiveSite(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from("sites")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`archiveSite: ${error.message}`);
}

export async function restoreSite(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("sites").update({ archived_at: null }).eq("id", id);
  if (error) throw new Error(`restoreSite: ${error.message}`);
}

/** Maps a GeocodeResult onto the four geocode columns and stamps geocoded_at with "now". Callers
 *  (createSiteAction, renameSiteAction, locateSiteAction, the backfill script) are responsible for
 *  making sure a failure here never fails the write it decorates — this function itself still
 *  throws on a DB error, same as every other repository function, so callers must catch it. */
export async function setSiteGeocode(db: SupabaseClient, siteId: string, result: GeocodeResult): Promise<void> {
  // `not_found` is definitive (the service ran and matched nothing) so the old pin is wrong and
  // must be cleared. `failed` is transient (the service errored/timed out) so the existing
  // latitude/longitude are left untouched — a retry-worthy blip must never erase a good pin.
  const patch =
    result.status === "ok"
      ? { latitude: result.lat, longitude: result.lng, geocode_status: "ok" as const }
      : result.status === "not_found"
        ? { latitude: null, longitude: null, geocode_status: "not_found" as const }
        : { geocode_status: "failed" as const };

  const { error } = await db
    .from("sites")
    .update({ ...patch, geocoded_at: new Date().toISOString() })
    .eq("id", siteId);
  if (error) throw new Error(`setSiteGeocode: ${error.message}`);
}

export async function countSiteCascade(db: SupabaseClient, siteId: string): Promise<CascadeCounts> {
  // Counted FIRST, and added to every return below: floor devices hang off the site directly, so a
  // site can hold hundreds of outlets without a single rack. Every early return here used to report
  // "0 devices" in that case — in a dialog asking whether to delete them.
  const floorDevices = await countFloorDevicesForSites(db, [siteId]);
  const { data: floors } = await db.from("floors").select("id").eq("site_id", siteId);
  const floorIds = (floors ?? []).map((f) => f.id as string);
  if (floorIds.length === 0) return { racks: 0, devices: floorDevices };
  const { data: rooms } = await db.from("rooms").select("id").in("floor_id", floorIds);
  const roomIds = (rooms ?? []).map((r) => r.id as string);
  if (roomIds.length === 0) return { racks: 0, devices: floorDevices };
  const { data: racks } = await db.from("racks").select("id").in("room_id", roomIds);
  const rackIds = (racks ?? []).map((r) => r.id as string);
  if (rackIds.length === 0) return { racks: 0, devices: floorDevices };
  const { count } = await db.from("rack_devices").select("id", { count: "exact", head: true }).in("rack_id", rackIds);
  return { racks: rackIds.length, devices: (count ?? 0) + floorDevices };
}

/** Rack/device count under a set of (already-live) sites, restricted to floors that are NOT
 *  archived. This is the listing-layer counterpart to countSiteCascade/countClientCascade: it
 *  exists solely so `/clients` and a client's site list show counts that match what their own
 *  page actually lists, instead of the cascade counters' deliberately-inclusive-of-archived total.
 *  floor_devices are counted by `floor_id` (not `site_id` like countSiteCascade does) precisely
 *  because that's the one column that lets an archived floor's devices be excluded. */
async function countLiveCascadeForSites(db: SupabaseClient, siteIds: string[]): Promise<{ racks: number; devices: number }> {
  if (siteIds.length === 0) return { racks: 0, devices: 0 };

  const { data: floors, error: floorsErr } = await db
    .from("floors")
    .select("id")
    .in("site_id", siteIds)
    .is("archived_at", null);
  if (floorsErr) throw new Error(`countLiveCascadeForSites(floors): ${floorsErr.message}`);
  const floorIds = ((floors ?? []) as { id: string }[]).map((f) => f.id);
  if (floorIds.length === 0) return { racks: 0, devices: 0 };

  const { count: floorDeviceCount, error: fdErr } = await db
    .from("floor_devices")
    .select("id", { count: "exact", head: true })
    .in("floor_id", floorIds);
  if (fdErr) throw new Error(`countLiveCascadeForSites(floor_devices): ${fdErr.message}`);

  const { data: rooms, error: roomsErr } = await db.from("rooms").select("id").in("floor_id", floorIds);
  if (roomsErr) throw new Error(`countLiveCascadeForSites(rooms): ${roomsErr.message}`);
  const roomIds = ((rooms ?? []) as { id: string }[]).map((r) => r.id);
  if (roomIds.length === 0) return { racks: 0, devices: floorDeviceCount ?? 0 };

  const { data: racks, error: racksErr } = await db.from("racks").select("id").in("room_id", roomIds);
  if (racksErr) throw new Error(`countLiveCascadeForSites(racks): ${racksErr.message}`);
  const rackIds = ((racks ?? []) as { id: string }[]).map((r) => r.id);
  if (rackIds.length === 0) return { racks: 0, devices: floorDeviceCount ?? 0 };

  const { count: rackDeviceCount, error: rdErr } = await db
    .from("rack_devices")
    .select("id", { count: "exact", head: true })
    .in("rack_id", rackIds);
  if (rdErr) throw new Error(`countLiveCascadeForSites(rack_devices): ${rdErr.message}`);

  return { racks: rackIds.length, devices: (rackDeviceCount ?? 0) + (floorDeviceCount ?? 0) };
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

/** Floor-plan devices for a set of sites, counted through `floor_devices.site_id` — the table
 *  carries the site directly, so this never has to walk floors and rooms the way the rack path
 *  does. An empty list short-circuits: `.in()` on one is an error, not an empty result. */
async function countFloorDevicesForSites(db: SupabaseClient, siteIds: string[]): Promise<number> {
  if (siteIds.length === 0) return 0;
  const { count } = await db
    .from("floor_devices")
    .select("id", { count: "exact", head: true })
    .in("site_id", siteIds);
  return count ?? 0;
}

export async function countClientCascade(db: SupabaseClient, clientId: string): Promise<CascadeCounts> {
  const { data: sites, error } = await db.from("sites").select("id").eq("client_id", clientId);
  if (error) throw new Error(`countClientCascade: ${error.message}`);
  const siteIds = (sites ?? []).map((s) => s.id as string);
  if (siteIds.length === 0) return { sites: 0, racks: 0, devices: 0 };

  // See countSiteCascade: floor devices are counted up front and carried through every early
  // return, because they exist independently of whether the client owns a single rack.
  const floorDevices = await countFloorDevicesForSites(db, siteIds);

  const { data: floors } = await db.from("floors").select("id").in("site_id", siteIds);
  const floorIds = (floors ?? []).map((f) => f.id as string);
  if (floorIds.length === 0) return { sites: siteIds.length, racks: 0, devices: floorDevices };

  const { data: rooms } = await db.from("rooms").select("id").in("floor_id", floorIds);
  const roomIds = (rooms ?? []).map((r) => r.id as string);
  if (roomIds.length === 0) return { sites: siteIds.length, racks: 0, devices: floorDevices };

  const { data: racks } = await db.from("racks").select("id").in("room_id", roomIds);
  const rackIds = (racks ?? []).map((r) => r.id as string);
  if (rackIds.length === 0) return { sites: siteIds.length, racks: 0, devices: floorDevices };

  const { count } = await db.from("rack_devices").select("id", { count: "exact", head: true }).in("rack_id", rackIds);
  return { sites: siteIds.length, racks: rackIds.length, devices: (count ?? 0) + floorDevices };
}

/** Everything the archive page needs, in five queries: the archived rows at each level, plus the
 *  LIVE clients and sites used to work out what each archived row nests under. The nesting itself is
 *  buildArchiveTree's job — this function only fetches. */
export async function listArchived(db: SupabaseClient): Promise<{
  archivedClients: ArchivedClient[];
  archivedSites: ArchivedSite[];
  archivedFloors: ArchivedFloor[];
  liveClients: { id: string; code: string; name: string }[];
  liveSites: { id: string; code: string; name: string; clientId: string }[];
}> {
  const [ac, as, af, lc, ls] = await Promise.all([
    db.from("clients").select("id, code, name, archived_at").not("archived_at", "is", null),
    db.from("sites").select("id, code, name, archived_at, client_id").not("archived_at", "is", null),
    db.from("floors").select("id, code, name, archived_at, site_id").not("archived_at", "is", null),
    db.from("clients").select("id, code, name").is("archived_at", null),
    db.from("sites").select("id, code, name, client_id").is("archived_at", null),
  ]);
  for (const r of [ac, as, af, lc, ls]) {
    if (r.error) throw new Error(`listArchived: ${r.error.message}`);
  }
  type Raw = Record<string, string | null>;
  return {
    archivedClients: ((ac.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name ?? ""), archivedAt: String(r.archived_at),
    })),
    archivedSites: ((as.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name ?? ""), archivedAt: String(r.archived_at),
      clientId: String(r.client_id),
    })),
    archivedFloors: ((af.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: r.name === null ? null : String(r.name),
      archivedAt: String(r.archived_at), siteId: String(r.site_id),
    })),
    liveClients: ((lc.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name ?? ""),
    })),
    liveSites: ((ls.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name ?? ""), clientId: String(r.client_id),
    })),
  };
}
