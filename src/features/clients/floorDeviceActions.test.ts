import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// DB-free by construction: no real Supabase client, no real cache invalidation.
// `createServiceClient` is swapped for a hand-rolled, TABLE-AWARE fake query builder (below) that
// records every insert/update/delete it receives — including which table and which filters were
// applied — so assertions can check real recorded arguments rather than just call counts.
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/server";
import {
  createFloorDeviceAction,
  updateFloorDeviceAction,
  deleteFloorDeviceAction,
} from "./actions";

type SelectResult = { data: unknown; error: Error | null } | Promise<never>;
type InsertResult = { data: unknown; error: Error | null } | Promise<never>;

interface TableConfig {
  selectResult?: () => SelectResult;
  insertResult?: (values: Record<string, unknown>) => InsertResult;
}

/** A minimal, TABLE-AWARE fake Supabase query builder covering the shapes
 *  locations/repository.ts and clients/actions.ts use for floor devices:
 *    insert(obj).select(cols).single()
 *    select("id, site_id").eq("id", x).single()      (floor lookup)
 *    select("id, category").eq("id", x).single()     (device type lookup)
 *    update(obj).eq(col, val)                        (awaited directly, no further chaining)
 *    delete().eq(col, val)                            (awaited directly, no further chaining)
 *  `insertCalls`/`updateCalls`/`deleteCalls` record the table name and the actual
 *  values/filters passed on every call, in call order, so tests can assert on real recorded
 *  arguments — e.g. that the site_id on an insert was derived from the floor row, not the caller. */
function makeFakeDb(cfg: Record<string, TableConfig> = {}) {
  const insertCalls: Array<{ table: string; values: Record<string, unknown> }> = [];
  const updateCalls: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const deleteCalls: Array<{ table: string; filters: Record<string, unknown> }> = [];

  async function resolveSelect(table: string) {
    const fn = cfg[table]?.selectResult;
    if (!fn) return { data: [], error: null };
    const r = fn();
    return r instanceof Promise ? await r : r;
  }

  function makeSelectNode(table: string) {
    const node: Record<string, unknown> = {
      eq: () => node,
      in: () => node,
      order: () => node,
      single: async () => resolveSelect(table),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolveSelect(table).then(res, rej),
    };
    return node;
  }

  const db = {
    from(table: string) {
      return {
        insert(values: Record<string, unknown>) {
          insertCalls.push({ table, values });
          return {
            select: (_cols?: string) => ({
              single: async () => {
                const fn = cfg[table]?.insertResult;
                if (!fn) return { data: { id: `new-${table}-id`, ...values }, error: null };
                const r = fn(values);
                return r instanceof Promise ? await r : r;
              },
            }),
          };
        },
        update(values: Record<string, unknown>) {
          const filters: Record<string, unknown> = {};
          return {
            eq: async (col: string, val: unknown) => {
              filters[col] = val;
              updateCalls.push({ table, values, filters });
              return { error: null };
            },
          };
        },
        delete() {
          const filters: Record<string, unknown> = {};
          return {
            eq: async (col: string, val: unknown) => {
              filters[col] = val;
              deleteCalls.push({ table, filters });
              return { error: null };
            },
          };
        },
        select(_cols?: string) {
          return makeSelectNode(table);
        },
      };
    },
  };

  return { db: db as unknown as SupabaseClient, insertCalls, updateCalls, deleteCalls };
}

function createDeviceForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("floorId", "f1");
  fd.set("roomId", "");
  fd.set("deviceTypeId", "type-1");
  fd.set("code", "CAM01");
  fd.set("name", "Camera 1");
  fd.set("status", "planned");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function updateDeviceForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("id", "device-1");
  fd.set("floorId", "f1");
  fd.set("roomId", "");
  fd.set("deviceTypeId", "type-1");
  fd.set("code", "CAM01");
  fd.set("name", "Camera 1");
  fd.set("status", "planned");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createFloorDeviceAction", () => {
  it("derives site_id from the floor row — NEVER from caller-supplied FormData", async () => {
    const { db, insertCalls } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
      device_types: { selectResult: () => ({ data: { id: "type-1", category: "floor" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createFloorDeviceAction(createDeviceForm());

    expect(res.ok).toBe(true);
    expect(res.id).toBeTruthy(); // new id is returned so the place-then-detail flow can chain
    const deviceInsert = insertCalls.find((c) => c.table === "floor_devices");
    expect(deviceInsert?.values.site_id).toBe("SITE-A");
  });

  it("rejects a device type whose category is not 'floor', with no insert recorded", async () => {
    const { db, insertCalls } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
      device_types: { selectResult: () => ({ data: { id: "type-1", category: "rack" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createFloorDeviceAction(createDeviceForm());

    expect(res.ok).toBe(false);
    expect(insertCalls.find((c) => c.table === "floor_devices")).toBeUndefined();
  });

  it("maps a duplicate-key insert failure to a friendly device-specific message", async () => {
    const { db } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
      device_types: { selectResult: () => ({ data: { id: "type-1", category: "floor" }, error: null }) },
      floor_devices: {
        insertResult: () => ({ data: null, error: new Error("duplicate key value violates unique constraint") }),
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createFloorDeviceAction(createDeviceForm());

    expect(res).toEqual({ ok: false, error: "That device code is already used at this site" });
  });

  it("normalises the code before inserting", async () => {
    const { db, insertCalls } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
      device_types: { selectResult: () => ({ data: { id: "type-1", category: "floor" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createFloorDeviceAction(createDeviceForm({ code: "cam07" }));

    expect(res.ok).toBe(true);
    const deviceInsert = insertCalls.find((c) => c.table === "floor_devices");
    expect(deviceInsert?.values.code).toBe("CAM07");
  });

  it("rejects an invalid status before touching the db", async () => {
    const { db, insertCalls } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
      device_types: { selectResult: () => ({ data: { id: "type-1", category: "floor" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createFloorDeviceAction(createDeviceForm({ status: "broken" }));

    expect(res.ok).toBe(false);
    expect(insertCalls.find((c) => c.table === "floor_devices")).toBeUndefined();
  });
});

describe("updateFloorDeviceAction", () => {
  it("re-derives site_id from the NEW floor when moving to another floor", async () => {
    const { db, updateCalls } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f2", site_id: "SITE-B" }, error: null }) },
      device_types: { selectResult: () => ({ data: { id: "type-1", category: "floor" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await updateFloorDeviceAction(updateDeviceForm({ floorId: "f2" }));

    expect(res).toEqual({ ok: true });
    const deviceUpdate = updateCalls.find((c) => c.table === "floor_devices");
    expect(deviceUpdate?.values.floor_id).toBe("f2");
    expect(deviceUpdate?.values.site_id).toBe("SITE-B");
  });

  it("rejects a device type whose category is not 'floor', with no update recorded", async () => {
    const { db, updateCalls } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
      device_types: { selectResult: () => ({ data: { id: "t-rack", category: "rack" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await updateFloorDeviceAction(updateDeviceForm({ deviceTypeId: "t-rack" }));

    expect(res.ok).toBe(false);
    expect(updateCalls.find((c) => c.table === "floor_devices")).toBeUndefined();
  });
});

describe("deleteFloorDeviceAction", () => {
  it("deletes exactly one row, on table floor_devices, filtered by id", async () => {
    const { db, deleteCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await deleteFloorDeviceAction((() => {
      const fd = new FormData();
      fd.set("id", "device-9");
      return fd;
    })());

    expect(res).toEqual({ ok: true });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual({ table: "floor_devices", filters: { id: "device-9" } });
  });
});
