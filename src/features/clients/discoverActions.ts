"use server";

import { createServiceClient } from "@/lib/supabase/server";
import { getFloorPlan } from "@/features/locations/repository";
import { downloadPlanObject } from "./planStorage";
import { geminiPlanBackend } from "./ai/planVisionBackend";
import { resolveGeminiKey } from "@/features/settings/deviceWizardSettings";
import { dbSettingsStore } from "@/features/settings/store";
import {
  validateRoomDiscovery, validateDeviceDiscovery,
  type RoomProposal, type DeviceProposal,
} from "./planDetect";

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
async function prepare(floorId: string):
  Promise<{ ok: true; imageBase64: string; mimeType: string; apiKey: string } | { ok: false; error: string }> {
  const db = createServiceClient();
  const plan = await getFloorPlan(db, floorId);
  if (!plan) return { ok: false, error: "Upload a plan first." };
  const apiKey = await resolveGeminiKey(dbSettingsStore);
  if (!apiKey) return { ok: false, error: "no-key" };
  const bytes = await downloadPlanObject(db, plan.storage_path);
  const imageBase64 = Buffer.from(bytes).toString("base64");
  return { ok: true, imageBase64, mimeType: "image/png", apiKey };
}

export async function discoverRoomsAction(floorId: string): Promise<DiscoverRoomsResult> {
  try {
    const ready = await prepare(floorId);
    if (!ready.ok) return ready;
    const { imageBase64, mimeType, apiKey } = ready;
    const raw = await geminiPlanBackend.discoverRooms({ imageBase64, mimeType, apiKey });
    return { ok: true, proposals: validateRoomDiscovery(raw) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[discoverRooms]", detail);
    return { ok: false, error: friendly(detail) };
  }
}

export async function discoverDevicesAction(floorId: string): Promise<DiscoverDevicesResult> {
  try {
    const ready = await prepare(floorId);
    if (!ready.ok) return ready;
    const { imageBase64, mimeType, apiKey } = ready;
    const raw = await geminiPlanBackend.discoverDevices({ imageBase64, mimeType, apiKey });
    return { ok: true, proposals: validateDeviceDiscovery(raw) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[discoverDevices]", detail);
    return { ok: false, error: friendly(detail) };
  }
}
