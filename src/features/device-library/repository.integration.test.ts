import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  listDeviceTypes, createDeviceType, deleteDeviceType,
  listBrands, createBrand,
  listDeviceTemplates, createDeviceTemplate, deleteDeviceTemplate,
} from "./repository";

function testDb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
const db = testDb();

async function cleanup() {
  await db.from("device_templates").delete().neq("name", "");
  await db.from("device_types").delete().eq("name", "ZZ Test Type");
  await db.from("brands").delete().eq("name", "ZZ Test Brand");
}

describe("device-library repository (integration)", () => {
  beforeAll(cleanup);
  afterEach(cleanup);

  it("lists the seeded device types", async () => {
    const types = await listDeviceTypes(db);
    expect(types.map((t) => t.name)).toContain("Switch");
  });

  it("lists the seeded Generic brand", async () => {
    const brands = await listBrands(db);
    expect(brands.map((b) => b.name)).toContain("Generic");
  });

  it("creates and lists a template with brand + type names", async () => {
    const type = await createDeviceType(db, { name: "ZZ Test Type" });
    const brand = await createBrand(db, { name: "ZZ Test Brand" });
    const tpl = await createDeviceTemplate(db, {
      name: "ZZ Test Device", deviceTypeId: type.id, brandId: brand.id,
      rackUnits: 1, widthIn: 10.6, rackMounted: true,
    });
    expect(tpl.width_in).toBe(10.6);

    const list = await listDeviceTemplates(db);
    const row = list.find((r) => r.id === tpl.id)!;
    expect(row.name).toBe("ZZ Test Device");
    expect(row.typeName).toBe("ZZ Test Type");
    expect(row.brandName).toBe("ZZ Test Brand");
    expect(row.widthIn).toBe(10.6);

    await deleteDeviceTemplate(db, tpl.id);
    expect((await listDeviceTemplates(db)).find((r) => r.id === tpl.id)).toBeUndefined();
    await deleteDeviceType(db, type.id);
  });
});
