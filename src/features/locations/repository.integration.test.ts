import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  getDefaultOrganization,
  createSite,
  createFloor,
  createRoom,
  createRack,
  listRacksWithPath,
} from "./repository";

function testDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

const db = testDb();

async function cleanup() {
  // Cascades from sites down to racks.
  await db.from("sites").delete().neq("id", "00000000-0000-0000-0000-000000000000");
}

describe("location repository (integration)", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("returns the seeded default organization", async () => {
    const org = await getDefaultOrganization(db);
    expect(org.code).toBe("DEFAULT");
  });

  it("creates a full hierarchy and lists racks with a derived path", async () => {
    const org = await getDefaultOrganization(db);
    const site = await createSite(db, { code: "HQ", name: "Headquarters" });
    expect(site.organization_id).toBe(org.id);
    const floor = await createFloor(db, { siteId: site.id, code: "28" });
    const room = await createRoom(db, { floorId: floor.id, code: "SL", type: "MDF" });
    const rack = await createRack(db, { roomId: room.id, code: "RK001_M", heightU: 42 });
    expect(rack.height_u).toBe(42);

    const rows = await listRacksWithPath(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("HQ/28/SL/RK001_M");
    expect(rows[0].roomType).toBe("MDF");
    expect(rows[0].heightU).toBe(42);
  });
});
