"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { validateCode } from "./validation";
import {
  createClient,
  renameClient,
  deleteClient,
  createSiteForClient,
  renameSite,
  deleteSite,
} from "./repository";

function friendly(e: unknown, kind: "client" | "site"): string {
  const msg = e instanceof Error ? e.message : "Unknown error";
  if (/duplicate key|already exists/i.test(msg)) {
    return kind === "client" ? "A client with that code already exists"
                             : "That site code is already used by this client";
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
  try {
    await createSiteForClient(db, { clientId, code, name, address: address ? String(address) : null });
  } catch (e) {
    return { ok: false, error: friendly(e, "site") };
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

  const db = createServiceClient();
  try {
    await renameSite(db, id, { code, name, address: address ? String(address) : null });
  } catch (e) {
    return { ok: false, error: friendly(e, "site") };
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
