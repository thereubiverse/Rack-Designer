import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listClients, listSitesForClient, countClientCascade, countSiteCascade } from "./repository";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

/** DB-free, filter-respecting in-memory Supabase fake. Unlike a canned-response fake, this one
 *  actually applies `.eq`/`.in`/`.is` against seeded rows, because the regression these tests guard
 *  against (a listing's counts leaking archived descendants) can only be caught by a fake that
 *  really filters — a fake returning a fixed response would pass regardless of which columns the
 *  code under test actually queried. `.select(cols, {count, head})` mirrors the head-count shape
 *  countClientCascade/countSiteCascade/countLiveCascadeForSites use for rack_devices/floor_devices. */
function makeMemoryDb(tables: Record<string, Row[]>): SupabaseClient {
  function makeNode(table: string, filters: Filter[], countHead: boolean | null): Record<string, unknown> {
    const node: Record<string, unknown> = {
      eq: (col: string, val: unknown) => makeNode(table, [...filters, (r) => r[col] === val], countHead),
      in: (col: string, vals: unknown[]) => makeNode(table, [...filters, (r) => vals.includes(r[col])], countHead),
      is: (col: string, val: unknown) => makeNode(table, [...filters, (r) => (r[col] ?? null) === val], countHead),
      order: () => node,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        const result =
          countHead !== null ? { data: null, count: rows.length, error: null } : { data: rows, error: null };
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return node;
  }

  return {
    from(table: string) {
      return {
        select: (_cols?: string, opts?: { count?: "exact"; head?: boolean }) =>
          makeNode(table, [], opts?.count ? !!opts.head : null),
      };
    },
  } as unknown as SupabaseClient;
}

/** One client (c1) with two live sites (A, B) and one ARCHIVED site (C):
 *   - Site A has a live floor (A1, 1 rack / 2 rack_devices / 1 floor_device) and an ARCHIVED floor
 *     (A2, 1 rack / 5 rack_devices / 3 floor_devices) — the archived floor's descendants must not
 *     count even though its parent site is live.
 *   - Site B has no floors at all.
 *   - Site C is archived; its live floor (C1, 1 rack / 2 rack_devices / 2 floor_devices) must not
 *     count for the LISTING functions at all, because the site itself isn't visible — but it DOES
 *     still count for the unfiltered cascade counters, which is what the last describe block below
 *     locks in. */
function seed(): Record<string, Row[]> {
  return {
    clients: [{ id: "c1", code: "ACME", name: "Acme", archived_at: null }],
    sites: [
      { id: "siteA", client_id: "c1", code: "A", name: "Site A", address: null, latitude: null, longitude: null, geocode_status: "pending", archived_at: null },
      { id: "siteB", client_id: "c1", code: "B", name: "Site B", address: null, latitude: null, longitude: null, geocode_status: "pending", archived_at: null },
      { id: "siteC", client_id: "c1", code: "C", name: "Site C", address: null, latitude: null, longitude: null, geocode_status: "pending", archived_at: "2026-01-01T00:00:00Z" },
    ],
    floors: [
      { id: "floorA1", site_id: "siteA", code: "1", archived_at: null },
      { id: "floorA2", site_id: "siteA", code: "2", archived_at: "2026-01-01T00:00:00Z" },
      { id: "floorC1", site_id: "siteC", code: "1", archived_at: null },
    ],
    rooms: [
      { id: "roomA1", floor_id: "floorA1" },
      { id: "roomA2", floor_id: "floorA2" },
      { id: "roomC1", floor_id: "floorC1" },
    ],
    racks: [
      { id: "rackA1", room_id: "roomA1" },
      { id: "rackA2", room_id: "roomA2" },
      { id: "rackC1", room_id: "roomC1" },
    ],
    rack_devices: [
      { id: "rd1", rack_id: "rackA1" },
      { id: "rd2", rack_id: "rackA1" },
      { id: "rd3", rack_id: "rackA2" },
      { id: "rd4", rack_id: "rackA2" },
      { id: "rd5", rack_id: "rackA2" },
      { id: "rd6", rack_id: "rackA2" },
      { id: "rd7", rack_id: "rackA2" },
      { id: "rd8", rack_id: "rackC1" },
      { id: "rd9", rack_id: "rackC1" },
    ],
    floor_devices: [
      { id: "fd1", floor_id: "floorA1", site_id: "siteA" },
      { id: "fd2", floor_id: "floorA2", site_id: "siteA" },
      { id: "fd3", floor_id: "floorA2", site_id: "siteA" },
      { id: "fd4", floor_id: "floorA2", site_id: "siteA" },
      { id: "fd5", floor_id: "floorC1", site_id: "siteC" },
      { id: "fd6", floor_id: "floorC1", site_id: "siteC" },
    ],
  };
}

// Regression for the IMPORTANT finding: listClients/listSitesForClient used to source their
// displayed counts straight from countClientCascade/countSiteCascade, which deliberately count
// archived descendants — so `/clients` could show "3 sites" for a client whose own page lists 2,
// and rack/device counts inflated by an archived floor's racks and devices.
describe("listClients — displayed counts exclude archived descendants", () => {
  it("counts only live sites, and only racks/devices under live floors of live sites", async () => {
    const db = makeMemoryDb(seed());

    const clients = await listClients(db);

    expect(clients).toHaveLength(1);
    expect(clients[0]).toMatchObject({
      id: "c1",
      siteCount: 2, // A, B — NOT C (archived)
      rackCount: 1, // rackA1 only — rackA2 (archived floor) and rackC1 (archived site) excluded
      deviceCount: 3, // fd1 (1) + rd1/rd2 (2) — NOT floorA2's 3 fd's, NOT rackA2's 5 rd's, NOT site C's
    });
  });
});

describe("listSitesForClient — displayed counts exclude archived descendants", () => {
  it("counts only racks/devices under a site's LIVE floors, and never lists the archived site", async () => {
    const db = makeMemoryDb(seed());

    const sites = await listSitesForClient(db, "c1");

    expect(sites.map((s) => s.code).sort()).toEqual(["A", "B"]); // C never appears — it's archived
    const siteA = sites.find((s) => s.code === "A");
    const siteB = sites.find((s) => s.code === "B");
    expect(siteA).toMatchObject({ rackCount: 1, deviceCount: 3 });
    expect(siteB).toMatchObject({ rackCount: 0, deviceCount: 0 });
  });
});

// The cascade counters exist for a different purpose ("what would a permanent delete destroy") and
// must keep including archived rows — this is the contract the fix above was NOT allowed to touch.
describe("countClientCascade / countSiteCascade — still deliberately include archived rows", () => {
  it("countClientCascade counts every site (including archived) and every descendant under it", async () => {
    const db = makeMemoryDb(seed());

    const counts = await countClientCascade(db, "c1");

    expect(counts).toEqual({ sites: 3, racks: 3, devices: 15 }); // 9 rack_devices + 6 floor_devices
  });

  it("countSiteCascade for site A still counts the archived floor's rack and devices", async () => {
    const db = makeMemoryDb(seed());

    const counts = await countSiteCascade(db, "siteA");

    // racks: rackA1 + rackA2 (archived floor) = 2. devices: fd1+fd2+fd3+fd4 (4) + rd1+rd2 (rackA1,
    // 2) + rd3..rd7 (rackA2, 5) = 11 — both larger than the live-only counts asserted above.
    expect(counts).toEqual({ racks: 2, devices: 11 });
  });
});
