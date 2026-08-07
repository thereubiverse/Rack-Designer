"use server";

import { revalidatePath } from "next/cache";
import { createTenantClient } from "@/lib/supabase/tenant";
import {
  createDeviceTemplate, updateDeviceTemplate, getDeviceTemplate,
  toEditableTemplate, deleteDeviceTemplate, duplicateDeviceTemplate, createBrand, deleteBrand,
  listTemplatesForType,
  type EditableTemplate, type BrandRow, type PickerTemplate,
} from "./repository";
import { validateDeviceTemplateInput, type DeviceTemplateInput } from "./validation";
import { withMember, withEditor } from "@/features/auth/withMember";

/** The rack builder's "Add device" picker refreshes one type's templates after a custom device is
 *  created inline (so the new template appears and can be inserted) without a full page reload. */
export const listTemplatesForTypeAction = withMember("deviceTemplate.list", async (
  member, deviceTypeId: string,
): Promise<{ ok: boolean; templates?: PickerTemplate[]; error?: string }> => {
  const db = createTenantClient(member);
  try {
    return { ok: true, templates: await listTemplatesForType(db, deviceTypeId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  },
  { log: false }
);

export const saveNewDeviceTemplateAction = withEditor("deviceTemplate.create", async (
  member, input: DeviceTemplateInput,
): Promise<{ ok: boolean; id?: string; error?: string }> => {
  const err = validateDeviceTemplateInput(input);
  if (err) return { ok: false, error: err };
  const db = createTenantClient(member);
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
});

export const saveDeviceTemplateAction = withEditor("deviceTemplate.update", async (
  member, id: string, input: DeviceTemplateInput,
): Promise<{ ok: boolean; error?: string }> => {
  const err = validateDeviceTemplateInput(input);
  if (err) return { ok: false, error: err };
  const db = createTenantClient(member);
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
});

export const getDeviceTemplateAction = withMember("deviceTemplate.get", async (
  member, id: string,
): Promise<{ ok: boolean; template?: EditableTemplate; error?: string }> => {
  const db = createTenantClient(member);
  try {
    const row = await getDeviceTemplate(db, id);
    if (!row) return { ok: false, error: "Template not found" };
    return { ok: true, template: toEditableTemplate(row) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  },
  { log: false }
);

export const createBrandAction = withEditor("brand.create", async (
  member, name: string,
): Promise<{ ok: boolean; brand?: BrandRow; error?: string }> => {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Brand name is required" };
  const db = createTenantClient(member);
  try {
    const brand = await createBrand(db, { name: trimmed });
    revalidatePath("/device-library");
    return { ok: true, brand };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
});

export const deleteBrandAction = withEditor("brand.delete", async (member, id: string): Promise<{ ok: boolean; error?: string }> => {
  const db = createTenantClient(member);
  try {
    await deleteBrand(db, id);
    revalidatePath("/device-library");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
});

// NOTE (Task 9 deviation): this action used to return `Promise<void>` and THROW on failure, relying
// on the caller's try/catch (EditorLauncher.confirmDeleteNow). withMember never lets a wrapped
// action's throw reach the caller — it catches it and resolves `{ ok: false, error }` instead (see
// withMember's doc comment: "every action in this codebase resolves {ok:false} rather than
// rejecting"). Left as a throw, the caller's catch would simply never fire and a failed delete would
// look like a silent success. Converted to the same `{ ok, error }` shape every sibling action here
// already uses, with the caller updated to check `res.ok` instead of try/catch.
export const deleteDeviceTemplateAction = withEditor("deviceTemplate.delete", async (member, id: string): Promise<{ ok: boolean; error?: string }> => {
  const db = createTenantClient(member);
  try {
    await deleteDeviceTemplate(db, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("foreign key constraint")) {
      return { ok: false, error: "This device is placed in a rack — remove it from all racks first" };
    }
    return { ok: false, error: msg };
  }
  revalidatePath("/device-library");
  return { ok: true };
});

export const duplicateDeviceTemplateAction = withEditor("deviceTemplate.duplicate", async (member, id: string): Promise<{ ok: boolean; error?: string }> => {
  const db = createTenantClient(member);
  try {
    await duplicateDeviceTemplate(db, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { ok: false, error: msg.includes("duplicate key") ? "A copy with that name already exists — rename it first" : msg };
  }
  revalidatePath("/device-library");
  return { ok: true };
});
