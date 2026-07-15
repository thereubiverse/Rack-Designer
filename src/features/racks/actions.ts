// src/features/racks/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getRack, replaceRackDevices, listRackDevices, templateHeights, updateRack, type RackDeviceInput } from "./repository";
import { canPlace, validateDeviceCode, minRackHeight, type PlacementLike } from "./rackOps";
import { replaceConnections } from "./connectionsRepository";
import { portsOf, validatePatch, type Connection, type PortRef } from "./connectionOps";
import { emptyFace, type Face } from "@/domain/faceplate";
import { replacePortEndpoints } from "./endpointsRepository";
import { validateEndpoint, type PortEndpoint, type EndpointContext } from "./endpointOps";
import { listSiteScope } from "./siteScope";
import { listDeviceTypes } from "@/features/device-library/repository";

function toPlacementLike(rows: { id: string; device_template_id?: string; deviceTemplateId?: string; code: string; start_u?: number; startU?: number }[]): PlacementLike[] {
  return rows.map((r) => ({
    id: r.id,
    deviceTemplateId: (r.device_template_id ?? r.deviceTemplateId)!,
    code: r.code,
    startU: (r.start_u ?? r.startU)!,
  }));
}

/** Reconcile the whole layout. Validates codes + occupancy against FRESH template heights so a
 *  racing template edit or stale client can't produce an overlapping rack. */
export async function saveRackLayoutAction(
  rackId: string, devices: RackDeviceInput[],
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    const [rack, ru] = await Promise.all([getRack(db, rackId), templateHeights(db)]);
    const seen = new Set<string>();
    for (const d of devices) {
      const codeErr = validateDeviceCode(d.code);
      if (codeErr) return { ok: false, error: codeErr };
      if (seen.has(d.code)) return { ok: false, error: `Duplicate ID ${d.code} in this rack` };
      seen.add(d.code);
      if (!(d.device_template_id in ru)) return { ok: false, error: "A placed device's template no longer exists" };
    }
    const like = toPlacementLike(devices);
    for (const d of like) {
      const others = like.filter((x) => x.id !== d.id);
      if (!canPlace(others, ru, d.startU, ru[d.deviceTemplateId], rack.height_u)) {
        return { ok: false, error: "Those rack units are already occupied" };
      }
    }
    await replaceRackDevices(db, rackId, devices);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath(`/racks/${rackId}`);
  return { ok: true };
}

/** Reconcile the rack's patch cables. Re-validates every edge against FRESH device snapshots so a
 *  stale client can't create a cable on a vanished port or double-book a port. */
export async function saveConnectionsAction(
  rackId: string, conns: Connection[],
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    const devices = await listRackDevices(db, rackId);
    // Build the valid-port index per device from the snapshot faces (fallback to empty).
    const portsByDevice: Record<string, PortRef[]> = {};
    for (const d of devices) {
      const front = (d.front_face as Face | null) ?? emptyFace();
      const back = (d.back_face as Face | null) ?? emptyFace();
      portsByDevice[d.id] = [...portsOf(front, d.id, "front"), ...portsOf(back, d.id, "back")];
    }
    // Re-validate edges cumulatively so a port used twice in the same batch is caught.
    const accepted: Connection[] = [];
    for (const c of conns) {
      const err = validatePatch(accepted, portsByDevice, c.a, c.b);
      if (err) return { ok: false, error: err };
      accepted.push(c);
    }
    await replaceConnections(db, rackId, accepted);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath(`/racks/${rackId}`);
  return { ok: true };
}

export async function updateRackAction(
  rackId: string, patch: { name?: string | null; heightU?: number },
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    if (patch.heightU !== undefined) {
      if (!Number.isInteger(patch.heightU) || patch.heightU < 1 || patch.heightU > 60) {
        return { ok: false, error: "Height must be 1–60 U" };
      }
      const [rows, ru] = await Promise.all([listRackDevices(db, rackId), templateHeights(db)]);
      const floor = minRackHeight(toPlacementLike(rows), ru);
      if (patch.heightU < floor) {
        return { ok: false, error: `Devices occupy up to U${floor} — move them before shrinking` };
      }
    }
    await updateRack(db, rackId, patch);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath(`/racks/${rackId}`);
  revalidatePath("/racks");
  return { ok: true };
}

/** Reconcile the rack's port endpoints. Re-validates every endpoint against FRESH device
 *  snapshots, floor types and site scope so a stale client can't attach a far end to a vanished
 *  port, use a non-floor type, or point at a rack/switch off this site. */
export async function saveEndpointsAction(
  rackId: string, eps: PortEndpoint[],
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    const [devices, types, scope] = await Promise.all([
      listRackDevices(db, rackId), listDeviceTypes(db), listSiteScope(db, rackId),
    ]);
    const portsByDevice: Record<string, PortRef[]> = {};
    for (const d of devices) {
      const front = (d.front_face as Face | null) ?? emptyFace();
      const back = (d.back_face as Face | null) ?? emptyFace();
      portsByDevice[d.id] = [...portsOf(front, d.id, "front"), ...portsOf(back, d.id, "back")];
    }
    const ctx: EndpointContext = {
      floorTypeIds: new Set(types.filter((t) => t.category === "floor").map((t) => t.id)),
      portsByDevice,
      thisRackId: rackId,
      siteRackIds: new Set(scope.racks.map((r) => r.id)),
      siteSwitchDeviceIds: new Set(scope.switches.map((s) => s.id)),
    };
    // One endpoint per port, checked across the batch (the DB unique index is the backstop).
    const seen = new Set<string>();
    for (const ep of eps) {
      const key = `${ep.port.rackDeviceId}|${ep.port.side}|${ep.port.groupId}|${ep.port.portIndex}`;
      if (seen.has(key)) return { ok: false, error: "That port already has an endpoint" };
      seen.add(key);
      const err = validateEndpoint(ep, ctx);
      if (err) return { ok: false, error: err };
    }
    await replacePortEndpoints(db, rackId, eps);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath(`/racks/${rackId}`);
  return { ok: true };
}
