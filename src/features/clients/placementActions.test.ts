import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// DB-free by construction: no real Supabase client, no real cache invalidation.
// `createServiceClient` is swapped for a hand-rolled, TABLE-AWARE fake query builder (below) that
// records every update it receives — including which table and which filters were applied — so
// assertions can check real recorded arguments rather than just call counts.
//
// `isNorm`/`isValidPolygon` (from `@/features/clients/floorPlanOps`) are NOT mocked — they are pure
// functions, and mocking them would test nothing. The repository functions under test import them
// for real, so these tests exercise the real validation logic end-to-end.
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/server";
import {
  placeFloorDeviceAction,
  clearFloorDevicePlacementAction,
  placeRackAction,
  clearRackPlacementAction,
  setRoomPolygonAction,
  clearRoomPolygonAction,
} from "./actions";

type SelectResult = { data: unknown; error: Error | null } | Promise<never>;

interface TableConfig {
  selectResult?: () => SelectResult;
}

/** A minimal, TABLE-AWARE fake Supabase query builder covering the shapes
 *  locations/repository.ts uses for placement:
 *    update(obj).eq(col, val)   (awaited directly, no further chaining)
 *  `updateCalls` records the table name and the actual values/filters passed on every call, in
 *  call order, so tests can assert on real recorded arguments — e.g. that a placement update
 *  carries {x: 0, y: 0} rather than being dropped by a falsy check. */
function makeFakeDb(cfg: Record<string, TableConfig> = {}) {
  const updateCalls: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = [];

  async function resolveSelect(table: string) {
    const fn = cfg[table]?.selectResult;
    if (!fn) return { data: null, error: null };
    const r = fn();
    return r instanceof Promise ? await r : r;
  }

  function makeSelectNode(table: string) {
    const node: Record<string, unknown> = {
      eq: () => node,
      in: () => node,
      order: () => node,
      single: async () => resolveSelect(table),
      maybeSingle: async () => resolveSelect(table),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolveSelect(table).then(res, rej),
    };
    return node;
  }

  const db = {
    from(table: string) {
      return {
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
        select(_cols?: string) {
          return makeSelectNode(table);
        },
      };
    },
  };

  return { db: db as unknown as SupabaseClient, updateCalls };
}

function placeForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("id", "device-1");
  fd.set("x", "0.5");
  fd.set("y", "0.5");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function clearDeviceForm(id: string): FormData {
  const fd = new FormData();
  fd.set("id", id);
  return fd;
}

function polygonForm(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("roomId", "room-1");
  fd.set(
    "polygon",
    JSON.stringify([
      [0.1, 0.1],
      [0.5, 0.9],
      [0.9, 0.1],
    ])
  );
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

function clearRoomForm(roomId: string): FormData {
  const fd = new FormData();
  fd.set("roomId", roomId);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("placeFloorDeviceAction", () => {
  it("places at x=0, y=0 — the falsy-check tripwire: the update must carry {x: 0, y: 0}", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await placeFloorDeviceAction(placeForm({ x: "0", y: "0" }));

    expect(res).toEqual({ ok: true });
    const update = updateCalls.find((c) => c.table === "floor_devices");
    expect(update?.values).toEqual({ x: 0, y: 0 });
    expect(update?.filters).toEqual({ id: "device-1" });
  });

  it("rejects x=1.5 (outside 0..1), with no update recorded", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await placeFloorDeviceAction(placeForm({ x: "1.5", y: "0.5" }));

    expect(res.ok).toBe(false);
    expect(updateCalls.find((c) => c.table === "floor_devices")).toBeUndefined();
  });

  it("rejects a missing/non-numeric field (NaN) rather than placing a pin at NaN", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const fd = new FormData();
    fd.set("id", "device-1");
    fd.set("x", "0.5");
    // y omitted entirely

    const res = await placeFloorDeviceAction(fd);

    expect(res.ok).toBe(false);
    expect(updateCalls.find((c) => c.table === "floor_devices")).toBeUndefined();
  });
});

describe("clearFloorDevicePlacementAction", () => {
  it("nulls both x and y in one update", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await clearFloorDevicePlacementAction(clearDeviceForm("device-9"));

    expect(res).toEqual({ ok: true });
    const update = updateCalls.find((c) => c.table === "floor_devices");
    expect(update?.values).toEqual({ x: null, y: null });
    expect(update?.filters).toEqual({ id: "device-9" });
  });
});

describe("setRoomPolygonAction", () => {
  it("stores a valid triangle — the update carries the parsed array", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const polygon = [
      [0.1, 0.1],
      [0.5, 0.9],
      [0.9, 0.1],
    ];
    const res = await setRoomPolygonAction(polygonForm({ polygon: JSON.stringify(polygon) }));

    expect(res).toEqual({ ok: true });
    const update = updateCalls.find((c) => c.table === "rooms");
    expect(update?.values).toEqual({ plan_polygon: polygon });
    expect(update?.filters).toEqual({ id: "room-1" });
  });

  it("rejects a 2-vertex payload, with no update recorded", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const polygon = [
      [0.1, 0.1],
      [0.9, 0.9],
    ];
    const res = await setRoomPolygonAction(polygonForm({ polygon: JSON.stringify(polygon) }));

    expect(res.ok).toBe(false);
    expect(updateCalls.find((c) => c.table === "rooms")).toBeUndefined();
  });

  it("rejects malformed JSON — {ok:false}, no throw, no update", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await setRoomPolygonAction(polygonForm({ polygon: "{not valid json" }));

    expect(res.ok).toBe(false);
    expect(updateCalls.find((c) => c.table === "rooms")).toBeUndefined();
  });
});

describe("clearRoomPolygonAction", () => {
  it("nulls plan_polygon on the right roomId", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await clearRoomPolygonAction(clearRoomForm("room-77"));

    expect(res).toEqual({ ok: true });
    const update = updateCalls.find((c) => c.table === "rooms");
    expect(update?.values).toEqual({ plan_polygon: null });
    expect(update?.filters).toEqual({ id: "room-77" });
  });
});

describe("placeRackAction / clearRackPlacementAction", () => {
  it("places a rack at x=0, y=0 — the update carries {x: 0, y: 0} on the racks table", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);
    const res = await placeRackAction(placeForm({ id: "rack-1", x: "0", y: "0" }));
    expect(res).toEqual({ ok: true });
    const update = updateCalls.find((c) => c.table === "racks");
    expect(update?.values).toEqual({ x: 0, y: 0 });
    expect(update?.filters).toEqual({ id: "rack-1" });
  });

  it("rejects an out-of-range rack coordinate, with no update recorded", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);
    const res = await placeRackAction(placeForm({ id: "rack-1", x: "1.5", y: "0.5" }));
    expect(res.ok).toBe(false);
    expect(updateCalls.find((c) => c.table === "racks")).toBeUndefined();
  });

  it("clears a rack placement (nulls both x and y) without touching the rack itself", async () => {
    const { db, updateCalls } = makeFakeDb();
    vi.mocked(createServiceClient).mockReturnValue(db);
    const res = await clearRackPlacementAction(clearDeviceForm("rack-9"));
    expect(res).toEqual({ ok: true });
    const update = updateCalls.find((c) => c.table === "racks");
    expect(update?.values).toEqual({ x: null, y: null });
    expect(update?.filters).toEqual({ id: "rack-9" });
  });
});
