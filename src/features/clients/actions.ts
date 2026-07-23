"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { validateCode, normaliseCode } from "./validation";
import { geocodeAddress } from "./geocode";
import { ROOM_TYPES, type RoomType } from "@/domain/hierarchy";
import {
  createClient,
  renameClient,
  deleteClient,
  createSiteForClient,
  renameSite,
  deleteSite,
  getSiteById,
  setSiteGeocode,
} from "./repository";
import {
  createFloor,
  createRoom,
  listFloorsForSite,
  renameFloor,
  deleteFloor,
  renameRoom,
  deleteRoom,
  createFloorDevice,
  updateFloorDevice,
  deleteFloorDevice,
} from "@/features/locations/repository";

const FLOOR_DEVICE_STATUSES = ["planned", "installed"] as const;
type FloorDeviceStatus = (typeof FLOOR_DEVICE_STATUSES)[number];

function friendly(e: unknown, kind: "client" | "site" | "floor" | "room" | "device"): string {
  const msg = e instanceof Error ? e.message : "Unknown error";
  if (/duplicate key|already exists/i.test(msg)) {
    switch (kind) {
      case "client":
        return "A client with that code already exists";
      case "site":
        return "That site code is already used by this client";
      case "floor":
        return "That floor code is already used at this site";
      case "room":
        return "That room code is already used on this floor";
      case "device":
        return "That device code is already used at this site";
    }
  }
  return msg;
}

export async function createClientAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");

  const codeError = validateCode(code, "client");
  if (codeError) return { ok: false, error: codeError };

  const db = createServiceClient();
  try {
    await createClient(db, { code, name });
  } catch (e) {
    return { ok: false, error: friendly(e, "client") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function renameClientAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");

  const codeError = validateCode(code, "client");
  if (codeError) return { ok: false, error: codeError };

  const db = createServiceClient();
  try {
    await renameClient(db, id, { code, name });
  } catch (e) {
    return { ok: false, error: friendly(e, "client") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function deleteClientAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteClient(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "client") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function createSiteAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const clientId = String(formData.get("clientId") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");
  const address = formData.get("address");

  const codeError = validateCode(code, "site");
  if (codeError) return { ok: false, error: codeError };

  const db = createServiceClient();
  let siteId: string;
  try {
    const site = await createSiteForClient(db, { clientId, code, name, address: address ? String(address) : null });
    siteId = site.id;
  } catch (e) {
    return { ok: false, error: friendly(e, "site") };
  }

  // Geocoding must never fail a write: the site already saved above. This is deliberately its own
  // try/catch, entirely separate from the one that guards the insert.
  try {
    const result = await geocodeAddress(address ? String(address) : null);
    await setSiteGeocode(db, siteId, result);
  } catch {
    // Swallow — a geocoding hiccup (or a setSiteGeocode DB error) must not surface to the caller.
  }

  revalidatePath("/clients");
  return { ok: true };
}

export async function renameSiteAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");
  const address = formData.get("address");

  const codeError = validateCode(code, "site");
  if (codeError) return { ok: false, error: codeError };

  const newAddress = address ? String(address) : null;

  const db = createServiceClient();

  // This read exists SOLELY to capture the previous address for geocode bookkeeping (below), so
  // it must have its own try/catch, ahead of — and separate from — the write's try/catch. If this
  // read throws, we must not let it reject the rename. Defaulting to null makes addressChanged
  // (below) come out true, so we simply re-geocode; that costs one extra request but never fails
  // a user's rename over a geocode-support read.
  let previousAddress: string | null = null;
  try {
    const existing = await getSiteById(db, id);
    previousAddress = existing?.address ?? null;
  } catch {
    previousAddress = null;
  }

  try {
    await renameSite(db, id, { code, name, address: newAddress });
  } catch (e) {
    return { ok: false, error: friendly(e, "site") };
  }

  // Only re-geocode when the address actually changed, so a plain rename (or a whitespace-only
  // edit) doesn't spend a request against Nominatim's ~1 req/sec budget. Compare trimmed values.
  const addressChanged = (previousAddress ?? "").trim() !== (newAddress ?? "").trim();
  if (addressChanged) {
    // Own try/catch, separate from the write above — geocoding must never fail a write that
    // already succeeded.
    try {
      // The address just changed, so any existing pin belongs to the OLD address. Clear it and
      // drop back to pending before attempting the new geocode, so that if the re-geocode fails
      // (setSiteGeocode's "failed" arm now preserves existing coordinates), we don't leave a
      // stale pin pointing at an address that no longer applies.
      const { error: clearError } = await db
        .from("sites")
        .update({ latitude: null, longitude: null, geocode_status: "pending" })
        .eq("id", id);
      if (clearError) throw new Error(`renameSiteAction(clear geocode): ${clearError.message}`);

      const result = await geocodeAddress(newAddress);
      await setSiteGeocode(db, id, result);
    } catch {
      // Swallow — same reasoning as createSiteAction.
    }
  }

  revalidatePath("/clients");
  return { ok: true };
}

export async function deleteSiteAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteSite(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "site") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function locateSiteAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const siteId = String(formData.get("siteId") ?? "");

  const db = createServiceClient();
  try {
    const site = await getSiteById(db, siteId);
    if (!site) return { ok: false, error: "Site not found" };
    const result = await geocodeAddress(site.address);
    await setSiteGeocode(db, siteId, result);
  } catch (e) {
    return { ok: false, error: friendly(e, "site") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function deleteRackAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const rackId = String(formData.get("rackId") ?? "");

  const db = createServiceClient();
  try {
    const { error } = await db.from("racks").delete().eq("id", rackId);
    if (error) throw new Error(`deleteRackAction: ${error.message}`);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function createFloorAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const siteId = String(formData.get("siteId") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");

  const codeError = validateCode(code, "floor");
  if (codeError) return { ok: false, error: codeError };

  const db = createServiceClient();
  try {
    const floors = await listFloorsForSite(db, siteId);
    const sortOrder = Math.max(-1, ...floors.map((f) => f.sort_order)) + 1;
    await createFloor(db, { siteId, code: normaliseCode(code), name, sortOrder });
  } catch (e) {
    return { ok: false, error: friendly(e, "floor") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function renameFloorAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");

  const codeError = validateCode(code, "floor");
  if (codeError) return { ok: false, error: codeError };

  const db = createServiceClient();
  try {
    await renameFloor(db, id, { code, name });
  } catch (e) {
    return { ok: false, error: friendly(e, "floor") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function deleteFloorAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteFloor(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "floor") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function createRoomAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const floorId = String(formData.get("floorId") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");
  const rawType = String(formData.get("type") ?? "other");

  const codeError = validateCode(code, "room");
  if (codeError) return { ok: false, error: codeError };

  if (!ROOM_TYPES.includes(rawType as RoomType)) {
    return { ok: false, error: "Invalid room type" };
  }
  const type = rawType as RoomType;

  const db = createServiceClient();
  try {
    await createRoom(db, { floorId, code: normaliseCode(code), name, type });
  } catch (e) {
    return { ok: false, error: friendly(e, "room") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function renameRoomAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");
  const rawType = String(formData.get("type") ?? "other");

  const codeError = validateCode(code, "room");
  if (codeError) return { ok: false, error: codeError };

  if (!ROOM_TYPES.includes(rawType as RoomType)) {
    return { ok: false, error: "Invalid room type" };
  }
  const type = rawType as RoomType;

  const db = createServiceClient();
  try {
    await renameRoom(db, id, { code, name, type });
  } catch (e) {
    return { ok: false, error: friendly(e, "room") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function deleteRoomAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteRoom(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "room") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function createFloorDeviceAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const floorId = String(formData.get("floorId") ?? "");
  const roomIdRaw = String(formData.get("roomId") ?? "");
  const roomId = roomIdRaw === "" ? null : roomIdRaw;
  const deviceTypeId = String(formData.get("deviceTypeId") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");
  const rawStatus = String(formData.get("status") ?? "planned") || "planned";

  const codeError = validateCode(code, "device");
  if (codeError) return { ok: false, error: codeError };

  if (!FLOOR_DEVICE_STATUSES.includes(rawStatus as FloorDeviceStatus)) {
    return { ok: false, error: "Invalid device status" };
  }
  const status = rawStatus as FloorDeviceStatus;

  const db = createServiceClient();
  try {
    await createFloorDevice(db, { floorId, roomId, deviceTypeId, code: normaliseCode(code), name, status });
  } catch (e) {
    return { ok: false, error: friendly(e, "device") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function updateFloorDeviceAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");
  const floorId = String(formData.get("floorId") ?? "");
  const roomIdRaw = String(formData.get("roomId") ?? "");
  const roomId = roomIdRaw === "" ? null : roomIdRaw;
  const deviceTypeId = String(formData.get("deviceTypeId") ?? "");
  const code = String(formData.get("code") ?? "");
  const name = String(formData.get("name") ?? "");
  const rawStatus = String(formData.get("status") ?? "planned") || "planned";

  const codeError = validateCode(code, "device");
  if (codeError) return { ok: false, error: codeError };

  if (!FLOOR_DEVICE_STATUSES.includes(rawStatus as FloorDeviceStatus)) {
    return { ok: false, error: "Invalid device status" };
  }
  const status = rawStatus as FloorDeviceStatus;

  const db = createServiceClient();
  try {
    await updateFloorDevice(db, id, { floorId, roomId, deviceTypeId, code: normaliseCode(code), name, status });
  } catch (e) {
    return { ok: false, error: friendly(e, "device") };
  }
  revalidatePath("/clients");
  return { ok: true };
}

export async function deleteFloorDeviceAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteFloorDevice(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "device") };
  }
  revalidatePath("/clients");
  return { ok: true };
}
