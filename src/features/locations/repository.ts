import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoomType } from "@/domain/hierarchy";
import { normaliseCode } from "@/features/clients/validation";
import type {
  SiteRow,
  FloorRow,
  RoomRow,
  RackRow,
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
