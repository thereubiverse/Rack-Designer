import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { emptyFace } from "@/domain/faceplate";
import { createClient } from "@/features/clients/repository";
import { listDeviceTypes } from "@/features/device-library/repository";
import { listConnections, replaceConnections } from "./connectionsRepository";
import type { Connection } from "./connectionOps";

const db = createServiceClient();
let rackId = "";
let swId = "";
let ppId = "";
const ids: { client?: string; templateId?: string } = {};

// Real schema: connections.a_group_id/b_group_id are `uuid not null` columns (matching how
// portGroup ids are generated app-side via crypto.randomUUID()), so test group ids must be
// valid UUIDs rather than the brief's illustrative "g-sw"/"g-pp" strings.
const GROUP_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeAll(async () => {
  // Minimal hierarchy: client (seeded) → site → floor → room → rack → 2 rack_devices.
  // (The brief's illustrative seed used a "locations" table with location_id/level columns;
  // the real hierarchy migration (0001_location_hierarchy.sql) has no "locations" table — it's
  // sites (client_id, code, name) → floors (site_id, code, sort_order) → rooms (floor_id,
  // code, type-defaulted) → racks (room_id, code, height_u). Adapted seed calls below accordingly.)
  const client = await createClient(db, { code: "T-CONN-CLI", name: "conn repo test" });
  ids.client = client.id;
  const site = (await db.from("sites")
    .insert({ client_id: client.id, code: "T-CONN", name: "conn repo test" })
    .select().single()).data!;
  const floor = (await db.from("floors")
    .insert({ site_id: site.id, code: "F-CONN", name: "F" })
    .select().single()).data!;
  const room = (await db.from("rooms")
    .insert({ floor_id: floor.id, code: "R-CONN", name: "R" })
    .select().single()).data!;
  const rack = (await db.from("racks")
    .insert({ room_id: room.id, code: "RKX", height_u: 12 })
    .select().single()).data!;
  rackId = rack.id;

  // device_templates.device_type_id is `uuid not null references device_types` (the brief's
  // seed passed device_type_id: null, which the real NOT NULL constraint rejects) — look up a
  // real seeded device type instead.
  const deviceTypes = await listDeviceTypes(db);
  const rackType = deviceTypes.find((t) => t.category === "rack");
  if (!rackType) throw new Error("no rack-category device type available for test");

  const tpl = (await db.from("device_templates").insert({
    name: "conn repo test tpl", device_type_id: rackType.id,
    rack_units: 1, width_in: 19, rack_mounted: true,
    front_face: emptyFace(), back_face: emptyFace(),
  }).select().single()).data!;
  ids.templateId = tpl.id;

  const mk = async (code: string) => (await db.from("rack_devices").insert({
    rack_id: rackId, device_template_id: tpl.id, code, start_u: code === "SW01" ? 5 : 3,
    front_face: emptyFace(), back_face: emptyFace(), height_u: 1,
  }).select().single()).data!.id;
  swId = await mk("SW01");
  ppId = await mk("PP01");
});

afterAll(async () => {
  // Cascades: client → sites → floors → rooms → racks → rack_devices → connections.
  if (ids.client) await db.from("clients").delete().eq("id", ids.client);
  // device_templates isn't cascaded from the client (device_template_id is ON DELETE RESTRICT),
  // so it must be cleaned up separately, after the rack_devices referencing it are gone.
  if (ids.templateId) await db.from("device_templates").delete().eq("id", ids.templateId);
});

const conn = (id: string): Connection => ({
  id,
  a: { rackDeviceId: swId, side: "front", groupId: GROUP_A, portIndex: 0 },
  b: { rackDeviceId: ppId, side: "front", groupId: GROUP_B, portIndex: 0 },
});

describe("connections repository", () => {
  it("replace then list round-trips a connection", async () => {
    await replaceConnections(db, rackId, [conn("11111111-1111-1111-1111-111111111111")]);
    const got = await listConnections(db, rackId);
    expect(got).toHaveLength(1);
    expect(got[0].a.rackDeviceId).toBe(swId);
    expect(got[0].b.portIndex).toBe(0);
  });

  it("replace with [] deletes existing connections", async () => {
    await replaceConnections(db, rackId, []);
    expect(await listConnections(db, rackId)).toHaveLength(0);
  });

  it("cascades when a device is deleted", async () => {
    await replaceConnections(db, rackId, [conn("22222222-2222-2222-2222-222222222222")]);
    await db.from("rack_devices").delete().eq("id", swId);
    expect(await listConnections(db, rackId)).toHaveLength(0);
  });
});
