"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidCode, isValidRackHeight, type RoomType } from "@/domain/hierarchy";
import { normaliseCode } from "@/features/clients/validation";
import {
  createFloor,
  createRoom,
  createRack,
} from "./repository";
import type { SupabaseClient } from "@supabase/supabase-js";

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

/**
 * Adds a rack to an ALREADY-RESOLVED site — the site page hands over its id, so unlike the old
 * flat flow this never creates a site from a typed code. Floors and rooms stay find-or-create:
 * the directory treats them as implicit, born when a rack needs them.
 */
export async function createRackInSiteAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const siteId = String(formData.get("siteId") ?? "");
  const floorCode = normaliseCode(String(formData.get("floorCode") ?? ""));
  const roomCode = normaliseCode(String(formData.get("roomCode") ?? ""));
  const roomType = String(formData.get("roomType") ?? "other") as RoomType;
  const rackCode = normaliseCode(String(formData.get("rackCode") ?? ""));
  const heightU = Number(formData.get("heightU") ?? 0);

  if (!siteId) return { ok: false, error: "Missing site" };
  for (const [name, code] of [["floor", floorCode], ["room", roomCode], ["rack", rackCode]] as const) {
    if (!isValidCode(code)) return { ok: false, error: `Invalid ${name} code` };
  }
  if (!isValidRackHeight(heightU)) return { ok: false, error: "Invalid rack height" };

  const db = createServiceClient();
  try {
    const floor = await findOrCreateFloor(db, siteId, floorCode);
    const room = await findOrCreateRoom(db, floor.id, roomCode, roomType);
    await createRack(db, { roomId: room.id, code: rackCode, heightU });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
}
