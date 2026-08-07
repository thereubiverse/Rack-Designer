"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { createTenantClient } from "@/lib/supabase/tenant";
import { withEditor } from "@/features/auth/withMember";
import type { Member } from "@/features/auth/members";
import { getFloorPlan, listRoomsForFloor } from "@/features/locations/repository";
import { downloadPlanObject } from "./planStorage";
import { geminiPlanBackend } from "./ai/planVisionBackend";
import { resolveGeminiKey } from "@/features/settings/deviceWizardSettings";
import { dbSettingsStore } from "@/features/settings/store";
import {
  validateRoomDiscovery, validateDeviceDiscovery,
  type RoomProposal, type DeviceProposal,
} from "./planDetect";
import { filterAlreadyTraced } from "./planProposals";
import { toCropRect, cropPointToFull, cropToPixels, type CropRect } from "./planCrop";

export type DiscoverRoomsResult = { ok: true; proposals: RoomProposal[] } | { ok: false; error: string };
export type DiscoverDevicesResult = { ok: true; proposals: DeviceProposal[] } | { ok: false; error: string };

const BUSY = /\b(503|429|500|overloaded|high demand|Service Unavailable)\b/i;
/** Takes the detail string the caller has ALREADY derived from the error, rather than re-deriving
 *  it, so the logged text and the classified text can never drift apart. */
const friendly = (detail: string) =>
  BUSY.test(detail)
    ? "The vision model is busy right now — please try again in a moment."
    : "Couldn't read this plan. Try again or use a clearer image.";

// Shared setup: derive the plan from the floor (server-side), fetch its bytes, resolve the key.
// Returns either the ready-to-send image payload or a caller-facing error. NOTE: getFloorPlan and
// downloadPlanObject can both throw on unexpected DB/storage errors — callers MUST await this
// inside their own try/catch so those propagate as `{ ok: false, error }`, never as a rejection.
async function prepare(member: Member, floorId: string):
  Promise<{ ok: true; imageBase64: string; mimeType: string; apiKey: string; widthPx: number; heightPx: number } | { ok: false; error: string }> {
  const db = createTenantClient(member);
  const plan = await getFloorPlan(db, floorId);
  if (!plan) return { ok: false, error: "Upload a plan first." };
  const apiKey = await resolveGeminiKey(dbSettingsStore, member.orgId);
  if (!apiKey) return { ok: false, error: "no-key" };
  // app_tenant has no grant on the storage schema (verified against the local stack) — narrow,
  // service-client ONLY for this download.
  const storageDb = createServiceClient();
  const bytes = await downloadPlanObject(storageDb, plan.storage_path);
  const imageBase64 = Buffer.from(bytes).toString("base64");
  return { ok: true, imageBase64, mimeType: "image/png", apiKey, widthPx: plan.width_px, heightPx: plan.height_px };
}

/** Crop the sheet down to just the floor-plan drawing before the room pass.
 *
 *  Best-effort by design: ANY failure — a bad locate response, an unusable box, a sharp error —
 *  falls back to the full image and the pass still runs. The crop is an accuracy optimisation, not
 *  a correctness requirement, so it must never be the reason discovery fails. */
async function cropToDrawing(
  imageBase64: string, mimeType: string, apiKey: string, widthPx: number, heightPx: number,
): Promise<{ imageBase64: string; crop: CropRect | null }> {
  try {
    const located = await geminiPlanBackend.locateDrawingArea({ imageBase64, mimeType, apiKey });
    const crop = toCropRect(located);
    if (!crop) return { imageBase64, crop: null };
    const sharp = (await import("sharp")).default;
    const out = await sharp(Buffer.from(imageBase64, "base64"))
      .extract(cropToPixels(crop, widthPx, heightPx))
      .png()
      .toBuffer();
    return { imageBase64: out.toString("base64"), crop };
  } catch (e) {
    console.error("[discoverRooms] crop skipped:", e instanceof Error ? e.message : String(e));
    return { imageBase64, crop: null };
  }
}

export const discoverRoomsAction = withEditor("ai.discoverRooms", async (member, floorId: string): Promise<DiscoverRoomsResult> => {
  try {
    const ready = await prepare(member, floorId);
    if (!ready.ok) return ready;
    const { mimeType, apiKey, widthPx, heightPx } = ready;
    // Locate + crop first: the model gets far more pixels per room once the title block is gone.
    const { imageBase64, crop } = await cropToDrawing(ready.imageBase64, mimeType, apiKey, widthPx, heightPx);
    const raw = await geminiPlanBackend.discoverRooms({ imageBase64, mimeType, apiKey });
    // Everything downstream lives in FULL-SHEET space, so undo the crop before anything else sees it.
    const proposals = validateRoomDiscovery(raw).map((p) => ({
      ...p,
      polygon: p.polygon.map((pt) => cropPointToFull(pt, crop)),
    }));
    // Rooms the user has already outlined are finished work — re-proposing them every run is noise.
    const rooms = await listRoomsForFloor(createTenantClient(member), floorId);
    return { ok: true, proposals: filterAlreadyTraced(proposals, rooms) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[discoverRooms]", detail);
    return { ok: false, error: friendly(detail) };
  }
});

export const discoverDevicesAction = withEditor("ai.discoverDevices", async (member, floorId: string): Promise<DiscoverDevicesResult> => {
  try {
    const ready = await prepare(member, floorId);
    if (!ready.ok) return ready;
    const { imageBase64, mimeType, apiKey } = ready;
    const raw = await geminiPlanBackend.discoverDevices({ imageBase64, mimeType, apiKey });
    return { ok: true, proposals: validateDeviceDiscovery(raw) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[discoverDevices]", detail);
    return { ok: false, error: friendly(detail) };
  }
});
