import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  listDeviceTypes, createDeviceType, deleteDeviceType,
  listBrands, createBrand,
  listDeviceTemplates, createDeviceTemplate, deleteDeviceTemplate,
  getDeviceTemplate, updateDeviceTemplate, toEditableTemplate,
} from "./repository";
import { emptyFace, type Face } from "@/domain/faceplate";

function testDb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
const db = testDb();

async function cleanup() {
  await db.from("device_templates").delete().like("name", "ZZ Test%");
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

describe("device-library repository — faces (integration)", () => {
  it("round-trips a non-empty front face through create + get", async () => {
    const type = await createDeviceType(db, { name: "ZZ Test Type" });
    const face: Face = {
      portGroups: [{
        id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "Gi",
        countingDirection: "ltr", rows: 1, cols: 2, gridX: 0, gridY: 0,
        colSpacing: 0, rowSpacing: 0, portOverrides: {},
      }],
      elements: [],
    };
    const tpl = await createDeviceTemplate(db, {
      name: "ZZ Test Faces", deviceTypeId: type.id, rackUnits: 1, widthIn: 19,
      rackMounted: true, frontFace: face, backFace: emptyFace(),
    });

    const got = await getDeviceTemplate(db, tpl.id);
    expect(got).not.toBeNull();
    const editable = toEditableTemplate(got!);
    expect(editable.frontFace).toEqual(face);
    expect(editable.backFace).toEqual(emptyFace());

    await deleteDeviceTemplate(db, tpl.id);
    await deleteDeviceType(db, type.id);
  });

  it("update persists changed fields and both faces", async () => {
    const type = await createDeviceType(db, { name: "ZZ Test Type" });
    const tpl = await createDeviceTemplate(db, {
      name: "ZZ Test Upd", deviceTypeId: type.id, rackUnits: 1, widthIn: 19, rackMounted: true,
    });
    const backFace: Face = {
      portGroups: [{
        id: "b1", media: "sfp", connectorType: "SFP+", idPrefix: "SFP",
        countingDirection: "ltr", rows: 1, cols: 1, gridX: 4, gridY: 4,
        colSpacing: 0, rowSpacing: 0, portOverrides: {},
      }],
      elements: [],
    };
    await updateDeviceTemplate(db, tpl.id, {
      name: "ZZ Test Upd2", deviceTypeId: type.id, brandId: null,
      rackUnits: 2, widthIn: 10.6, rackMounted: false,
      frontFace: emptyFace(), backFace,
    });

    const editable = toEditableTemplate((await getDeviceTemplate(db, tpl.id))!);
    expect(editable.name).toBe("ZZ Test Upd2");
    expect(editable.rackUnits).toBe(2);
    expect(editable.widthIn).toBe(10.6);
    expect(editable.rackMounted).toBe(false);
    expect(editable.backFace).toEqual(backFace);

    await deleteDeviceTemplate(db, tpl.id);
    await deleteDeviceType(db, type.id);
  });

  it("getDeviceTemplate returns null for a missing id", async () => {
    expect(await getDeviceTemplate(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
