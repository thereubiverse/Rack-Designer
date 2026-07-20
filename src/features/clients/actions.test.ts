import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SiteRow } from "@/lib/supabase/types";
import type { GeocodeResult } from "./geocodeOps";

// DB-free by construction: no real Supabase client, no real network call, no real cache
// invalidation. `createServiceClient` is swapped for a hand-rolled fake query builder (below)
// that records every call it receives so assertions can check real arguments, not just call
// counts. `geocodeAddress` and `revalidatePath` are plain vi.fn()s configured per test.
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn() }));
vi.mock("./geocode", () => ({ geocodeAddress: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/server";
import { geocodeAddress } from "./geocode";
import { setSiteGeocode } from "./repository";
import { createSiteAction, renameSiteAction } from "./actions";

interface DbConfig {
  insert?: () => { data: unknown; error: Error | null };
  select?: () => { data: unknown; error: Error | null } | Promise<never>;
  update?: (obj: Record<string, unknown>) => { error: Error | null } | Promise<never>;
}

/** A minimal fake Supabase query builder covering exactly the shapes repository.ts and actions.ts
 *  use against the "sites" table:
 *    insert(obj).select(cols).single()
 *    select(cols).eq(col, val).maybeSingle()
 *    update(obj).eq(col, val)                    (awaited directly, no further chaining)
 *  Every method that terminates a chain resolves via the matching `cfg` callback, which may
 *  return a plain result OR a rejecting Promise — the latter simulates the underlying db call
 *  itself throwing (a network error), as opposed to merely returning `{ error }`. `updateCalls`
 *  and `insertCalls` record the actual object passed to `.update()`/`.insert()` on every call, in
 *  call order, so tests can assert on real arguments rather than just call counts. */
function makeFakeDb(cfg: DbConfig = {}) {
  const updateCalls: Record<string, unknown>[] = [];
  const insertCalls: Record<string, unknown>[] = [];

  function makeNode(resolve: () => Promise<{ data?: unknown; error: Error | null }>) {
    const node: Record<string, unknown> = {
      eq: () => node,
      order: () => node,
      in: () => node,
      select: () => node,
      single: () => resolve(),
      maybeSingle: () => resolve(),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolve().then(res, rej),
    };
    return node;
  }

  const db = {
    from(_table: string) {
      return {
        insert(obj: Record<string, unknown>) {
          insertCalls.push(obj);
          return makeNode(async () =>
            cfg.insert ? cfg.insert() : { data: { id: "new-site-id" }, error: null }
          );
        },
        update(obj: Record<string, unknown>) {
          updateCalls.push(obj);
          return makeNode(async () => {
            if (!cfg.update) return { error: null };
            const result = cfg.update(obj);
            return result instanceof Promise ? await result : result;
          });
        },
        select(_cols?: string) {
          return makeNode(async () => {
            if (!cfg.select) return { data: null, error: null };
            const result = cfg.select();
            return result instanceof Promise ? await result : result;
          });
        },
        delete() {
          return makeNode(async () => ({ error: null }));
        },
      };
    },
  };

  return { db: db as unknown as SupabaseClient, updateCalls, insertCalls };
}

function siteRow(overrides: Partial<SiteRow> = {}): SiteRow {
  return {
    id: "s1",
    client_id: "c1",
    code: "HQ",
    name: "Headquarters",
    address: "123 Main St",
    latitude: null,
    longitude: null,
    geocode_status: "pending",
    geocoded_at: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function createSiteForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("clientId", "c1");
  fd.set("code", "HQ");
  fd.set("name", "Headquarters");
  fd.set("address", "1 Main St, Springfield, USA");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function renameSiteForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("id", "s1");
  fd.set("code", "HQ");
  fd.set("name", "Headquarters");
  fd.set("address", "456 Elm St");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createSiteAction — geocoding must never fail a write", () => {
  it("returns ok:true even when geocodeAddress REJECTS", async () => {
    const { db } = makeFakeDb({ insert: () => ({ data: { id: "site-1" }, error: null }) });
    vi.mocked(createServiceClient).mockReturnValue(db);
    vi.mocked(geocodeAddress).mockRejectedValueOnce(new Error("geocoder unreachable"));

    const res = await createSiteAction(createSiteForm());

    expect(res).toEqual({ ok: true });
  });

  it("returns ok:true even when setSiteGeocode's underlying db call rejects", async () => {
    const { db, updateCalls } = makeFakeDb({
      insert: () => ({ data: { id: "site-1" }, error: null }),
      // Only the geocode-write update (the one carrying geocoded_at) rejects — a real network
      // failure on that specific call, not merely an { error } result.
      update: (obj) => ("geocoded_at" in obj ? Promise.reject(new Error("db unreachable")) : { error: null }),
    });
    vi.mocked(createServiceClient).mockReturnValue(db);
    vi.mocked(geocodeAddress).mockResolvedValueOnce({ status: "ok", lat: 1, lng: 2 });

    const res = await createSiteAction(createSiteForm());

    expect(res).toEqual({ ok: true });
    // The geocode write really was attempted (and really did fail) — this isn't a false-pass
    // where setSiteGeocode was never reached at all.
    expect(updateCalls.some((c) => "geocoded_at" in c)).toBe(true);
  });

  it("still returns ok:true (with an error) when the initial insert itself fails — sanity check that ok:false is reachable at all", async () => {
    const { db } = makeFakeDb({ insert: () => ({ data: null, error: new Error("duplicate key") }) });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createSiteAction(createSiteForm());

    expect(res.ok).toBe(false);
  });
});

describe("renameSiteAction — geocoding must never fail a write", () => {
  it("returns ok:true even when geocodeAddress REJECTS", async () => {
    const { db } = makeFakeDb({
      select: () => ({ data: siteRow({ address: "123 Main St" }), error: null }),
    });
    vi.mocked(createServiceClient).mockReturnValue(db);
    vi.mocked(geocodeAddress).mockRejectedValueOnce(new Error("timeout"));

    // address in the form ("456 Elm St") differs from previousAddress ("123 Main St"), so the
    // re-geocode path (where geocodeAddress lives) actually runs.
    const res = await renameSiteAction(renameSiteForm());

    expect(res).toEqual({ ok: true });
  });

  it("returns ok:true even when setSiteGeocode's underlying db call rejects", async () => {
    const { db, updateCalls } = makeFakeDb({
      select: () => ({ data: siteRow({ address: "123 Main St" }), error: null }),
      update: (obj) => ("geocoded_at" in obj ? Promise.reject(new Error("db unreachable")) : { error: null }),
    });
    vi.mocked(createServiceClient).mockReturnValue(db);
    vi.mocked(geocodeAddress).mockResolvedValueOnce({ status: "ok", lat: 1, lng: 2 });

    const res = await renameSiteAction(renameSiteForm());

    expect(res).toEqual({ ok: true });
    expect(updateCalls.some((c) => "geocoded_at" in c)).toBe(true);
  });

  it("does NOT call geocodeAddress when the address is unchanged (the rate-limit guarantee)", async () => {
    const { db } = makeFakeDb({
      select: () => ({ data: siteRow({ address: "456 Elm St" }), error: null }),
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await renameSiteAction(renameSiteForm({ address: "456 Elm St" }));

    expect(res).toEqual({ ok: true });
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it("DOES call geocodeAddress when the address changed", async () => {
    const { db } = makeFakeDb({
      select: () => ({ data: siteRow({ address: "123 Main St" }), error: null }),
    });
    vi.mocked(createServiceClient).mockReturnValue(db);
    vi.mocked(geocodeAddress).mockResolvedValueOnce({ status: "not_found" });

    const res = await renameSiteAction(renameSiteForm({ address: "456 Elm St" }));

    expect(res).toEqual({ ok: true });
    expect(geocodeAddress).toHaveBeenCalledTimes(1);
    expect(vi.mocked(geocodeAddress).mock.calls[0][0]).toBe("456 Elm St");
  });

  it("still returns ok:true when the pre-read (getSiteById) rejects — a geocode-support read must never reject a rename", async () => {
    const { db } = makeFakeDb({
      select: () => Promise.reject(new Error("read failed")),
    });
    vi.mocked(createServiceClient).mockReturnValue(db);
    vi.mocked(geocodeAddress).mockResolvedValueOnce({ status: "not_found" });

    const res = await renameSiteAction(renameSiteForm({ address: "789 Oak St" }));

    expect(res).toEqual({ ok: true });
  });

  it("clears coordinates before re-geocoding when the address changed", async () => {
    const { db, updateCalls } = makeFakeDb({
      select: () => ({ data: siteRow({ address: "123 Main St" }), error: null }),
    });
    vi.mocked(createServiceClient).mockReturnValue(db);
    vi.mocked(geocodeAddress).mockResolvedValueOnce({ status: "ok", lat: 5, lng: 6 });

    await renameSiteAction(renameSiteForm({ address: "456 Elm St" }));

    const renameIndex = updateCalls.findIndex((c) => "code" in c);
    const clearIndex = updateCalls.findIndex(
      (c) => c.latitude === null && c.longitude === null && c.geocode_status === "pending"
    );
    const finalIndex = updateCalls.findIndex((c) => "geocoded_at" in c);

    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(clearIndex).toBeGreaterThan(renameIndex);
    expect(finalIndex).toBeGreaterThan(clearIndex);
  });
});

describe("setSiteGeocode — writes the right patch for each GeocodeResult arm", () => {
  it("ok arm: sets both coordinates and geocode_status", async () => {
    const { db, updateCalls } = makeFakeDb();
    const result: GeocodeResult = { status: "ok", lat: 51.5, lng: -0.1 };

    await setSiteGeocode(db, "site-1", result);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ latitude: 51.5, longitude: -0.1, geocode_status: "ok" });
  });

  it("not_found arm: clears both coordinates", async () => {
    const { db, updateCalls } = makeFakeDb();
    const result: GeocodeResult = { status: "not_found" };

    await setSiteGeocode(db, "site-1", result);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ latitude: null, longitude: null, geocode_status: "not_found" });
  });

  it("failed arm: sets only the status, leaving latitude/longitude out of the patch entirely", async () => {
    const { db, updateCalls } = makeFakeDb();
    const result: GeocodeResult = { status: "failed", error: "boom" };

    await setSiteGeocode(db, "site-1", result);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toMatchObject({ geocode_status: "failed" });
    expect(updateCalls[0]).not.toHaveProperty("latitude");
    expect(updateCalls[0]).not.toHaveProperty("longitude");
  });
});
