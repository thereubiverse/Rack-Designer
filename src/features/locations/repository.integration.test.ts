import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { createClient as createClientRecord } from "@/features/clients/repository";
import {
  createSite,
  createFloor,
  createRoom,
  createRack,
} from "./repository";

function testDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createSupabaseClient(url, key, { auth: { persistSession: false } });
}

const db = testDb();

const CLIENT_CODE = "T-LOC";

async function cleanup() {
  // Cascades: client → sites → floors → rooms → racks.
  await db.from("clients").delete().eq("code", CLIENT_CODE);
}

describe("location repository (integration)", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("creates a full hierarchy under a client's site", async () => {
    const client = await createClientRecord(db, { code: CLIENT_CODE, name: "location repo test" });
    const site = await createSite(db, { clientId: client.id, code: "HQ", name: "Headquarters" });
    expect(site.client_id).toBe(client.id);
    const floor = await createFloor(db, { siteId: site.id, code: "28" });
    const room = await createRoom(db, { floorId: floor.id, code: "SL", type: "MDF" });
    const rack = await createRack(db, { roomId: room.id, code: "RK001_M", heightU: 42 });
    expect(rack.height_u).toBe(42);
  });
});
