// src/features/racks/repository.ts
// Thin Supabase wrappers for racks + placed devices (same pattern as device-library/repository).
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RackRow {
  id: string; room_id: string; code: string; name: string | null; height_u: number;
}

export interface RackDeviceRow {
  id: string; rack_id: string; device_template_id: string;
  code: string; name: string | null; start_u: number; side: "front" | "back";
  status: "planned" | "installed" | "verified";
  manufacturer: string | null; model_name: string | null; serial_number: string | null;
  purchase_date: string | null; operation_start: string | null;
  created_at: string; updated_at: string;
}

/** Everything the reconcile action writes; rack_id/timestamps are supplied by the server. */
export type RackDeviceInput = Omit<RackDeviceRow, "rack_id" | "created_at" | "updated_at">;

export async function getRack(db: SupabaseClient, id: string): Promise<RackRow> {
  const { data, error } = await db.from("racks").select("*").eq("id", id).single();
  if (error) throw new Error(`getRack: ${error.message}`);
  return data as RackRow;
}

export async function updateRack(
  db: SupabaseClient, id: string, patch: { name?: string | null; heightU?: number },
): Promise<void> {
  const applied = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.heightU !== undefined ? { height_u: patch.heightU } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from("racks").update(applied).eq("id", id);
  if (error) throw new Error(`updateRack: ${error.message}`);
}

export async function listRackDevices(db: SupabaseClient, rackId: string): Promise<RackDeviceRow[]> {
  const { data, error } = await db.from("rack_devices").select("*").eq("rack_id", rackId).order("start_u");
  if (error) throw new Error(`listRackDevices: ${error.message}`);
  return data as RackDeviceRow[];
}

/** Reconcile the rack's placements to exactly `rows`: upsert present ids, delete missing ones.
 *  One call serves insert, move, edit, delete, undo, and redo alike. */
export async function replaceRackDevices(
  db: SupabaseClient, rackId: string, rows: RackDeviceInput[],
): Promise<void> {
  const existing = await listRackDevices(db, rackId);
  const keep = new Set(rows.map((r) => r.id));
  const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (toDelete.length > 0) {
    const { error } = await db.from("rack_devices").delete().in("id", toDelete);
    if (error) throw new Error(`replaceRackDevices(delete): ${error.message}`);
  }
  if (rows.length > 0) {
    const payload = rows.map((r) => ({ ...r, rack_id: rackId, updated_at: new Date().toISOString() }));
    const { error } = await db.from("rack_devices").upsert(payload, { onConflict: "id" });
    if (error) throw new Error(`replaceRackDevices(upsert): ${error.message}`);
  }
}

/** rack_units per template id — the occupancy validator's lookup table. */
export async function templateHeights(db: SupabaseClient): Promise<Record<string, number>> {
  const { data, error } = await db.from("device_templates").select("id, rack_units");
  if (error) throw new Error(`templateHeights: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r: { id: string; rack_units: number }) => [r.id, r.rack_units]));
}
