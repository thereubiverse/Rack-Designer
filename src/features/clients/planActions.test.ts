import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// DB-free by construction: no real Supabase client, no real cache invalidation, and — because this
// slice writes to Supabase Storage as well as the DB — no real storage calls either. `./planStorage`
// is swapped for plain vi.fn()s so the fake db below never has to model storage at all; it only
// ever sees the `floors` / `floor_plans` / `floor_devices` / `rooms` tables.
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./planStorage", () => ({
  uploadPlanObject: vi.fn(),
  createPlanSignedUrl: vi.fn(),
  removePlanObject: vi.fn(),
}));

import { createServiceClient } from "@/lib/supabase/server";
import { uploadPlanObject, removePlanObject } from "./planStorage";
import { uploadFloorPlanAction, deleteFloorPlanAction } from "./actions";

type SelectResult = { data: unknown; error: Error | null } | Promise<never>;
type UpsertResult = { data: unknown; error: Error | null } | Promise<never>;

interface TableConfig {
  selectResult?: () => SelectResult;
  upsertResult?: (values: Record<string, unknown>) => UpsertResult;
}

/** A minimal, TABLE-AWARE fake Supabase query builder covering the shapes
 *  locations/repository.ts uses for floor plans:
 *    select(cols).eq(col, val).single()                        (floor lookup, floor-exists check)
 *    select(cols).eq(col, val).maybeSingle()                    (getFloorPlan)
 *    upsert(obj, opts).select(cols).single()                    (upsertFloorPlan)
 *    update(obj).eq(col, val)                                    (awaited directly)
 *    delete().eq(col, val)                                       (awaited directly)
 *  `upsertCalls`/`updateCalls`/`deleteCalls` record the table name and the actual
 *  values/filters/opts passed on every call, in call order, so tests can assert on real recorded
 *  arguments rather than just call counts. Storage never appears here — planStorage is mocked
 *  separately above, so this fake db never sees a single storage call. */
function makeFakeDb(cfg: Record<string, TableConfig> = {}) {
  const upsertCalls: Array<{ table: string; values: Record<string, unknown>; opts: unknown }> = [];
  const updateCalls: Array<{ table: string; values: Record<string, unknown>; filters: Record<string, unknown> }> = [];
  const deleteCalls: Array<{ table: string; filters: Record<string, unknown> }> = [];

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
        upsert(values: Record<string, unknown>, opts?: unknown) {
          upsertCalls.push({ table, values, opts });
          return {
            select: (_cols?: string) => ({
              single: async () => {
                const fn = cfg[table]?.upsertResult;
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

  return { db: db as unknown as SupabaseClient, upsertCalls, updateCalls, deleteCalls };
}

// A real PNG header whose IHDR says 640x480 — used to prove decoded dimensions (not
// FormData-supplied ones) are what land in the upsert.
const PNG_640x480_HEX =
  "89504e470d0a1a0a0000000d4948445200000280000001e008060000001f15c489";
// Not a PNG at all.
const NOT_PNG_HEX = "6e6f742061207265616c20706e67";

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

// A minimal Blob-like fixture — NOT jsdom's `File`/`Blob`, which don't implement `arrayBuffer()`
// in this test environment. The action under test duck-types on `.size`/`.arrayBuffer()` (see
// `isBlobLike` in actions.ts) precisely so it doesn't care which Blob/File constructor produced
// the value — real Fetch API Blob in production, this fixture in tests.
function makeBlobLike(bytes: Uint8Array, name = "plan.png", sizeOverride?: number) {
  return {
    name,
    size: sizeOverride ?? bytes.length,
    arrayBuffer: async () => bytes.buffer,
  };
}

// A fake FormData: real jsdom FormData coerces any non-Blob/File `.set()` value to a string, which
// would destroy the Blob-like fixture above. Since uploadFloorPlanAction only ever calls
// `formData.get(key)`, a plain Map-backed stand-in is sufficient and keeps the fixture intact.
function makeFakeFormData(fields: Record<string, unknown>): FormData {
  const map = new Map(Object.entries(fields));
  return { get: (key: string) => map.get(key) ?? null } as unknown as FormData;
}

function uploadForm(
  overrides: { floorId?: string; file?: unknown; source?: string; extra?: Record<string, string> } = {}
): FormData {
  return makeFakeFormData({
    floorId: overrides.floorId ?? "f1",
    file: overrides.file ?? makeBlobLike(hexToBytes(PNG_640x480_HEX)),
    source: overrides.source ?? "image",
    ...(overrides.extra ?? {}),
  });
}

function deleteForm(floorId: string): FormData {
  const fd = new FormData();
  fd.set("floorId", floorId);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(uploadPlanObject).mockResolvedValue(undefined);
  vi.mocked(removePlanObject).mockResolvedValue(undefined);
});

describe("uploadFloorPlanAction", () => {
  it("uploads decoded dimensions to a site-derived path, ignoring misleading client-supplied width/height", async () => {
    const { db, upsertCalls } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    // The client lies about the dimensions — the server must ignore this entirely and decode the
    // real bytes instead.
    const res = await uploadFloorPlanAction(
      uploadForm({ extra: { width: "9999", height: "9999" } })
    );

    expect(res).toEqual({ ok: true });

    expect(uploadPlanObject).toHaveBeenCalledTimes(1);
    const [calledDb, calledPath, calledBytes] = vi.mocked(uploadPlanObject).mock.calls[0];
    expect(calledDb).toBe(db);
    expect(calledPath).toBe("SITE-A/f1.png");
    expect(calledBytes).toEqual(hexToBytes(PNG_640x480_HEX));

    const planUpsert = upsertCalls.find((c) => c.table === "floor_plans");
    expect(planUpsert?.values).toMatchObject({
      floor_id: "f1",
      storage_path: "SITE-A/f1.png",
      width_px: 640,
      height_px: 480,
      source: "image",
    });
  });

  it("rejects non-PNG bytes before any storage write", async () => {
    const { db } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await uploadFloorPlanAction(
      uploadForm({ file: makeBlobLike(hexToBytes(NOT_PNG_HEX)) })
    );

    expect(res.ok).toBe(false);
    expect(uploadPlanObject).not.toHaveBeenCalled();
  });

  it("rejects a file over 15MB before any storage write", async () => {
    const { db } = makeFakeDb({
      floors: { selectResult: () => ({ data: { id: "f1", site_id: "SITE-A" }, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    // Stub `.size` at 16MB without allocating a real 16MB buffer.
    const oversized = makeBlobLike(new Uint8Array(0), "plan.png", 16 * 1024 * 1024);
    const res = await uploadFloorPlanAction(uploadForm({ file: oversized }));

    expect(res.ok).toBe(false);
    expect(uploadPlanObject).not.toHaveBeenCalled();
  });

  it("rejects an upload against an unknown floor, before any storage write", async () => {
    const { db } = makeFakeDb({
      floors: { selectResult: () => ({ data: null, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await uploadFloorPlanAction(uploadForm({ floorId: "no-such-floor" }));

    expect(res.ok).toBe(false);
    expect(uploadPlanObject).not.toHaveBeenCalled();
  });
});

describe("deleteFloorPlanAction", () => {
  it("still clears the row and both placement fields even when the storage object is missing", async () => {
    const { db, deleteCalls, updateCalls } = makeFakeDb({
      floor_plans: {
        selectResult: () => ({
          data: {
            id: "plan-1",
            floor_id: "f1",
            storage_path: "SITE-A/f1.png",
            width_px: 640,
            height_px: 480,
            original_filename: "plan.png",
            source: "image",
            created_at: "",
            updated_at: "",
          },
          error: null,
        }),
      },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);
    vi.mocked(removePlanObject).mockRejectedValue(new Error("Object not found"));

    const res = await deleteFloorPlanAction(deleteForm("f1"));

    expect(res).toEqual({ ok: true });
    expect(removePlanObject).toHaveBeenCalledWith(db, "SITE-A/f1.png");

    expect(deleteCalls.find((c) => c.table === "floor_plans")).toEqual({ table: "floor_plans", filters: { floor_id: "f1" } });
    const deviceUpdate = updateCalls.find((c) => c.table === "floor_devices");
    expect(deviceUpdate?.values).toEqual({ x: null, y: null });
    const roomUpdate = updateCalls.find((c) => c.table === "rooms");
    expect(roomUpdate?.values).toEqual({ plan_polygon: null });
  });

  it("carries the same floorId filter through all three clearing writes", async () => {
    const { db, deleteCalls, updateCalls } = makeFakeDb({
      floor_plans: { selectResult: () => ({ data: null, error: null }) },
    });
    vi.mocked(createServiceClient).mockReturnValue(db);

    const res = await deleteFloorPlanAction(deleteForm("floor-77"));

    expect(res).toEqual({ ok: true });
    expect(removePlanObject).not.toHaveBeenCalled();

    expect(deleteCalls.find((c) => c.table === "floor_plans")?.filters).toEqual({ floor_id: "floor-77" });
    expect(updateCalls.find((c) => c.table === "floor_devices")?.filters).toEqual({ floor_id: "floor-77" });
    expect(updateCalls.find((c) => c.table === "rooms")?.filters).toEqual({ floor_id: "floor-77" });
  });
});
