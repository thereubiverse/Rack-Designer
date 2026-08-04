import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// DB-free by construction: no real Supabase client, no real cache invalidation.
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/features/auth/withMember", () => ({
  // The guard is tested on its own in withMember.test.ts. Here it must be transparent, or every
  // action test would be re-testing the guard instead of the action.
  withMember: (fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
}));

import { createServiceClient } from "@/lib/supabase/server";
import { createRackInSiteAction } from "./actions";

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

/** Table-aware fake Supabase query builder that ACTUALLY applies `.eq`/`.is` filters against
 *  seeded rows, unlike the canned-response fakes used elsewhere in this codebase. That's the whole
 *  point here: the regression this test guards against (findOrCreateFloor matching an archived
 *  floor) can only be caught by a fake that really filters — a fake that just records the call and
 *  returns a fixed response would pass whether or not `.is("archived_at", null)` was ever added. */
function makeFakeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(
    Object.entries(seed).map(([table, rows]) => [table, [...rows]])
  );
  const insertCalls: Array<{ table: string; values: Row; row: Row }> = [];
  let nextId = 1;

  function makeSelectNode(table: string, filters: Filter[]): Record<string, unknown> {
    return {
      eq: (col: string, val: unknown) => makeSelectNode(table, [...filters, (r) => r[col] === val]),
      is: (col: string, val: unknown) => makeSelectNode(table, [...filters, (r) => (r[col] ?? null) === val]),
      maybeSingle: async () => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return { data: rows[0] ?? null, error: null };
      },
    };
  }

  const db = {
    from(table: string) {
      return {
        select: () => makeSelectNode(table, []),
        insert: (values: Row) => {
          const row: Row = { id: `${table}-${nextId++}`, ...values };
          insertCalls.push({ table, values, row });
          (tables[table] ??= []).push(row);
          return {
            select: () => ({
              single: async () => ({ data: row, error: null }),
            }),
          };
        },
      };
    },
  };

  return { db: db as unknown as SupabaseClient, insertCalls };
}

function createRackForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("siteId", "site-1");
  fd.set("floorCode", "GF");
  fd.set("roomCode", "MDF1");
  fd.set("roomType", "MDF");
  fd.set("rackCode", "RK1");
  fd.set("heightU", "42");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createRackInSiteAction — findOrCreateFloor must skip archived floors", () => {
  // Regression for the IMPORTANT finding: findOrCreateFloor used to match on site_id+code alone,
  // with no archived_at filter, so a new rack could attach to an archived (invisible) floor and
  // vanish. This seeds an archived floor with the exact code the form submits and asserts the
  // action creates a FRESH floor rather than reusing the archived one.
  it("does not attach the new rack to an archived floor sharing the same code", async () => {
    const { db, insertCalls } = makeFakeDb({
      floors: [{ id: "floor-archived", site_id: "site-1", code: "GF", archived_at: "2026-01-01T00:00:00Z" }],
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createRackInSiteAction(createRackForm());

    expect(res).toEqual({ ok: true });

    const floorInsert = insertCalls.find((c) => c.table === "floors");
    expect(floorInsert).toBeDefined();
    expect(floorInsert!.values).toMatchObject({ site_id: "site-1", code: "GF" });

    // The room (and therefore the rack) must hang off the NEWLY created floor, never the archived
    // one — that's the actual bug: a rack silently attached under a floor nobody can see again.
    const roomInsert = insertCalls.find((c) => c.table === "rooms");
    expect(roomInsert).toBeDefined();
    expect(roomInsert!.values.floor_id).toBe(floorInsert!.row.id);
    expect(roomInsert!.values.floor_id).not.toBe("floor-archived");

    expect(insertCalls.find((c) => c.table === "racks")).toBeDefined();
  });

  it("still reuses a LIVE floor with a matching code — the filter only excludes archived rows", async () => {
    const { db, insertCalls } = makeFakeDb({
      floors: [{ id: "floor-live", site_id: "site-1", code: "GF", archived_at: null }],
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await createRackInSiteAction(createRackForm());

    expect(res).toEqual({ ok: true });
    expect(insertCalls.find((c) => c.table === "floors")).toBeUndefined();

    const roomInsert = insertCalls.find((c) => c.table === "rooms");
    expect(roomInsert).toBeDefined();
    expect(roomInsert!.values.floor_id).toBe("floor-live");
  });
});
