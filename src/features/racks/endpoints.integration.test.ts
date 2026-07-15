import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The action calls next/cache's revalidatePath, which throws "static generation store missing"
// outside a real Next.js request context. Stub it — test infrastructure only, it doesn't touch
// the validation/persistence under test. (Same reason as actions.integration.test.ts.)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/server";
import { emptyFace, type Face, type PortGroup } from "@/domain/faceplate";
import { getDefaultOrganization } from "@/features/locations/repository";
import { listDeviceTypes } from "@/features/device-library/repository";
import { saveEndpointsAction } from "./actions";
import { listPortEndpoints } from "./endpointsRepository";
import type { PortEndpoint } from "./endpointOps";

const db = createServiceClient();
let rackId = "";      // the rack under test
let otherRackId = ""; // a second rack on the SAME site — the valid uplink target
let ppId = "";
let camTypeId = "";
const ids: { site?: string; templateId?: string } = {};

// port_endpoints.group_id is `uuid not null`, so the seeded face's group id must be a real UUID.
const GROUP_PP = crypto.randomUUID();

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 24, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const faceWith = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });

beforeAll(async () => {
  const org = await getDefaultOrganization(db);
  const site = (await db.from("sites")
    .insert({ organization_id: org.id, code: "T-EP", name: "endpoints test" })
    .select().single()).data!;
  ids.site = site.id;
  const floor = (await db.from("floors")
    .insert({ site_id: site.id, code: "F-EP", name: "F" })
    .select().single()).data!;
  const room = (await db.from("rooms")
    .insert({ floor_id: floor.id, code: "R-EP", name: "R" })
    .select().single()).data!;
  rackId = (await db.from("racks")
    .insert({ room_id: room.id, code: "RKE1", height_u: 12 }).select().single()).data!.id;
  // Second rack on the same site — makes listSiteScope non-empty and gives uplinks a valid target.
  otherRackId = (await db.from("racks")
    .insert({ room_id: room.id, code: "RKE2", height_u: 12 }).select().single()).data!.id;

  const deviceTypes = await listDeviceTypes(db);
  const rackType = deviceTypes.find((t) => t.category === "rack");
  if (!rackType) throw new Error("no rack-category device type available for test");
  const cam = deviceTypes.find((t) => t.category === "floor" && t.code === "CAM");
  if (!cam) throw new Error("no CAM floor device type available for test");
  camTypeId = cam.id;

  const tpl = (await db.from("device_templates").insert({
    organization_id: org.id, name: "endpoints test tpl", device_type_id: rackType.id,
    rack_units: 1, width_in: 19, rack_mounted: true,
    front_face: emptyFace(), back_face: emptyFace(),
  }).select().single()).data!;
  ids.templateId = tpl.id;

  ppId = (await db.from("rack_devices").insert({
    rack_id: rackId, device_template_id: tpl.id, code: "PP01",
    start_u: 3, front_face: faceWith(GROUP_PP), back_face: emptyFace(), height_u: 1,
  }).select().single()).data!.id;
});

afterAll(async () => {
  // SCOPED cleanup: only this test's site. Cascades to floors → rooms → racks → rack_devices →
  // port_endpoints. Never `.neq(...)` — that would wipe the developer's own data.
  if (ids.site) await db.from("sites").delete().eq("id", ids.site);
  // device_templates isn't cascaded from the site (ON DELETE RESTRICT), clean up separately.
  if (ids.templateId) await db.from("device_templates").delete().eq("id", ids.templateId);
});

const port = (i: number) => ({ rackDeviceId: ppId, side: "front" as const, groupId: GROUP_PP, portIndex: i });
const cam = (i: number, over: Partial<Extract<PortEndpoint, { kind: "described" }>> = {}): PortEndpoint => ({
  id: crypto.randomUUID(), port: port(i), kind: "described", deviceTypeId: camTypeId,
  name: "CAM01", portCount: 1, landingPortIndex: 0, landingPortLabel: "Lobby", ...over,
});

describe("saveEndpointsAction", () => {
  it("saves a described endpoint and reads it back", async () => {
    const res = await saveEndpointsAction(rackId, [cam(0)]);
    expect(res.ok).toBe(true);
    const back = await listPortEndpoints(db, rackId);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ kind: "described", name: "CAM01", landingPortLabel: "Lobby" });
  });

  it("rejects an endpoint on a port that does not exist", async () => {
    const res = await saveEndpointsAction(rackId, [cam(9999)]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That port no longer exists");
  });

  it("rejects two endpoints on the same port", async () => {
    const res = await saveEndpointsAction(rackId, [cam(1), cam(1)]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That port already has an endpoint");
  });

  it("rejects a rack uplink to this same rack", async () => {
    const ep: PortEndpoint = { id: crypto.randomUUID(), port: port(2), kind: "rack", targetRackId: rackId };
    const res = await saveEndpointsAction(rackId, [ep]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("An uplink must target a different rack");
  });

  it("accepts a rack uplink to another rack on the same site", async () => {
    const ep: PortEndpoint = { id: crypto.randomUUID(), port: port(3), kind: "rack", targetRackId: otherRackId };
    const res = await saveEndpointsAction(rackId, [ep]);
    expect(res.ok).toBe(true);
  });

  it("removes an endpoint when it is omitted from the next save", async () => {
    await saveEndpointsAction(rackId, [cam(0)]);
    const res = await saveEndpointsAction(rackId, []);
    expect(res.ok).toBe(true);
    expect(await listPortEndpoints(db, rackId)).toHaveLength(0);
  });
});
