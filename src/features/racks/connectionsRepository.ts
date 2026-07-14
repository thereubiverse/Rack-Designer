// Thin Supabase wrappers for patch cables (same reconcile pattern as replaceRackDevices).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Connection } from "./connectionOps";

export interface ConnectionRow {
  id: string; rack_id: string;
  a_rack_device_id: string; a_side: "front" | "back"; a_group_id: string; a_port_index: number;
  b_rack_device_id: string; b_side: "front" | "back"; b_group_id: string; b_port_index: number;
}

const toConnection = (r: ConnectionRow): Connection => ({
  id: r.id,
  a: { rackDeviceId: r.a_rack_device_id, side: r.a_side, groupId: r.a_group_id, portIndex: r.a_port_index },
  b: { rackDeviceId: r.b_rack_device_id, side: r.b_side, groupId: r.b_group_id, portIndex: r.b_port_index },
});

const toRow = (rackId: string, c: Connection): ConnectionRow => ({
  id: c.id, rack_id: rackId,
  a_rack_device_id: c.a.rackDeviceId, a_side: c.a.side, a_group_id: c.a.groupId, a_port_index: c.a.portIndex,
  b_rack_device_id: c.b.rackDeviceId, b_side: c.b.side, b_group_id: c.b.groupId, b_port_index: c.b.portIndex,
});

export async function listConnections(db: SupabaseClient, rackId: string): Promise<Connection[]> {
  const { data, error } = await db.from("connections").select("*").eq("rack_id", rackId);
  if (error) throw new Error(`listConnections: ${error.message}`);
  return (data as ConnectionRow[]).map(toConnection);
}

/** Reconcile the rack's connections to exactly `conns`: delete missing ids, upsert present. */
export async function replaceConnections(
  db: SupabaseClient, rackId: string, conns: Connection[],
): Promise<void> {
  const existing = await listConnections(db, rackId);
  const keep = new Set(conns.map((c) => c.id));
  const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (toDelete.length > 0) {
    const { error } = await db.from("connections").delete().in("id", toDelete);
    if (error) throw new Error(`replaceConnections(delete): ${error.message}`);
  }
  if (conns.length > 0) {
    const payload = conns.map((c) => ({ ...toRow(rackId, c), updated_at: new Date().toISOString() }));
    const { error } = await db.from("connections").upsert(payload, { onConflict: "id" });
    if (error) throw new Error(`replaceConnections(upsert): ${error.message}`);
  }
}
