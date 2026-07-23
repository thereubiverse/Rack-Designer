import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomType } from "@/domain/hierarchy";
import { normaliseCode } from "@/features/clients/validation";
import { isNorm, isValidPolygon, type NormPoint } from "@/features/clients/floorPlanOps";
import type {
  SiteRow,
  FloorRow,
  RoomRow,
  RackRow,
  FloorDeviceRow,
  FloorPlanRow,
} from "@/lib/supabase/types";

export async function createSite(
  db: SupabaseClient,
  input: { clientId: string; code: string; name: string; address?: string }
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
  if (error) throw new Error(`createSite: ${error.message}`);
  return data as SiteRow;
}

export async function createFloor(
  db: SupabaseClient,
  input: { siteId: string; code: string; name?: string; sortOrder?: number }
): Promise<FloorRow> {
  const { data, error } = await db
    .from("floors")
    .insert({
      site_id: input.siteId,
      code: input.code,
      name: input.name ?? null,
      sort_order: input.sortOrder ?? 0,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createFloor: ${error.message}`);
  return data as FloorRow;
}

export async function createRoom(
  db: SupabaseClient,
  input: { floorId: string; code: string; name?: string; type: RoomType }
): Promise<RoomRow> {
  const { data, error } = await db
    .from("rooms")
    .insert({
      floor_id: input.floorId,
      code: input.code,
      name: input.name ?? null,
      type: input.type,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createRoom: ${error.message}`);
  return data as RoomRow;
}

export async function createRack(
  db: SupabaseClient,
  input: { roomId: string; code: string; name?: string; heightU: number }
): Promise<RackRow> {
  const { data, error } = await db
    .from("racks")
    .insert({
      room_id: input.roomId,
      code: input.code,
      name: input.name ?? null,
      height_u: input.heightU,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createRack: ${error.message}`);
  return data as RackRow;
}

export async function listFloorsForSite(db: SupabaseClient, siteId: string): Promise<FloorRow[]> {
  const { data, error } = await db.from("floors").select("*").eq("site_id", siteId)
    .order("sort_order", { ascending: true }).order("code", { ascending: true });
  if (error) throw new Error(`listFloorsForSite: ${error.message}`);
  return (data ?? []) as FloorRow[];
}

export async function listRoomsForSite(db: SupabaseClient, siteId: string): Promise<RoomRow[]> {
  const floors = await listFloorsForSite(db, siteId);
  if (floors.length === 0) return [];
  const { data, error } = await db.from("rooms").select("*")
    .in("floor_id", floors.map((f) => f.id)).order("code", { ascending: true });
  if (error) throw new Error(`listRoomsForSite: ${error.message}`);
  return (data ?? []) as RoomRow[];
}

export async function renameFloor(db: SupabaseClient, id: string, input: { code: string; name?: string | null }): Promise<void> {
  const { error } = await db.from("floors")
    .update({ code: normaliseCode(input.code), name: input.name ?? null }).eq("id", id);
  if (error) throw new Error(`renameFloor: ${error.message}`);
}

export async function deleteFloor(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("floors").delete().eq("id", id);
  if (error) throw new Error(`deleteFloor: ${error.message}`);
}

export async function renameRoom(db: SupabaseClient, id: string, input: { code: string; name?: string | null; type: RoomType }): Promise<void> {
  const { error } = await db.from("rooms")
    .update({ code: normaliseCode(input.code), name: input.name ?? null, type: input.type }).eq("id", id);
  if (error) throw new Error(`renameRoom: ${error.message}`);
}

export async function deleteRoom(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("rooms").delete().eq("id", id);
  if (error) throw new Error(`deleteRoom: ${error.message}`);
}

export async function listFloorDevicesForSite(db: SupabaseClient, siteId: string): Promise<FloorDeviceRow[]> {
  const { data, error } = await db.from("floor_devices").select("*")
    .eq("site_id", siteId).order("code", { ascending: true });
  if (error) throw new Error(`listFloorDevicesForSite: ${error.message}`);
  return (data ?? []) as FloorDeviceRow[];
}

/** site_id is NEVER taken from the caller — it is derived from the floor row, so the site-scoped
 *  code uniqueness cannot be subverted and a device cannot be created against the wrong site.
 *  Only category='floor' types are accepted: rack-mounted gear lives in rack_devices. */
export async function createFloorDevice(
  db: SupabaseClient,
  input: { floorId: string; roomId?: string | null; deviceTypeId: string; code: string; name?: string; status: "planned" | "installed" }
): Promise<FloorDeviceRow> {
  const { data: floor, error: floorErr } = await db.from("floors").select("id, site_id").eq("id", input.floorId).single();
  if (floorErr || !floor) throw new Error(`createFloorDevice: floor not found`);
  const { data: type, error: typeErr } = await db.from("device_types").select("id, category").eq("id", input.deviceTypeId).single();
  if (typeErr || !type) throw new Error(`createFloorDevice: device type not found`);
  if ((type as { category: string }).category !== "floor") throw new Error(`createFloorDevice: only floor device types can be placed on a floor`);
  const { data, error } = await db.from("floor_devices").insert({
    site_id: (floor as { site_id: string }).site_id,
    floor_id: input.floorId,
    room_id: input.roomId ?? null,
    device_type_id: input.deviceTypeId,
    code: normaliseCode(input.code),
    name: input.name ?? "",
    status: input.status,
  }).select("*").single();
  if (error) throw new Error(`createFloorDevice: ${error.message}`);
  return data as FloorDeviceRow;
}

/** Moving to another floor re-derives site_id from the NEW floor (still same-site in the UI, but
 *  the invariant must hold regardless of what the caller passes). */
export async function updateFloorDevice(
  db: SupabaseClient,
  id: string,
  patch: { floorId?: string; roomId?: string | null; deviceTypeId?: string; code?: string; name?: string; status?: "planned" | "installed" }
): Promise<void> {
  const applied: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.floorId !== undefined) {
    const { data: floor, error } = await db.from("floors").select("id, site_id").eq("id", patch.floorId).single();
    if (error || !floor) throw new Error(`updateFloorDevice: floor not found`);
    applied.floor_id = patch.floorId;
    applied.site_id = (floor as { site_id: string }).site_id;
  }
  if (patch.deviceTypeId !== undefined) {
    const { data: type, error } = await db.from("device_types").select("id, category").eq("id", patch.deviceTypeId).single();
    if (error || !type) throw new Error(`updateFloorDevice: device type not found`);
    if ((type as { category: string }).category !== "floor") throw new Error(`updateFloorDevice: only floor device types can be placed on a floor`);
    applied.device_type_id = patch.deviceTypeId;
  }
  if (patch.roomId !== undefined) applied.room_id = patch.roomId;
  if (patch.code !== undefined) applied.code = normaliseCode(patch.code);
  if (patch.name !== undefined) applied.name = patch.name;
  if (patch.status !== undefined) applied.status = patch.status;
  const { error } = await db.from("floor_devices").update(applied).eq("id", id);
  if (error) throw new Error(`updateFloorDevice: ${error.message}`);
}

export async function deleteFloorDevice(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("floor_devices").delete().eq("id", id);
  if (error) throw new Error(`deleteFloorDevice: ${error.message}`);
}

/** Site-wide, so the page loader can fetch every floor's plan (if any) in one round trip
 *  alongside racks/rooms/devices — same floors-lookup-then-`.in` shape as listRoomsForSite. */
export async function listFloorPlansForSite(db: SupabaseClient, siteId: string): Promise<FloorPlanRow[]> {
  const floors = await listFloorsForSite(db, siteId);
  if (floors.length === 0) return [];
  const { data, error } = await db.from("floor_plans").select("*")
    .in("floor_id", floors.map((f) => f.id));
  if (error) throw new Error(`listFloorPlansForSite: ${error.message}`);
  return (data ?? []) as FloorPlanRow[];
}

export async function getFloorPlan(db: SupabaseClient, floorId: string): Promise<FloorPlanRow | null> {
  const { data, error } = await db.from("floor_plans").select("*").eq("floor_id", floorId).maybeSingle();
  if (error) throw new Error(`getFloorPlan: ${error.message}`);
  return (data as FloorPlanRow | null) ?? null;
}

/** Floor must exist before a plan can be attached to it — this is a read, not a trust boundary
 *  the caller can skip. `.upsert` on floor_id conflict means re-uploading a plan for the same
 *  floor replaces the row rather than duplicating it (storage path is deterministic per floor). */
export async function upsertFloorPlan(
  db: SupabaseClient,
  input: {
    floorId: string;
    storagePath: string;
    widthPx: number;
    heightPx: number;
    originalFilename: string;
    source: "image" | "pdf";
  }
): Promise<FloorPlanRow> {
  const { data: floor, error: floorErr } = await db.from("floors").select("id").eq("id", input.floorId).single();
  if (floorErr || !floor) throw new Error(`upsertFloorPlan: floor not found`);
  const { data, error } = await db
    .from("floor_plans")
    .upsert(
      {
        floor_id: input.floorId,
        storage_path: input.storagePath,
        width_px: input.widthPx,
        height_px: input.heightPx,
        original_filename: input.originalFilename,
        source: input.source,
      },
      { onConflict: "floor_id" }
    )
    .select("*")
    .single();
  if (error) throw new Error(`upsertFloorPlan: ${error.message}`);
  return data as FloorPlanRow;
}

/** Deletes the plan row AND clears every placement that depended on it — devices lose their x/y,
 *  rooms lose their plan_polygon — all in the same flow, so a stale plan never leaves stale
 *  coordinates pointing at an image that no longer exists. */
export async function deleteFloorPlan(db: SupabaseClient, floorId: string): Promise<void> {
  const { error: planErr } = await db.from("floor_plans").delete().eq("floor_id", floorId);
  if (planErr) throw new Error(`deleteFloorPlan: ${planErr.message}`);
  const { error: devErr } = await db.from("floor_devices")
    .update({ x: null, y: null }).eq("floor_id", floorId);
  if (devErr) throw new Error(`deleteFloorPlan: ${devErr.message}`);
  const { error: roomErr } = await db.from("rooms")
    .update({ plan_polygon: null }).eq("floor_id", floorId);
  if (roomErr) throw new Error(`deleteFloorPlan: ${roomErr.message}`);
}

/** Both x and y are written in the SAME update — the DB enforces
 *  `(x is null) = (y is null)`, so a placement can never split the pair across two calls.
 *  `isNorm` uses `Number.isFinite` + range checks, never falsy coercion, so x=0/y=0 is a valid
 *  placement (Null Island), not a rejection. */
export async function placeFloorDevice(
  db: SupabaseClient,
  id: string,
  input: { x: number; y: number }
): Promise<void> {
  if (!isNorm(input.x) || !isNorm(input.y)) {
    throw new Error(`placeFloorDevice: coordinates must be within the plan`);
  }
  const { error } = await db.from("floor_devices")
    .update({ x: input.x, y: input.y }).eq("id", id);
  if (error) throw new Error(`placeFloorDevice: ${error.message}`);
}

export async function clearFloorDevicePlacement(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("floor_devices")
    .update({ x: null, y: null }).eq("id", id);
  if (error) throw new Error(`clearFloorDevicePlacement: ${error.message}`);
}

export async function placeRack(
  db: SupabaseClient,
  id: string,
  input: { x: number; y: number }
): Promise<void> {
  if (!isNorm(input.x) || !isNorm(input.y)) {
    throw new Error(`placeRack: coordinates must be within the plan`);
  }
  const { error } = await db.from("racks").update({ x: input.x, y: input.y }).eq("id", id);
  if (error) throw new Error(`placeRack: ${error.message}`);
}

/** Clears the placement only — the rack itself (and its devices) is untouched. */
export async function clearRackPlacement(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("racks").update({ x: null, y: null }).eq("id", id);
  if (error) throw new Error(`clearRackPlacement: ${error.message}`);
}

export async function setRoomPolygon(
  db: SupabaseClient,
  roomId: string,
  polygon: NormPoint[]
): Promise<void> {
  if (!isValidPolygon(polygon)) throw new Error(`setRoomPolygon: invalid polygon`);
  const { error } = await db.from("rooms")
    .update({ plan_polygon: polygon }).eq("id", roomId);
  if (error) throw new Error(`setRoomPolygon: ${error.message}`);
}

export async function clearRoomPolygon(db: SupabaseClient, roomId: string): Promise<void> {
  const { error } = await db.from("rooms")
    .update({ plan_polygon: null }).eq("id", roomId);
  if (error) throw new Error(`clearRoomPolygon: ${error.message}`);
}
