"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidCode, isValidRackHeight, type RoomType } from "@/domain/hierarchy";
import {
  getDefaultOrganization,
  createSite,
  createFloor,
  createRoom,
  createRack,
} from "./repository";
import type { SupabaseClient } from "@supabase/supabase-js";

async function findOrCreateSite(db: SupabaseClient, code: string) {
  const org = await getDefaultOrganization(db);
  const { data } = await db
    .from("sites")
    .select("*")
    .eq("organization_id", org.id)
    .eq("code", code)
    .maybeSingle();
  if (data) return data;
  return createSite(db, { code, name: code });
}

async function findOrCreateFloor(db: SupabaseClient, siteId: string, code: string) {
  const { data } = await db
    .from("floors")
    .select("*")
    .eq("site_id", siteId)
    .eq("code", code)
    .maybeSingle();
  if (data) return data;
  return createFloor(db, { siteId, code });
}

async function findOrCreateRoom(
  db: SupabaseClient,
  floorId: string,
  code: string,
  type: RoomType
) {
  const { data } = await db
    .from("rooms")
    .select("*")
    .eq("floor_id", floorId)
    .eq("code", code)
    .maybeSingle();
  if (data) return data;
  return createRoom(db, { floorId, code, type });
}

export async function createRackWithHierarchyAction(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const siteCode = String(formData.get("siteCode") ?? "");
  const floorCode = String(formData.get("floorCode") ?? "");
  const roomCode = String(formData.get("roomCode") ?? "");
  const roomType = String(formData.get("roomType") ?? "other") as RoomType;
  const rackCode = String(formData.get("rackCode") ?? "");
  const heightU = Number(formData.get("heightU") ?? 0);

  for (const [name, code] of [
    ["site", siteCode],
    ["floor", floorCode],
    ["room", roomCode],
    ["rack", rackCode],
  ] as const) {
    if (!isValidCode(code)) return { ok: false, error: `Invalid ${name} code` };
  }
  if (!isValidRackHeight(heightU)) return { ok: false, error: "Invalid rack height" };

  const db = createServiceClient();
  try {
    const site = await findOrCreateSite(db, siteCode);
    const floor = await findOrCreateFloor(db, site.id, floorCode);
    const room = await findOrCreateRoom(db, floor.id, roomCode, roomType);
    await createRack(db, { roomId: room.id, code: rackCode, heightU });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/");
  return { ok: true };
}
