import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The action calls next/cache's revalidatePath, which throws "static generation store missing"
// outside a real Next.js request context (this test runs the action directly against Supabase,
// not through a Next request). Stub it as a no-op — this is pure test infrastructure and doesn't
// touch the action's validation/persistence logic under test.
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/server";
import { emptyFace, type Face, type PortGroup } from "@/domain/faceplate";
import { getDefaultOrganization } from "@/features/locations/repository";
import { listDeviceTypes } from "@/features/device-library/repository";
import { saveConnectionsAction } from "./actions";
import { listConnections } from "./connectionsRepository";
import type { Connection } from "./connectionOps";

const db = createServiceClient();
let rackId = "";
let swId = "";
let ppId = "";
const ids: { site?: string; templateId?: string } = {};

// Real schema: connections.a_group_id/b_group_id are `uuid not null` columns, so the seeded
// face's portGroups[].id must be a real UUID (matching the connectionsRepository integration
// test's approach), not the brief's illustrative "g-sw"/"g-pp" strings.
const GROUP_SW = crypto.randomUUID();
const GROUP_PP = crypto.randomUUID();

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 24, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const faceWith = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });

beforeAll(async () => {
  // Same hierarchy shape as connectionsRepository.integration.test.ts: organization (seeded)
  // → site → floor → room → rack → 2 rack_devices with snapshot faces carrying real port groups.
  const org = await getDefaultOrganization(db);
  const site = (await db.from("sites")
    .insert({ organization_id: org.id, code: "T-ACT", name: "actions test" })
    .select().single()).data!;
  ids.site = site.id;
  const floor = (await db.from("floors")
    .insert({ site_id: site.id, code: "F-ACT", name: "F" })
    .select().single()).data!;
  const room = (await db.from("rooms")
    .insert({ floor_id: floor.id, code: "R-ACT", name: "R" })
    .select().single()).data!;
  const rack = (await db.from("racks")
    .insert({ room_id: room.id, code: "RKA", height_u: 12 })
    .select().single()).data!;
  rackId = rack.id;

  // device_templates.device_type_id is NOT NULL — reuse a real seeded "rack" device type
  // rather than the brief's illustrative device_type_id: null.
  const deviceTypes = await listDeviceTypes(db);
  const rackType = deviceTypes.find((t) => t.category === "rack");
  if (!rackType) throw new Error("no rack-category device type available for test");

  const tpl = (await db.from("device_templates").insert({
    organization_id: org.id, name: "actions test tpl", device_type_id: rackType.id,
    rack_units: 1, width_in: 19, rack_mounted: true,
    front_face: emptyFace(), back_face: emptyFace(),
  }).select().single()).data!;
  ids.templateId = tpl.id;

  swId = (await db.from("rack_devices").insert({
    rack_id: rackId, device_template_id: tpl.id, code: "SW01",
    start_u: 5, front_face: faceWith(GROUP_SW), back_face: emptyFace(), height_u: 1,
  }).select().single()).data!.id;
  ppId = (await db.from("rack_devices").insert({
    rack_id: rackId, device_template_id: tpl.id, code: "PP01",
    start_u: 3, front_face: faceWith(GROUP_PP), back_face: emptyFace(), height_u: 1,
  }).select().single()).data!.id;
});

afterAll(async () => {
  // Cascades: site → floors → rooms → racks → rack_devices → connections.
  if (ids.site) await db.from("sites").delete().eq("id", ids.site);
  // device_templates isn't cascaded from the site (ON DELETE RESTRICT), clean up separately.
  if (ids.templateId) await db.from("device_templates").delete().eq("id", ids.templateId);
});

const edge = (id: string, aIdx: number, bIdx: number): Connection => ({
  id,
  a: { rackDeviceId: swId, side: "front", groupId: GROUP_SW, portIndex: aIdx },
  b: { rackDeviceId: ppId, side: "front", groupId: GROUP_PP, portIndex: bIdx },
});

describe("saveConnectionsAction", () => {
  it("saves a valid edge", async () => {
    const res = await saveConnectionsAction(rackId, [edge("aaaaaaaa-0000-0000-0000-000000000001", 0, 0)]);
    expect(res.ok).toBe(true);
    expect(await listConnections(db, rackId)).toHaveLength(1);
  });

  it("rejects a port used twice", async () => {
    const res = await saveConnectionsAction(rackId, [
      edge("aaaaaaaa-0000-0000-0000-000000000002", 1, 1),
      edge("aaaaaaaa-0000-0000-0000-000000000003", 1, 2), // reuses sw port 1
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already connected|used twice/i);
  });

  it("rejects an edge referencing a non-existent port", async () => {
    const res = await saveConnectionsAction(rackId, [edge("aaaaaaaa-0000-0000-0000-000000000004", 99, 0)]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no longer exists|does not exist/i);
  });
});
