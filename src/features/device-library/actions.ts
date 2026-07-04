"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidWidthIn, isValidRackUnits } from "@/domain/faceplate";
import { createDeviceTemplate, deleteDeviceTemplate } from "./repository";

export async function createDeviceTemplateAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const name = String(formData.get("name") ?? "").trim();
  const deviceTypeId = String(formData.get("deviceTypeId") ?? "");
  const brandId = String(formData.get("brandId") ?? "");
  const rackUnits = Number(formData.get("rackUnits") ?? 1);
  const widthIn = Number(formData.get("widthIn") ?? 19);
  const rackMounted = formData.get("rackMounted") === "on";

  if (!name) return { ok: false, error: "Name is required" };
  if (!deviceTypeId) return { ok: false, error: "Device type is required" };
  if (!isValidRackUnits(rackUnits)) return { ok: false, error: "Invalid rack units" };
  if (!isValidWidthIn(widthIn)) return { ok: false, error: "Invalid width" };

  const db = createServiceClient();
  try {
    await createDeviceTemplate(db, {
      name, deviceTypeId, brandId: brandId || undefined, rackUnits, widthIn, rackMounted,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/device-library");
  return { ok: true };
}

export async function deleteDeviceTemplateAction(id: string): Promise<void> {
  const db = createServiceClient();
  await deleteDeviceTemplate(db, id);
  revalidatePath("/device-library");
}
