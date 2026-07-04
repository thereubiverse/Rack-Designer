"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidWidthIn, isValidRackUnits, type Face } from "@/domain/faceplate";
import {
  createDeviceTemplate, updateDeviceTemplate, getDeviceTemplate,
  toEditableTemplate, deleteDeviceTemplate, createBrand,
  type EditableTemplate, type BrandRow,
} from "./repository";

export interface DeviceTemplateInput {
  name: string;
  brandId: string | null;
  deviceTypeId: string;
  rackUnits: number;
  widthIn: number;
  rackMounted: boolean;
  frontFace: Face;
  backFace: Face;
}

/** Returns an error message, or null if the input is valid. */
export function validateDeviceTemplateInput(input: DeviceTemplateInput): string | null {
  if (!input.name.trim()) return "Name is required";
  if (!input.deviceTypeId) return "Device type is required";
  if (!isValidWidthIn(input.widthIn)) return "Width must be greater than 0";
  if (!isValidRackUnits(input.rackUnits)) return "Rack units must be at least 1";
  return null;
}

export async function saveNewDeviceTemplateAction(
  input: DeviceTemplateInput,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const err = validateDeviceTemplateInput(input);
  if (err) return { ok: false, error: err };
  const db = createServiceClient();
  try {
    const row = await createDeviceTemplate(db, {
      name: input.name.trim(), deviceTypeId: input.deviceTypeId,
      brandId: input.brandId ?? undefined, rackUnits: input.rackUnits,
      widthIn: input.widthIn, rackMounted: input.rackMounted,
      frontFace: input.frontFace, backFace: input.backFace,
    });
    revalidatePath("/device-library");
    return { ok: true, id: row.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function saveDeviceTemplateAction(
  id: string, input: DeviceTemplateInput,
): Promise<{ ok: boolean; error?: string }> {
  const err = validateDeviceTemplateInput(input);
  if (err) return { ok: false, error: err };
  const db = createServiceClient();
  try {
    await updateDeviceTemplate(db, id, {
      name: input.name.trim(), deviceTypeId: input.deviceTypeId,
      brandId: input.brandId, rackUnits: input.rackUnits,
      widthIn: input.widthIn, rackMounted: input.rackMounted,
      frontFace: input.frontFace, backFace: input.backFace,
    });
    revalidatePath("/device-library");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function getDeviceTemplateAction(
  id: string,
): Promise<{ ok: boolean; template?: EditableTemplate; error?: string }> {
  const db = createServiceClient();
  try {
    const row = await getDeviceTemplate(db, id);
    if (!row) return { ok: false, error: "Template not found" };
    return { ok: true, template: toEditableTemplate(row) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function createBrandAction(
  name: string,
): Promise<{ ok: boolean; brand?: BrandRow; error?: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Brand name is required" };
  const db = createServiceClient();
  try {
    const brand = await createBrand(db, { name: trimmed });
    revalidatePath("/device-library");
    return { ok: true, brand };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteDeviceTemplateAction(id: string): Promise<void> {
  const db = createServiceClient();
  await deleteDeviceTemplate(db, id);
  revalidatePath("/device-library");
}
