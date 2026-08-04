"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { withEditor } from "@/features/auth/withMember";
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
  archiveClient,
  restoreClient,
  archiveSite,
  restoreSite,
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
  getFloorPlan,
  upsertFloorPlan,
  deleteFloorPlan,
  placeFloorDevice,
  clearFloorDevicePlacement,
  placeRack,
  clearRackPlacement,
  setRoomPolygon,
  clearRoomPolygon,
  archiveFloor,
  restoreFloor,
} from "@/features/locations/repository";
import type { NormPoint } from "./floorPlanOps";
import { readPngDimensions } from "./pngHeader";
import { uploadPlanObject, removePlanObject, uploadPlanPdf, removePlanPdf } from "./planStorage";
import type { FloorPlanRow } from "@/lib/supabase/types";

const FLOOR_DEVICE_STATUSES = ["planned", "installed"] as const;
type FloorDeviceStatus = (typeof FLOOR_DEVICE_STATUSES)[number];

const PLAN_SOURCES = ["image", "pdf"] as const;
type PlanSource = (typeof PLAN_SOURCES)[number];

const MAX_PLAN_BYTES = 15 * 1024 * 1024; // 15MB

interface BlobLike {
  size: number;
  name?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isBlobLike(v: unknown): v is BlobLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { size?: unknown }).size === "number" &&
    typeof (v as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function friendly(e: unknown, kind: "client" | "site" | "floor" | "room" | "device"): string {
  const msg = e instanceof Error ? e.message : "Unknown error";
  if (/duplicate key|already exists/i.test(msg)) {
    switch (kind) {
      // Clients, sites and floors can be archived, which means the row a unique-constraint
      // collision hits may be one the user cannot see anywhere on the page in front of them —
      // `friendly` only sees a Postgres error string, so it can't tell whether the collision is
      // against that hidden archived row or a live one it just failed to find. The wording below is
      // written to stay true either way ("may be" — never asserts archived), and points at the one
      // place that can resolve either case without claiming a permanent-delete feature that doesn't
      // exist yet.
      case "client":
        return "A client with that code already exists. If you don't see it, it may be archived — check Settings → Archive.";
      case "site":
        return "That site code is already used by this client. If you don't see it, it may be archived — check Settings → Archive.";
      case "floor":
        return "That floor code is already used at this site. If you don't see it, it may be archived — check Settings → Archive.";
      case "room":
        return "That room code is already used on this floor";
      case "device":
        return "That device code is already used at this site";
    }
  }
  return msg;
}

export const createClientAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const renameClientAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const deleteClientAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteClient(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "client") };
  }
  revalidatePath("/clients");
  return { ok: true };
});

export const createSiteAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const renameSiteAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const deleteSiteAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteSite(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "site") };
  }
  revalidatePath("/clients");
  return { ok: true };
});

export const locateSiteAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const deleteRackAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const createFloorAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const renameFloorAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const deleteFloorAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteFloor(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "floor") };
  }
  revalidatePath("/clients");
  return { ok: true };
});

// ---- Archive & restore -----------------------------------------------------------------------
//
// Archiving is the new meaning of the delete controls on clients, sites and floors: the row is
// flagged, not destroyed, and every child is left alone. Both paths revalidate the directory AND
// the archive page, because one operation changes what each of them shows.

async function archiveOrRestore(
  id: string,
  run: (db: ReturnType<typeof createServiceClient>, id: string) => Promise<void>,
  kind: "client" | "site" | "floor"
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    await run(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, kind) };
  }
  revalidatePath("/clients");
  revalidatePath("/settings/archive");
  return { ok: true };
}

export const archiveClientAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  return archiveOrRestore(String(formData.get("id") ?? ""), archiveClient, "client");
});

export const restoreClientAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  return archiveOrRestore(String(formData.get("id") ?? ""), restoreClient, "client");
});

export const archiveSiteAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  return archiveOrRestore(String(formData.get("id") ?? ""), archiveSite, "site");
});

export const restoreSiteAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  return archiveOrRestore(String(formData.get("id") ?? ""), restoreSite, "site");
});

export const archiveFloorAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  return archiveOrRestore(String(formData.get("id") ?? ""), archiveFloor, "floor");
});

export const restoreFloorAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  return archiveOrRestore(String(formData.get("id") ?? ""), restoreFloor, "floor");
});

export const createRoomAction = withEditor(async (
  _member,
  formData: FormData
): Promise<{ ok: boolean; error?: string; id?: string }> => {
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
  let room;
  try {
    room = await createRoom(db, { floorId, code: normaliseCode(code), name, type });
  } catch (e) {
    return { ok: false, error: friendly(e, "room") };
  }
  revalidatePath("/clients");
  // The new id lets the caller chain setRoomPolygonAction in the trace-then-name flow.
  return { ok: true, id: room.id };
});

export const renameRoomAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const deleteRoomAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteRoom(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "room") };
  }
  revalidatePath("/clients");
  return { ok: true };
});

export const createFloorDeviceAction = withEditor(async (
  _member,
  formData: FormData
): Promise<{ ok: boolean; error?: string; id?: string }> => {
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
  let device;
  try {
    device = await createFloorDevice(db, { floorId, roomId, deviceTypeId, code: normaliseCode(code), name, status });
  } catch (e) {
    return { ok: false, error: friendly(e, "device") };
  }
  revalidatePath("/clients");
  // The new id lets the caller chain placeFloorDeviceAction in the place-then-detail flow.
  return { ok: true, id: device.id };
});

export const updateFloorDeviceAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
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
});

export const deleteFloorDeviceAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await deleteFloorDevice(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, "device") };
  }
  revalidatePath("/clients");
  return { ok: true };
});

/** Trust posture for this slice: dimensions are decoded from the uploaded bytes (never taken from
 *  FormData), and the storage scope (site) is derived from the floor row (never from the caller).
 *  ORDER MATTERS and is part of the contract: floor lookup -> size check -> PNG decode -> storage
 *  upload -> row upsert. A rejection at any step must leave NO storage write behind.
 *
 *  Slice D: the client may additionally send the original source PDF (`pdf`) and the page index
 *  chosen from it (`pdfPage`). The PNG remains the thing that makes a plan usable at all — the PDF
 *  is purely an enhancement that unlocks wall-geometry extraction later — so it is uploaded to
 *  `${siteId}/${floorId}.pdf` strictly AFTER the PNG upload succeeds, and its own failure is caught
 *  separately: on a PDF failure the row is still upserted (with `pdf_storage_path: null`) and this
 *  action still returns `{ok: true}`, because a plan without geometry is exactly Slice C's working
 *  behaviour — a PDF hiccup must never lose, block, or roll back a successful PNG upload. */
export const uploadFloorPlanAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const floorId = String(formData.get("floorId") ?? "");
  const file = formData.get("file");
  const rawSource = String(formData.get("source") ?? "image");
  const pdfFile = formData.get("pdf");
  const rawPdfPage = formData.get("pdfPage");

  // Duck-typed rather than `instanceof Blob`/`instanceof File`: FormData's Blob comes from
  // whatever Fetch/File implementation the runtime provides, and different runtimes (Node vs. a
  // jsdom test environment) do not share a Blob/File constructor, so an identity check would be
  // brittle. All this action actually needs is `.size` and `.arrayBuffer()`.
  if (!isBlobLike(file)) return { ok: false, error: "No file provided" };
  if (!PLAN_SOURCES.includes(rawSource as PlanSource)) return { ok: false, error: "Invalid plan source" };
  const source = rawSource as PlanSource;

  const db = createServiceClient();

  // Floor lookup: derives the site for the storage path. NEVER trust a client-supplied siteId,
  // and this also doubles as "does this floor exist" — an unknown floor fails here, before any
  // byte is read or any storage call is made.
  const { data: floor, error: floorErr } = await db.from("floors").select("id, site_id").eq("id", floorId).single();
  if (floorErr || !floor) return { ok: false, error: "Floor not found" };
  const siteId = (floor as { site_id: string }).site_id;

  // Size check uses the Blob API's `.size` — BEFORE reading any bytes.
  if (file.size > MAX_PLAN_BYTES) return { ok: false, error: "File is too large (max 15MB)" };

  const bytes = new Uint8Array(await file.arrayBuffer());

  // Decoded from the actual bytes, never from any client-supplied width/height field. Rejects
  // anything that isn't a well-formed PNG BEFORE any storage write.
  const dims = readPngDimensions(bytes);
  if (!dims) return { ok: false, error: "File is not a valid PNG" };

  const path = `${siteId}/${floorId}.png`;

  // `Number()` on a missing/blank/non-numeric field yields NaN (or a non-integer), which is
  // rejected — treated as absent, never as an error. This codebase's standing rule: `0` is a real,
  // valid page index, so the check is `>= 0`, never a falsy/truthy coercion.
  let pdfPage: number | null = null;
  if (rawPdfPage != null) {
    const n = Number(rawPdfPage);
    if (Number.isInteger(n) && n >= 0) pdfPage = n;
  }

  let pdfStoragePath: string | null = null;

  try {
    await uploadPlanObject(db, path, bytes);

    if (isBlobLike(pdfFile)) {
      const pdfPath = `${siteId}/${floorId}.pdf`;
      try {
        const pdfBytes = new Uint8Array(await pdfFile.arrayBuffer());
        await uploadPlanPdf(db, pdfPath, pdfBytes);
        pdfStoragePath = pdfPath;
      } catch {
        // Swallow — see the doc comment above. The PNG already landed; a PDF hiccup must not
        // orphan it or fail this action. Falls back to `pdf_storage_path: null`.
        pdfStoragePath = null;
      }
    }

    await upsertFloorPlan(db, {
      floorId,
      storagePath: path,
      widthPx: dims.width,
      heightPx: dims.height,
      originalFilename: typeof file.name === "string" ? file.name : "plan.png",
      source,
      pdfStoragePath,
      pdfPage,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  revalidatePath("/clients");
  return { ok: true };
});

export const deleteFloorPlanAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const floorId = String(formData.get("floorId") ?? "");

  const db = createServiceClient();

  // Best-effort object removal: a missing (or already-removed) storage object must never block
  // the row + placement cleanup below, so any failure here — including the lookup itself — is
  // swallowed inside its own try/catch. `plan` is hoisted so the PDF-removal block below can reuse
  // the same lookup rather than repeating it.
  let plan: FloorPlanRow | null = null;
  try {
    plan = await getFloorPlan(db, floorId);
    if (plan) await removePlanObject(db, plan.storage_path);
  } catch {
    // swallow — see comment above.
  }

  // PDF removal gets its OWN try/catch, exactly like the PNG above: a missing/already-removed PDF
  // object (or a plan that never had one) must never block row/placement cleanup.
  try {
    if (plan?.pdf_storage_path) await removePlanPdf(db, plan.pdf_storage_path);
  } catch {
    // swallow — see comment above.
  }

  try {
    await deleteFloorPlan(db, floorId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }

  revalidatePath("/clients");
  return { ok: true };
});

/** `Number(String(...))` on a missing/blank field yields NaN, and NaN fails `isNorm`'s
 *  `Number.isFinite` check inside `placeFloorDevice` — a missing field rejects rather than
 *  placing a pin at NaN. */
export const placeFloorDeviceAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");
  const x = Number(String(formData.get("x")));
  const y = Number(String(formData.get("y")));

  const db = createServiceClient();
  try {
    await placeFloorDevice(db, id, { x, y });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
});

export const clearFloorDevicePlacementAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await clearFloorDevicePlacement(db, id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
});

export const placeRackAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");
  const x = Number(String(formData.get("x")));
  const y = Number(String(formData.get("y")));

  const db = createServiceClient();
  try {
    await placeRack(db, id, { x, y });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
});

export const clearRackPlacementAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const id = String(formData.get("id") ?? "");

  const db = createServiceClient();
  try {
    await clearRackPlacement(db, id);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
});

/** `JSON.parse` gets its OWN try/catch, separate from the repository call below — a malformed
 *  JSON string must reject with {ok:false} exactly like an invalid (but well-formed) polygon
 *  shape, never throw out of this action. */
export const setRoomPolygonAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const roomId = String(formData.get("roomId") ?? "");
  const raw = String(formData.get("polygon") ?? "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid polygon data" };
  }

  const db = createServiceClient();
  try {
    await setRoomPolygon(db, roomId, parsed as NormPoint[]);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
});

export const clearRoomPolygonAction = withEditor(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
  const roomId = String(formData.get("roomId") ?? "");

  const db = createServiceClient();
  try {
    await clearRoomPolygon(db, roomId);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
});
