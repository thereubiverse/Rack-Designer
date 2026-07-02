import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomType } from "@/domain/hierarchy";
import { buildLabel } from "@/domain/naming";
import type {
  OrganizationRow,
  SiteRow,
  FloorRow,
  RoomRow,
  RackRow,
} from "@/lib/supabase/types";

export interface RackWithPath {
  id: string;
  label: string;
  siteCode: string;
  floorCode: string;
  roomCode: string;
  roomType: RoomType;
  rackCode: string;
  heightU: number;
}

export async function getDefaultOrganization(db: SupabaseClient): Promise<OrganizationRow> {
  const { data, error } = await db
    .from("organizations")
    .select("*")
    .eq("code", "DEFAULT")
    .single();
  if (error) throw new Error(`getDefaultOrganization: ${error.message}`);
  return data as OrganizationRow;
}

export async function createSite(
  db: SupabaseClient,
  input: { code: string; name: string; address?: string }
): Promise<SiteRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db
    .from("sites")
    .insert({
      organization_id: org.id,
      code: input.code,
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

interface RackJoinRow {
  id: string;
  code: string;
  height_u: number;
  rooms: {
    code: string;
    type: RoomType;
    floors: {
      code: string;
      sites: { code: string };
    };
  };
}

export async function listRacksWithPath(db: SupabaseClient): Promise<RackWithPath[]> {
  const { data, error } = await db
    .from("racks")
    .select("id, code, height_u, rooms!inner(code, type, floors!inner(code, sites!inner(code)))")
    .order("code", { ascending: true });
  if (error) throw new Error(`listRacksWithPath: ${error.message}`);

  const rows = (data ?? []) as unknown as RackJoinRow[];
  return rows.map((r) => {
    const siteCode = r.rooms.floors.sites.code;
    const floorCode = r.rooms.floors.code;
    const roomCode = r.rooms.code;
    return {
      id: r.id,
      label: buildLabel({ site: siteCode, floor: floorCode, room: roomCode, rack: r.code }),
      siteCode,
      floorCode,
      roomCode,
      roomType: r.rooms.type,
      rackCode: r.code,
      heightU: r.height_u,
    };
  });
}
