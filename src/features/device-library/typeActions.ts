"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { createDeviceType, updateDeviceType, deleteDeviceType } from "./repository";
import { validateCode, validateTypeName } from "./deviceTypeRules";

/** Map raw Postgres/Supabase errors to copy a user can act on. */
function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : "Unknown error";
  if (msg.includes("device_types_org_code_key")) return "That ID prefix is already in use";
  if (msg.includes("device_types_org_category_name_key")) return "A type with that name already exists";
  if (msg.includes("foreign key constraint")) return "This type is in use by a device template";
  return msg;
}

export async function createDeviceTypeAction(
  input: { name: string; code: string; category: "floor" | "rack" },
): Promise<{ ok: boolean; error?: string }> {
  const err = validateTypeName(input.name) ?? validateCode(input.code);
  if (err) return { ok: false, error: err };
  const db = createServiceClient();
  try {
    await createDeviceType(db, { name: input.name.trim(), code: input.code, category: input.category });
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
  revalidatePath("/device-library/types");
  return { ok: true };
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export interface DeviceTypeChange {
  id: string;
  name?: string;
  code?: string;
  /** null clears the override (back to the built-in default); a #rrggbb string sets it. */
  color?: string | null;
  /** null clears the override; an Iconify "prefix:name" id sets it. */
  icon?: string | null;
}

/** Batch save from one column's "Save changes" — applied sequentially, first error aborts. */
export async function saveDeviceTypesAction(
  changes: DeviceTypeChange[],
): Promise<{ ok: boolean; error?: string }> {
  for (const c of changes) {
    const err =
      (c.name !== undefined ? validateTypeName(c.name) : null) ??
      (c.code !== undefined ? validateCode(c.code) : null) ??
      (typeof c.color === "string" && !HEX_RE.test(c.color) ? "Colour must be a hex value like #2563eb" : null);
    if (err) return { ok: false, error: err };
  }
  const db = createServiceClient();
  try {
    for (const c of changes) {
      await updateDeviceType(db, c.id, {
        ...(c.name !== undefined ? { name: c.name.trim() } : {}),
        ...(c.code !== undefined ? { code: c.code } : {}),
        ...(c.color !== undefined ? { color: c.color } : {}),
        ...(c.icon !== undefined ? { icon: c.icon } : {}),
      });
    }
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
  revalidatePath("/device-library/types");
  return { ok: true };
}

export async function deleteDeviceTypeAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    await deleteDeviceType(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
  revalidatePath("/device-library/types");
  return { ok: true };
}
