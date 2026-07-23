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
  createFloorAction,
  renameFloorAction,
  deleteFloorAction,
  createRoomAction,
  renameRoomAction,
  deleteRoomAction,
} from "./actions";

type SelectResult = { data: unknown; error: Error | null } | Promise<never>;
type InsertResult = { data: unknown; error: Error | null } | Promise<never>;

interface TableConfig {
  selectResult?: () => SelectResult;
  insertResult?: (values: Record<string, unknown>) => InsertResult;
}

/** A minimal, TABLE-AWARE fake Supabase query builder covering exactly the shapes
 *  locations/repository.ts and clients/actions.ts use for floors/rooms:
 *    insert(obj).select(cols).single()
 *    select(cols).eq(col, val).order(...).order(...)   (listFloorsForSite)
 *    select(cols).in(col, vals).order(...)             (listRoomsForSite)
 *    update(obj).eq(col, val)                          (awaited directly, no further chaining)
 *    delete().eq(col, val)                              (awaited directly, no further chaining)
 *  `insertCalls`/`updateCalls`/`deleteCalls` record the table name and the actual
 *  values/filters passed on every call, in call order, so tests can assert on real recorded
 *  arguments — e.g. that a room delete only ever touches table "rooms". */
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

function createFloorForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("siteId", "site-1");
  fd.set("code", "L1");
  fd.set("name", "Level 1");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function renameFloorForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("id", "floor-1");
  fd.set("code", "L1");
  fd.set("name", "Level 1");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function deleteRoomForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("id", "room-1");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function createRoomForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("floorId", "floor-1");
  fd.set("code", "MDF1");
  fd.set("name", "Main Distribution");
  fd.set("type", "MDF");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createFloorAction", () => {
  it("computes sort_order as max(existing) + 1, NOT a length-based or last-element computation", async () => {
    const { db, insertCalls } = makeFakeDb({
      floors: {
        selectResult: () => ({
          data: [
            { id: "f1", site_id: "site-1", code: "A", name: null, sort_order: 0, created_at: "" },
            { id: "f2", site_id: "site-1", code: "B", name: null, sort_order: 3, created_at: "" },
          ],
          error: null,
        }),
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createFloorAction(createFloorForm());

    expect(res).toEqual({ ok: true });
    const floorInsert = insertCalls.find((c) => c.table === "floors");
    expect(floorInsert?.values.sort_order).toBe(4);
  });

  it("normalises the code before inserting", async () => {
    const { db, insertCalls } = makeFakeDb({
      floors: { selectResult: () => ({ data: [], error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createFloorAction(createFloorForm({ code: "gf" }));

    expect(res).toEqual({ ok: true });
    const floorInsert = insertCalls.find((c) => c.table === "floors");
    expect(floorInsert?.values.code).toBe("GF");
  });

  it("maps a duplicate-key insert failure to a friendly floor-specific message", async () => {
    const { db } = makeFakeDb({
      floors: {
        selectResult: () => ({ data: [], error: null }),
        insertResult: () => ({ data: null, error: new Error("duplicate key value violates unique constraint") }),
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createFloorAction(createFloorForm());

    expect(res).toEqual({ ok: false, error: "That floor code is already used at this site" });
  });
});

describe("createRoomAction", () => {
  it("rejects an invalid room type before touching the db", async () => {
    const { db, insertCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createRoomAction(createRoomForm({ type: "closet" }));

    expect(res.ok).toBe(false);
    expect(insertCalls).toHaveLength(0);
  });
});

describe("deleteRoomAction", () => {
  it("deletes exactly one row, on table rooms, filtered by id — proves a room delete never touches floor_devices", async () => {
    const { db, deleteCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await deleteRoomAction(deleteRoomForm({ id: "room-9" }));

    expect(res).toEqual({ ok: true });
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toEqual({ table: "rooms", filters: { id: "room-9" } });
  });
});

describe("renameFloorAction", () => {
  it("rejects an empty code before touching the db", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await renameFloorAction(renameFloorForm({ code: "" }));

    expect(res).toEqual({ ok: false, error: "Floor code is required" });
    expect(updateCalls).toHaveLength(0);
  });
});
