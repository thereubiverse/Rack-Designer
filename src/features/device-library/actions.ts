"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import {
  createDeviceTemplate, updateDeviceTemplate, getDeviceTemplate,
  toEditableTemplate, deleteDeviceTemplate, duplicateDeviceTemplate, createBrand, deleteBrand,
  listTemplatesForType,
  type EditableTemplate, type BrandRow, type PickerTemplate,
} from "./repository";
import { validateDeviceTemplateInput, type DeviceTemplateInput } from "./validation";

/** The rack builder's "Add device" picker refreshes one type's templates after a custom device is
 *  created inline (so the new template appears and can be inserted) without a full page reload. */
export async function listTemplatesForTypeAction(
  deviceTypeId: string,
): Promise<{ ok: boolean; templates?: PickerTemplate[]; error?: string }> {
  const db = createServiceClient();
  try {
    return { ok: true, templates: await listTemplatesForType(db, deviceTypeId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
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

export async function deleteBrandAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    await deleteBrand(db, id);
    revalidatePath("/device-library");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteDeviceTemplateAction(id: string): Promise<void> {
  const db = createServiceClient();
  try {
    await deleteDeviceTemplate(db, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("foreign key constraint")) {
      throw new Error("This device is placed in a rack — remove it from all racks first");
    }
    throw e;
  }
  revalidatePath("/device-library");
}

export async function duplicateDeviceTemplateAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    await duplicateDeviceTemplate(db, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { ok: false, error: msg.includes("duplicate key") ? "A copy with that name already exists — rename it first" : msg };
  }
  revalidatePath("/device-library");
  return { ok: true };
}
