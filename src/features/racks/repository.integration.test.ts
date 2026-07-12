import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getDefaultOrganization,
  createSite,
  createFloor,
  createRoom,
  createRack,
} from "@/features/locations/repository";
import { listDeviceTypes } from "@/features/device-library/repository";
import { createDeviceTemplate } from "@/features/device-library/repository";
import { emptyFace } from "@/domain/faceplate";
import { replaceRackDevices, listRackDevices, type RackDeviceInput } from "./repository";

function testDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

const db = testDb();

const TEMPLATE_NAME = "IT swap-test tpl";

async function cleanup() {
  // Cascades from sites down to racks down to rack_devices.
  await db.from("sites").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await db.from("device_templates").delete().eq("name", TEMPLATE_NAME);
}

describe("rack repository (integration)", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("reconciles a same-statement code swap between two kept devices", async () => {
    const org = await getDefaultOrganization(db);
    expect(org.id).toBeTruthy();

    const site = await createSite(db, { code: "HQ", name: "Headquarters" });
    const floor = await createFloor(db, { siteId: site.id, code: "28" });
    const room = await createRoom(db, { floorId: floor.id, code: "SL", type: "MDF" });
    const rack = await createRack(db, { roomId: room.id, code: "RK001_M", heightU: 12 });

    const deviceTypes = await listDeviceTypes(db);
    const rackType = deviceTypes.find((t) => t.category === "rack");
    if (!rackType) throw new Error("no rack-category device type available for test");

    const template = await createDeviceTemplate(db, {
      name: TEMPLATE_NAME,
      deviceTypeId: rackType.id,
      rackUnits: 1,
      widthIn: 17.5,
      rackMounted: true,
      frontFace: emptyFace(),
      backFace: emptyFace(),
    });

    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();

    const initial: RackDeviceInput[] = [
      {
        id: idA, device_template_id: template.id, code: "SW01", name: null,
        start_u: 1, side: "front", status: "installed",
        manufacturer: null, model_name: null, serial_number: null,
        purchase_date: null, operation_start: null,
      },
      {
        id: idB, device_template_id: template.id, code: "SW02", name: null,
        start_u: 2, side: "front", status: "installed",
        manufacturer: null, model_name: null, serial_number: null,
        purchase_date: null, operation_start: null,
      },
    ];

    await replaceRackDevices(db, rack.id, initial);

    const afterFirst = await listRackDevices(db, rack.id);
    expect(afterFirst).toHaveLength(2);

    const swapped: RackDeviceInput[] = [
      { ...initial[0], code: "SW02" },
      { ...initial[1], code: "SW01" },
    ];

    await expect(replaceRackDevices(db, rack.id, swapped)).resolves.not.toThrow();

    const afterSwap = await listRackDevices(db, rack.id);
    expect(afterSwap).toHaveLength(2);
    const byId = Object.fromEntries(afterSwap.map((r) => [r.id, r.code]));
    expect(byId[idA]).toBe("SW02");
    expect(byId[idB]).toBe("SW01");
  });
});
