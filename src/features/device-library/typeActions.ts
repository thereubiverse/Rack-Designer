"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { createDeviceType, deleteDeviceType } from "./repository";

export async function createDeviceTypeAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required" };
  const db = createServiceClient();
  try {
    await createDeviceType(db, { name });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/device-library/types");
  return { ok: true };
}

export async function deleteDeviceTypeAction(id: string): Promise<void> {
  const db = createServiceClient();
  await deleteDeviceType(db, id);
  revalidatePath("/device-library/types");
}
