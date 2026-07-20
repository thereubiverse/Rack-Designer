import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  listClients,
  getClientByCode,
  listSitesForClient,
  getSiteByCode,
  listRacksForSite,
  createClient as createClientRow,
  renameClient,
  deleteClient,
  createSiteForClient,
  renameSite,
  deleteSite,
  countClientCascade,
  countSiteCascade,
} from "./repository";

function testDb(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

const db = testDb();

async function cleanup() {
  // Cascades from clients down through sites/floors/rooms/racks/rack_devices.
  await db.from("clients").delete().like("code", "T-CLI%");
}

describe("clients repository (integration)", () => {
  beforeAll(async () => {
    await cleanup();
  });
  afterEach(async () => {
    await cleanup();
  });

  it("creates a client and lists it with derived site/rack counts", async () => {
    const client = await createClientRow(db, { code: "t-cli-a", name: "Client A" });
    expect(client.code).toBe("T-CLI-A");

    const site = await createSiteForClient(db, {
      clientId: client.id,
      code: "hq",
      name: "Headquarters",
    });
    expect(site.code).toBe("HQ");

    const clients = await listClients(db);
    const found = clients.find((c) => c.id === client.id);
    expect(found).toBeDefined();
    expect(found!.siteCount).toBe(1);
    expect(found!.rackCount).toBe(0);
  });

  it("looks up a client by code case-insensitively", async () => {
    await createClientRow(db, { code: "T-CLI-B", name: "Client B" });
    const found = await getClientByCode(db, "t-cli-b");
    expect(found).not.toBeNull();
    expect(found!.code).toBe("T-CLI-B");
  });

  it("returns null from getClientByCode when nothing matches", async () => {
    const found = await getClientByCode(db, "T-CLI-NOPE");
    expect(found).toBeNull();
  });

  it("rejects a duplicate client code", async () => {
    await createClientRow(db, { code: "T-CLI-C", name: "Client C" });
    await expect(createClientRow(db, { code: "t-cli-c", name: "Client C dup" })).rejects.toThrow(
      /createClient/
    );
  });

  it("renames and deletes a client", async () => {
    const client = await createClientRow(db, { code: "T-CLI-D", name: "Client D" });
    await renameClient(db, client.id, { code: "T-CLI-D2", name: "Client D Renamed" });
    const renamed = await getClientByCode(db, "T-CLI-D2");
    expect(renamed).not.toBeNull();
    expect(renamed!.name).toBe("Client D Renamed");

    await deleteClient(db, client.id);
    const gone = await getClientByCode(db, "T-CLI-D2");
    expect(gone).toBeNull();
  });

  it("lists, looks up, renames, and deletes sites for a client", async () => {
    const client = await createClientRow(db, { code: "T-CLI-E", name: "Client E" });
    const site = await createSiteForClient(db, {
      clientId: client.id,
      code: "site1",
      name: "Site One",
      address: "123 Main St",
    });

    const sites = await listSitesForClient(db, client.id);
    expect(sites).toHaveLength(1);
    expect(sites[0].code).toBe("SITE1");
    expect(sites[0].address).toBe("123 Main St");
    expect(sites[0].rackCount).toBe(0);

    const foundSite = await getSiteByCode(db, client.id, "site1");
    expect(foundSite).not.toBeNull();
    expect(foundSite!.id).toBe(site.id);

    await renameSite(db, site.id, { code: "SITE1B", name: "Site One B", address: null });
    const renamedSite = await getSiteByCode(db, client.id, "site1b");
    expect(renamedSite).not.toBeNull();
    expect(renamedSite!.name).toBe("Site One B");
    expect(renamedSite!.address).toBeNull();

    await deleteSite(db, site.id);
    const goneSite = await getSiteByCode(db, client.id, "site1b");
    expect(goneSite).toBeNull();
  });

  it("lists racks for a site with floor/room/type/device counts", async () => {
    const client = await createClientRow(db, { code: "T-CLI-F", name: "Client F" });
    const site = await createSiteForClient(db, { clientId: client.id, code: "S1", name: "Site 1" });

    const { data: floor, error: floorErr } = await db
      .from("floors")
      .insert({ site_id: site.id, code: "1", name: "Floor 1" })
      .select("*")
      .single();
    expect(floorErr).toBeNull();

    const { data: room, error: roomErr } = await db
      .from("rooms")
      .insert({ floor_id: floor!.id, code: "MDF1", type: "MDF" })
      .select("*")
      .single();
    expect(roomErr).toBeNull();

    const { data: rack, error: rackErr } = await db
      .from("racks")
      .insert({ room_id: room!.id, code: "RK1", height_u: 42 })
      .select("*")
      .single();
    expect(rackErr).toBeNull();

    const racks = await listRacksForSite(db, site.id);
    expect(racks).toHaveLength(1);
    expect(racks[0].id).toBe(rack!.id);
    expect(racks[0].code).toBe("RK1");
    expect(racks[0].heightU).toBe(42);
    expect(racks[0].floorCode).toBe("1");
    expect(racks[0].roomCode).toBe("MDF1");
    expect(racks[0].roomType).toBe("MDF");
    expect(racks[0].deviceCount).toBe(0);
  });

  it("counts the full cascade under a client and a site", async () => {
    const client = await createClientRow(db, { code: "T-CLI-G", name: "Client G" });
    const site = await createSiteForClient(db, { clientId: client.id, code: "S1", name: "Site 1" });

    const { data: floor } = await db
      .from("floors")
      .insert({ site_id: site.id, code: "1" })
      .select("*")
      .single();
    const { data: room } = await db
      .from("rooms")
      .insert({ floor_id: floor!.id, code: "MDF1", type: "MDF" })
      .select("*")
      .single();
    const { data: rack } = await db
      .from("racks")
      .insert({ room_id: room!.id, code: "RK1", height_u: 42 })
      .select("*")
      .single();

    const { data: template } = await db.from("device_templates").select("id").limit(1).single();
    await db
      .from("rack_devices")
      .insert({ rack_id: rack!.id, device_template_id: template!.id, code: "DEV1", start_u: 1 });

    const siteCounts = await countSiteCascade(db, site.id);
    expect(siteCounts.racks).toBe(1);
    expect(siteCounts.devices).toBe(1);

    const clientCounts = await countClientCascade(db, client.id);
    expect(clientCounts.sites).toBe(1);
    expect(clientCounts.racks).toBe(1);
    expect(clientCounts.devices).toBe(1);
  });

  it("cascades sites away when a client is deleted", async () => {
    const client = await createClientRow(db, { code: "T-CLI-H", name: "Client H" });
    const site = await createSiteForClient(db, { clientId: client.id, code: "S1", name: "Site 1" });

    await deleteClient(db, client.id);

    const sites = await listSitesForClient(db, client.id);
    expect(sites).toHaveLength(0);
    const goneSite = await getSiteByCode(db, client.id, "S1");
    expect(goneSite).toBeNull();
    expect(site.id).toBeTruthy();
  });

  // Regression for the CRITICAL `.ilike` finding: a raw URL segment must never be treated as a
  // LIKE pattern. `_` is a legal character in a code (isValidCode allows it) and a LIKE
  // metacharacter at the same time, so a client whose code literally contains `_` must resolve
  // only itself, and a segment containing `_` must never wildcard-match a different client whose
  // code happens to share every other character.
  it("resolves a code containing a literal underscore to itself only, not as a wildcard", async () => {
    const underscored = await createClientRow(db, { code: "T-CLI-A_ME", name: "Underscore client" });
    // Same shape but with a real character where the underscore is — an ilike pattern built from
    // "T-CLI-A_ME" would match this row too via the `_` wildcard.
    const lookalike = await createClientRow(db, { code: "T-CLI-AXME", name: "Lookalike client" });

    const found = await getClientByCode(db, "t-cli-a_me"); // lowercase, exercising case-insensitivity too
    expect(found).not.toBeNull();
    expect(found!.id).toBe(underscored.id);
    expect(found!.code).toBe("T-CLI-A_ME");
    expect(found!.id).not.toBe(lookalike.id);
  });

  it("does not let an underscore segment wildcard-match a code without a literal underscore", async () => {
    // Mirrors the review's ACME / A_ME example: no client literally named "T-CLI-A_ME" exists here,
    // only "T-CLI-ACME" — an ilike pattern would still match it via the `_` wildcard; exact match must not.
    await createClientRow(db, { code: "T-CLI-ACME", name: "Acme-like client" });
    const found = await getClientByCode(db, "T-CLI-A_ME");
    expect(found).toBeNull();
  });

  it("resolves a site code containing a literal underscore to itself only, not as a wildcard", async () => {
    const client = await createClientRow(db, { code: "T-CLI-I", name: "Client I" });
    const underscored = await createSiteForClient(db, { clientId: client.id, code: "S_TE", name: "Site underscore" });
    const lookalike = await createSiteForClient(db, { clientId: client.id, code: "SXTE", name: "Site lookalike" });

    const found = await getSiteByCode(db, client.id, "s_te");
    expect(found).not.toBeNull();
    expect(found!.id).toBe(underscored.id);
    expect(found!.id).not.toBe(lookalike.id);
  });

  it("does not let a site underscore segment wildcard-match a lookalike code", async () => {
    const client = await createClientRow(db, { code: "T-CLI-J", name: "Client J" });
    await createSiteForClient(db, { clientId: client.id, code: "SATE", name: "Site A" });
    const found = await getSiteByCode(db, client.id, "S_TE");
    expect(found).toBeNull();
  });
});
