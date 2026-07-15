// Thin Supabase wrappers for port endpoints (same reconcile pattern as replaceConnections).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PortEndpoint, OutletPortCount } from "./endpointOps";

export interface PortEndpointRow {
  id: string; rack_id: string;
  rack_device_id: string; side: "front" | "back"; group_id: string; port_index: number;
  kind: "described" | "device" | "rack";
  device_type_id: string | null; name: string; port_count: number;
  landing_port_index: number; landing_port_label: string;
  target_rack_device_id: string | null; target_rack_id: string | null;
}

const toEndpoint = (r: PortEndpointRow): PortEndpoint => {
  const port = { rackDeviceId: r.rack_device_id, side: r.side, groupId: r.group_id, portIndex: r.port_index };
  if (r.kind === "device") return { id: r.id, port, kind: "device", targetRackDeviceId: r.target_rack_device_id! };
  if (r.kind === "rack") return { id: r.id, port, kind: "rack", targetRackId: r.target_rack_id! };
  return {
    id: r.id, port, kind: "described", deviceTypeId: r.device_type_id!, name: r.name,
    portCount: r.port_count as OutletPortCount,
    landingPortIndex: r.landing_port_index, landingPortLabel: r.landing_port_label,
  };
};

/** Unused columns are written as their DB defaults so the kind CHECK constraint holds. */
const toRow = (rackId: string, e: PortEndpoint): PortEndpointRow => ({
  id: e.id, rack_id: rackId,
  rack_device_id: e.port.rackDeviceId, side: e.port.side, group_id: e.port.groupId, port_index: e.port.portIndex,
  kind: e.kind,
  device_type_id: e.kind === "described" ? e.deviceTypeId : null,
  name: e.kind === "described" ? e.name : "",
  port_count: e.kind === "described" ? e.portCount : 1,
  landing_port_index: e.kind === "described" ? e.landingPortIndex : 0,
  landing_port_label: e.kind === "described" ? e.landingPortLabel : "",
  target_rack_device_id: e.kind === "device" ? e.targetRackDeviceId : null,
  target_rack_id: e.kind === "rack" ? e.targetRackId : null,
});

export async function listPortEndpoints(db: SupabaseClient, rackId: string): Promise<PortEndpoint[]> {
  const { data, error } = await db.from("port_endpoints").select("*").eq("rack_id", rackId);
  if (error) throw new Error(`listPortEndpoints: ${error.message}`);
  return (data as PortEndpointRow[]).map(toEndpoint);
}

/** Reconcile the rack's endpoints to exactly `eps`: delete missing ids, upsert present. */
export async function replacePortEndpoints(
  db: SupabaseClient, rackId: string, eps: PortEndpoint[],
): Promise<void> {
  const existing = await listPortEndpoints(db, rackId);
  const keep = new Set(eps.map((e) => e.id));
  const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (toDelete.length > 0) {
    const { error } = await db.from("port_endpoints").delete().in("id", toDelete);
    if (error) throw new Error(`replacePortEndpoints(delete): ${error.message}`);
  }
  if (eps.length > 0) {
    const payload = eps.map((e) => ({ ...toRow(rackId, e), updated_at: new Date().toISOString() }));
    const { error } = await db.from("port_endpoints").upsert(payload, { onConflict: "id" });
    if (error) throw new Error(`replacePortEndpoints(upsert): ${error.message}`);
  }
}
