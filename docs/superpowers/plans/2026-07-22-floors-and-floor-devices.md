# Floors & Floor Devices (Slice A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Floor-tabbed site page with explicit floor/room CRUD and a `floor_devices` inventory (cameras, APs, data drops…) — the foundation slice of the floor-plans programme.

**Architecture:** One new table (`floor_devices`, code unique per site via a deliberately denormalized `site_id`). Data access extends the existing `locations` repository; server actions follow the `{ok, error?}` house pattern; the site page becomes a floor tab bar whose active tab mirrors `?floor=`. Pure logic (code suggestion, room grouping) lives in a unit-tested ops module.

**Tech Stack:** Next.js 16 (app router, server components + server actions), TypeScript strict, Supabase (local via Docker), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-22-floors-and-floor-devices-design.md` — read §0 and §2 before starting.

## Global Constraints

- **NEVER run vitest against a directory or glob.** `*.integration.test.ts` files here delete rows wholesale and WILL wipe the developer's local database. Run tests by EXPLICIT FILENAME only.
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- No local `psql`. Use `docker exec supabase_db_network-doc-platform psql -U postgres -d postgres`.
- Every migration ends with the same THREE blanket grant statements `0001` carries (`grant usage on schema…; grant all privileges … to service_role; grant select, insert, update, delete … to anon, authenticated`). `0008` omitted them and everything failed; the sites-map plan's Task 1 SQL repeated the mistake and review had to fix it. Copy `0001`'s tail verbatim.
- Server actions return `{ ok: boolean; error?: string }` and never throw to the caller.
- Code lookups/writes use `normaliseCode` + exact `.eq`, never `.ilike` (LIKE metacharacters in URL segments were a real bug, PR #49 final review).
- `floor_devices.site_id` is NEVER accepted from a client — always derived server-side from the floor row.
- Run commands from the project root; the Bash tool's cwd resets between calls.
- Match `ClientDetail.tsx`/`SiteDetail.tsx` visual language: cards `rounded-2xl border border-neutral-200 bg-white shadow-sm`, primary button `h-9 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-[#376ad9]`, shared `input` class string.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Migration 0011 — floor_devices

**Files:**
- Create: `supabase/migrations/0011_floor_devices.sql`
- Modify: `src/lib/supabase/types.ts`

**Interfaces:**
- Produces: `FloorDeviceRow` in `types.ts`:

```ts
export interface FloorDeviceRow {
  id: string;
  site_id: string;
  floor_id: string;
  room_id: string | null;
  device_type_id: string;
  code: string;
  name: string;
  status: "planned" | "installed";
  created_at: string;
  updated_at: string;
}
```

- [ ] **Step 1: Write the migration**

```sql
-- Floor devices: the inventory of physical devices that live on a floor (cameras, APs, data
-- drops...). Spec slice A of the floor-plans programme. site_id is DELIBERATELY denormalized so
-- device codes can be unique per SITE (CAM01..CAM14 count across the whole building — it's what
-- goes on the physical label); the repository derives it from the floor row on every write.
-- room_id is optional (hallway cameras) and deleting a room orphans devices to floor level
-- rather than deleting them.
create table floor_devices (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references sites(id) on delete cascade,
  floor_id       uuid not null references floors(id) on delete cascade,
  room_id        uuid references rooms(id) on delete set null,
  device_type_id uuid not null references device_types(id) on delete restrict,
  code           text not null,
  name           text not null default '',
  status         text not null default 'planned' check (status in ('planned', 'installed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (site_id, code)
);

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

- [ ] **Step 2: Apply and verify**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0011_floor_devices.sql
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "\d floor_devices"
```

Expected: table exists; unique constraint on `(site_id, code)`; check constraint listing `planned`/`installed`; FKs as written (`room_id` → `SET NULL`, `floor_id` → `CASCADE`, `device_type_id` → `RESTRICT`).

- [ ] **Step 3: Add `FloorDeviceRow` (block above) to `src/lib/supabase/types.ts`, typecheck, commit**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
git add supabase/migrations/0011_floor_devices.sql src/lib/supabase/types.ts
git commit -m "feat(db): floor_devices inventory table"
```

Expected: tsc silent. `status` MUST be the literal union, not `string` — later tasks switch on it.

---

### Task 2: Pure floorDeviceOps (TDD)

**Files:**
- Create: `src/features/clients/floorDeviceOps.ts`, `src/features/clients/floorDeviceOps.test.ts`

**Interfaces:**
- Produces:
  - `suggestDeviceCode(typeCode: string, existingCodes: string[]): string`
  - `groupDevicesByRoom(rooms: RoomRow[], devices: FloorDeviceRow[]): { sections: { room: RoomRow; devices: FloorDeviceRow[] }[]; floorLevel: FloorDeviceRow[] }`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";
import { suggestDeviceCode, groupDevicesByRoom } from "./floorDeviceOps";

function device(over: Partial<FloorDeviceRow>): FloorDeviceRow {
  return {
    id: "d1", site_id: "s1", floor_id: "f1", room_id: null, device_type_id: "t1",
    code: "CAM01", name: "", status: "planned",
    created_at: "2026-01-01", updated_at: "2026-01-01", ...over,
  };
}
function room(over: Partial<RoomRow>): RoomRow {
  return { id: "r1", floor_id: "f1", code: "MDF", name: null, type: "MDF", created_at: "2026-01-01", ...over };
}

describe("suggestDeviceCode", () => {
  it("starts at 01 on an empty site", () => {
    expect(suggestDeviceCode("CAM", [])).toBe("CAM01");
  });
  it("fills the LOWEST gap, not max+1", () => {
    expect(suggestDeviceCode("CAM", ["CAM01", "CAM03"])).toBe("CAM02");
  });
  it("counts per type independently and ignores other types' codes", () => {
    expect(suggestDeviceCode("AP", ["CAM01", "CAM02", "AP01"])).toBe("AP02");
  });
  it("rolls over past two digits without colliding", () => {
    const taken = Array.from({ length: 99 }, (_, i) => `CAM${String(i + 1).padStart(2, "0")}`);
    expect(suggestDeviceCode("CAM", taken)).toBe("CAM100");
  });
  it("is not fooled by a type code that PREFIXES another (TO vs TOX)", () => {
    // TOX01 must not count as a TO code — the numeric suffix must be the WHOLE remainder.
    expect(suggestDeviceCode("TO", ["TOX01"])).toBe("TO01");
  });
});

describe("groupDevicesByRoom", () => {
  const mdf = room({ id: "r-mdf", code: "MDF" });
  const idf = room({ id: "r-idf", code: "IDF", type: "IDF" });
  it("puts each device under its room, rooms sorted by code, devices sorted by code", () => {
    const g = groupDevicesByRoom(
      [mdf, idf],
      [device({ id: "a", code: "CAM02", room_id: "r-mdf" }), device({ id: "b", code: "CAM01", room_id: "r-mdf" })]
    );
    expect(g.sections.map((s) => s.room.code)).toEqual(["IDF", "MDF"]);
    expect(g.sections[1].devices.map((d) => d.code)).toEqual(["CAM01", "CAM02"]);
  });
  it("keeps empty rooms as sections (a room exists even with no devices)", () => {
    const g = groupDevicesByRoom([mdf], []);
    expect(g.sections).toHaveLength(1);
    expect(g.sections[0].devices).toEqual([]);
  });
  it("collects roomless devices into floorLevel", () => {
    const g = groupDevicesByRoom([mdf], [device({ id: "a", room_id: null })]);
    expect(g.floorLevel.map((d) => d.id)).toEqual(["a"]);
  });
  it("NEVER silently drops a device whose room_id matches no known room", () => {
    // Defensive: status quo says this can't happen, but a device must never vanish from the page.
    const g = groupDevicesByRoom([mdf], [device({ id: "a", room_id: "r-gone" })]);
    expect(g.floorLevel.map((d) => d.id)).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/floorDeviceOps.test.ts
```

Expected: FAIL — cannot resolve `./floorDeviceOps`.

- [ ] **Step 3: Implement**

```ts
import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";

/** Next free label for a type at this site: lowest gap, 2-digit padded (CAM01), growing naturally
 *  past 99 (CAM100). The suffix must be the ENTIRE remainder after the type code, so TOX01 never
 *  counts as a TO code. */
export function suggestDeviceCode(typeCode: string, existingCodes: string[]): string {
  const taken = new Set<number>();
  const re = new RegExp(`^${typeCode}(\\d+)$`);
  for (const code of existingCodes) {
    const m = re.exec(code);
    if (m) taken.add(Number(m[1]));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `${typeCode}${String(n).padStart(2, "0")}`;
}

/** Room sections (sorted by room code, devices sorted by code inside) plus a floor-level bucket.
 *  A device whose room_id matches no known room lands in floorLevel — a device must NEVER
 *  silently vanish from the page, whatever the data says. */
export function groupDevicesByRoom(
  rooms: RoomRow[],
  devices: FloorDeviceRow[]
): { sections: { room: RoomRow; devices: FloorDeviceRow[] }[]; floorLevel: FloorDeviceRow[] } {
  const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
  const sections = [...rooms].sort(byCode).map((room) => ({
    room,
    devices: devices.filter((d) => d.room_id === room.id).sort(byCode),
  }));
  const known = new Set(rooms.map((r) => r.id));
  const floorLevel = devices.filter((d) => d.room_id === null || !known.has(d.room_id)).sort(byCode);
  return { sections, floorLevel };
}
```

- [ ] **Step 4: Run the tests (PASS), then commit**

```bash
npx vitest run src/features/clients/floorDeviceOps.test.ts
git add src/features/clients/floorDeviceOps.ts src/features/clients/floorDeviceOps.test.ts
git commit -m "feat(clients): pure device-code suggestion and room grouping"
```

---

### Task 3: Floors & rooms server layer

**Files:**
- Modify: `src/features/clients/validation.ts`, `src/features/locations/repository.ts`, `src/features/clients/actions.ts`, `src/features/clients/validation.test.ts`
- Create: `src/features/clients/floorActions.test.ts`

**Interfaces:**
- Consumes: existing `createFloor` / `createRoom` (locations repository), `normaliseCode`, `friendly` pattern in `clients/actions.ts`.
- Produces (repository): `listFloorsForSite(db, siteId): Promise<FloorRow[]>` (sort_order asc, code asc), `listRoomsForSite(db, siteId): Promise<RoomRow[]>`, `renameFloor(db, id, {code, name})`, `deleteFloor(db, id)`, `renameRoom(db, id, {code, name, type})`, `deleteRoom(db, id)`.
- Produces (actions): `createFloorAction`, `renameFloorAction`, `deleteFloorAction`, `createRoomAction`, `renameRoomAction`, `deleteRoomAction` — all `(formData) => Promise<{ok, error?}>`.
- Produces (validation): `CascadeCounts` gains `rooms?: number` (describeCascade renders "N rooms"; floor devices fold into the existing `devices` count — no new key); `validateCode` kind union widens to `"client" | "site" | "floor" | "room" | "device"`.
- **Deliberately NOT produced:** server-side cascade counters. Delete-gate counts are computed CLIENT-side from props in Task 7, exactly as today's rack delete does (`counts={{ devices: deleteTarget.deviceCount }}` in `SiteDetail.tsx`) — the page already loads every row the counts need, and a second server round-trip would just be a second source of truth to drift.

- [ ] **Step 1: Extend validation.ts (RED first via validation.test.ts additions)**

Add test cases to `validation.test.ts`: `describeCascade({ rooms: 2, racks: 1, devices: 3 })` → `"2 rooms, 1 rack and 3 devices"`; `describeCascade({ rooms: 1 })` → `"1 room"`; `validateCode("gf", "floor")` → null; `validateCode("", "device")` → `"Device code is required"`. Run `npx vitest run src/features/clients/validation.test.ts` → RED. Then implement:

```ts
export interface CascadeCounts { sites?: number; rooms?: number; racks?: number; devices?: number }
```

In `describeCascade`, add `add(counts.rooms, "room", "rooms")` between sites and racks. In `requiresTypedConfirm`, include `(counts.rooms ?? 0)`. Widen `validateCode`:

```ts
const CODE_LABEL = { client: "Client", site: "Site", floor: "Floor", room: "Room", device: "Device" } as const;
export function validateCode(raw: string, kind: keyof typeof CODE_LABEL): string | null {
  const label = CODE_LABEL[kind];
  const code = normaliseCode(raw);
  if (!code) return `${label} code is required`;
  if (!isValidCode(code)) return `${label} code can only use letters, numbers, - and _`;
  return null;
}
```

Run `npx vitest run src/features/clients/validation.test.ts` → GREEN. (Callers pass string literals, so the widened union compiles without touching them — confirm with tsc.)

- [ ] **Step 2: Repository functions (locations/repository.ts)**

```ts
export async function listFloorsForSite(db: SupabaseClient, siteId: string): Promise<FloorRow[]> {
  const { data, error } = await db.from("floors").select("*").eq("site_id", siteId)
    .order("sort_order", { ascending: true }).order("code", { ascending: true });
  if (error) throw new Error(`listFloorsForSite: ${error.message}`);
  return (data ?? []) as FloorRow[];
}

export async function listRoomsForSite(db: SupabaseClient, siteId: string): Promise<RoomRow[]> {
  const floors = await listFloorsForSite(db, siteId);
  if (floors.length === 0) return [];
  const { data, error } = await db.from("rooms").select("*")
    .in("floor_id", floors.map((f) => f.id)).order("code", { ascending: true });
  if (error) throw new Error(`listRoomsForSite: ${error.message}`);
  return (data ?? []) as RoomRow[];
}

export async function renameFloor(db: SupabaseClient, id: string, input: { code: string; name?: string | null }): Promise<void> {
  const { error } = await db.from("floors")
    .update({ code: normaliseCode(input.code), name: input.name ?? null }).eq("id", id);
  if (error) throw new Error(`renameFloor: ${error.message}`);
}

export async function deleteFloor(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("floors").delete().eq("id", id);
  if (error) throw new Error(`deleteFloor: ${error.message}`);
}

export async function renameRoom(db: SupabaseClient, id: string, input: { code: string; name?: string | null; type: RoomType }): Promise<void> {
  const { error } = await db.from("rooms")
    .update({ code: normaliseCode(input.code), name: input.name ?? null, type: input.type }).eq("id", id);
  if (error) throw new Error(`renameRoom: ${error.message}`);
}

export async function deleteRoom(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("rooms").delete().eq("id", id);
  if (error) throw new Error(`deleteRoom: ${error.message}`);
}
```

(`normaliseCode` and `CascadeCounts` are already imported/importable from `@/features/clients/validation`; `RoomType` from `@/domain/hierarchy`.)

- [ ] **Step 3: Server actions (clients/actions.ts)**

Widen `friendly` to `kind: "client" | "site" | "floor" | "room" | "device"` with duplicate-key messages: floor → `"That floor code is already used at this site"`, room → `"That room code is already used on this floor"`, device → `"That device code is already used at this site"`. Then, following the exact shape of `createSiteAction` (validate → `createServiceClient()` → try/catch repository call → `revalidatePath("/clients")` → `{ok: true}`), add the six actions:

- `createFloorAction`: fields `siteId`, `code`, `name`. `sortOrder` = `max(existing sort_order) + 1` via `listFloorsForSite` (0-based when no floors → `(floors.at(-1)?.sort_order ?? -1) + 1` is WRONG if sort orders aren't the max-last — compute `Math.max(-1, ...floors.map(f => f.sort_order)) + 1`). Calls existing `createFloor` with `code: normaliseCode(code)`.
- `renameFloorAction`: `id`, `code`, `name` → `renameFloor`.
- `deleteFloorAction`: `id` → `deleteFloor`.
- `createRoomAction`: `floorId`, `code`, `name`, `type` (validated against `ROOM_TYPES`, default `other`) → existing `createRoom` with normalised code.
- `renameRoomAction`: `id`, `code`, `name`, `type` → `renameRoom`.
- `deleteRoomAction`: `id` → `deleteRoom`.

Every action validates its code field with `validateCode(code, "floor" | "room")` first and returns the message on failure.

- [ ] **Step 4: DB-free action tests (floorActions.test.ts, RED then GREEN)**

New file, same construction as `actions.test.ts` (which mocks `@/lib/supabase/server` and `next/cache`, then hand-rolls a fake query builder that RECORDS arguments). Build the fake db TABLE-AWARE: `from(table)` returns a recording node; keep `insertCalls: Array<{table, values}>` and `updateCalls`/`deleteCalls` alike. Cover, asserting on REAL recorded arguments:

1. `createFloorAction` with floors `[{sort_order: 0}, {sort_order: 3}]` present → the recorded insert carries `sort_order: 4` (max+1, NOT length-based).
2. `createFloorAction` normalises: input code `"gf"` → recorded insert `code: "GF"`.
3. `createFloorAction` with a duplicate-key rejection from the fake db → `{ok: false, error: "That floor code is already used at this site"}`.
4. `createRoomAction` rejects an invalid `type` (e.g. `"closet"`) with `{ok: false}` and NO insert recorded.
5. `deleteRoomAction` → exactly one delete recorded, on table `rooms`, filter `id` = the FormData id (proves a room delete never touches `floor_devices` — the DB's SET NULL does the moving).
6. `renameFloorAction` code validation failure (`""`) → `{ok:false, error:"Floor code is required"}` and no update recorded.

Run: `npx vitest run src/features/clients/floorActions.test.ts` (RED first — actions missing; then GREEN).

- [ ] **Step 5: Typecheck, run the two named test files, commit**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
npx vitest run src/features/clients/validation.test.ts
npx vitest run src/features/clients/floorActions.test.ts
git add src/features/clients/validation.ts src/features/clients/validation.test.ts src/features/locations/repository.ts src/features/clients/actions.ts src/features/clients/floorActions.test.ts
git commit -m "feat(clients): floor and room CRUD server layer"
```

---

### Task 4: Floor devices server layer

**Files:**
- Modify: `src/features/locations/repository.ts`, `src/features/clients/actions.ts`
- Create: `src/features/clients/floorDeviceActions.test.ts`

**Interfaces:**
- Consumes: `FloorDeviceRow` (Task 1), widened `friendly`/`validateCode` (Task 3), `DeviceTypeRow` from `@/features/device-library/repository`.
- Produces (repository): `listFloorDevicesForSite(db, siteId): Promise<FloorDeviceRow[]>` (code asc), `createFloorDevice(db, input)`, `updateFloorDevice(db, id, patch)`, `deleteFloorDevice(db, id)`.
- Produces (actions): `createFloorDeviceAction`, `updateFloorDeviceAction`, `deleteFloorDeviceAction`.

- [ ] **Step 1: Repository functions**

```ts
export async function listFloorDevicesForSite(db: SupabaseClient, siteId: string): Promise<FloorDeviceRow[]> {
  const { data, error } = await db.from("floor_devices").select("*")
    .eq("site_id", siteId).order("code", { ascending: true });
  if (error) throw new Error(`listFloorDevicesForSite: ${error.message}`);
  return (data ?? []) as FloorDeviceRow[];
}

/** site_id is NEVER taken from the caller — it is derived from the floor row, so the site-scoped
 *  code uniqueness cannot be subverted and a device cannot be created against the wrong site.
 *  Only category='floor' types are accepted: rack-mounted gear lives in rack_devices. */
export async function createFloorDevice(
  db: SupabaseClient,
  input: { floorId: string; roomId?: string | null; deviceTypeId: string; code: string; name?: string; status: "planned" | "installed" }
): Promise<FloorDeviceRow> {
  const { data: floor, error: floorErr } = await db.from("floors").select("id, site_id").eq("id", input.floorId).single();
  if (floorErr || !floor) throw new Error(`createFloorDevice: floor not found`);
  const { data: type, error: typeErr } = await db.from("device_types").select("id, category").eq("id", input.deviceTypeId).single();
  if (typeErr || !type) throw new Error(`createFloorDevice: device type not found`);
  if ((type as { category: string }).category !== "floor") throw new Error(`createFloorDevice: only floor device types can be placed on a floor`);
  const { data, error } = await db.from("floor_devices").insert({
    site_id: (floor as { site_id: string }).site_id,
    floor_id: input.floorId,
    room_id: input.roomId ?? null,
    device_type_id: input.deviceTypeId,
    code: normaliseCode(input.code),
    name: input.name ?? "",
    status: input.status,
  }).select("*").single();
  if (error) throw new Error(`createFloorDevice: ${error.message}`);
  return data as FloorDeviceRow;
}

/** Moving to another floor re-derives site_id from the NEW floor (still same-site in the UI, but
 *  the invariant must hold regardless of what the caller passes). */
export async function updateFloorDevice(
  db: SupabaseClient,
  id: string,
  patch: { floorId?: string; roomId?: string | null; deviceTypeId?: string; code?: string; name?: string; status?: "planned" | "installed" }
): Promise<void> {
  const applied: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.floorId !== undefined) {
    const { data: floor, error } = await db.from("floors").select("id, site_id").eq("id", patch.floorId).single();
    if (error || !floor) throw new Error(`updateFloorDevice: floor not found`);
    applied.floor_id = patch.floorId;
    applied.site_id = (floor as { site_id: string }).site_id;
  }
  if (patch.deviceTypeId !== undefined) {
    const { data: type, error } = await db.from("device_types").select("id, category").eq("id", patch.deviceTypeId).single();
    if (error || !type) throw new Error(`updateFloorDevice: device type not found`);
    if ((type as { category: string }).category !== "floor") throw new Error(`updateFloorDevice: only floor device types can be placed on a floor`);
    applied.device_type_id = patch.deviceTypeId;
  }
  if (patch.roomId !== undefined) applied.room_id = patch.roomId;
  if (patch.code !== undefined) applied.code = normaliseCode(patch.code);
  if (patch.name !== undefined) applied.name = patch.name;
  if (patch.status !== undefined) applied.status = patch.status;
  const { error } = await db.from("floor_devices").update(applied).eq("id", id);
  if (error) throw new Error(`updateFloorDevice: ${error.message}`);
}

export async function deleteFloorDevice(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("floor_devices").delete().eq("id", id);
  if (error) throw new Error(`deleteFloorDevice: ${error.message}`);
}
```

- [ ] **Step 2: Actions** — same house shape. `createFloorDeviceAction` fields: `floorId`, `roomId` (empty string → null), `deviceTypeId`, `code`, `name`, `status` (validated against `["planned","installed"]`, default `planned`); `validateCode(code, "device")` first; catch → `friendly(e, "device")`. `updateFloorDeviceAction` fields: `id` + the same optional set (roomId always sent: empty string → null). `deleteFloorDeviceAction`: `id`.

- [ ] **Step 3: DB-free tests (floorDeviceActions.test.ts, RED then GREEN)** — same fake-db construction as Task 3. Cover, asserting recorded arguments:

1. **site_id derivation:** fake db returns floor `{id: "f1", site_id: "SITE-A"}`; `createFloorDeviceAction` with NO site anywhere in the FormData → recorded insert carries `site_id: "SITE-A"`.
2. **Category enforcement:** fake db returns type `{category: "rack"}` → `{ok: false}` and NO insert recorded.
3. **Duplicate code:** insert rejects with duplicate-key → error is exactly `"That device code is already used at this site"`.
4. **Normalisation:** code `"cam07"` → recorded insert `code: "CAM07"`.
5. **Move floor re-derives:** `updateFloorDeviceAction` with `floorId: "f2"` (fake floor `{site_id: "SITE-B"}`) → recorded update carries BOTH `floor_id: "f2"` and `site_id: "SITE-B"`.
6. **Status validation:** `status: "broken"` → `{ok: false}`, no insert.

Run: `npx vitest run src/features/clients/floorDeviceActions.test.ts`

- [ ] **Step 4: Typecheck, tests, commit**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
npx vitest run src/features/clients/floorDeviceActions.test.ts
git add src/features/locations/repository.ts src/features/clients/actions.ts src/features/clients/floorDeviceActions.test.ts
git commit -m "feat(clients): floor device CRUD with derived site scope"
```

---

### Task 5: DeleteDialog extension + FloorTabs (TDD)

**Files:**
- Modify: `src/features/clients/DeleteDialog.tsx`, `src/features/clients/DeleteDialog.test.tsx`
- Create: `src/features/clients/FloorTabs.tsx`, `src/features/clients/FloorTabs.test.tsx`

**Interfaces:**
- Produces: `DeleteDialog` accepts `kind: "client" | "site" | "rack" | "floor" | "room"` and a new optional `note?: string` rendered as its own muted line after the cascade sentence. `FloorTabs({ floors, activeCode, onSelect, onAdd }: { floors: FloorRow[]; activeCode: string; onSelect: (code: string) => void; onAdd: () => void })`.

Component markup is bounded by the contracts below (props, test ids, exact copy, behaviours) plus the styling reference (`ClientDetail.tsx` / existing `DeleteDialog`) — the same convention every UI task in this repo has used.

- [ ] **Step 1: DeleteDialog — failing tests first.** Add to `DeleteDialog.test.tsx`: (a) `kind="floor"` renders heading `Delete floor "GF"?`; (b) `note="2 devices will move to floor level"` renders that text; (c) with `counts={{}}` and a `note`, the dialog still shows the note (a room whose only contents are devices must still explain the move). Run `npx vitest run src/features/clients/DeleteDialog.test.tsx` → RED. Implement: extend `KIND_LABEL` with `floor: "floor"`, `room: "room"`; render `note` under the cascade sentence in `text-sm text-neutral-500` when present. GREEN.

- [ ] **Step 2: FloorTabs — failing tests first.** `FloorTabs.test.tsx` covers: (a) renders one tab per floor **in the given order** (the repository already sorts by `sort_order`; the component must NOT re-sort — assert with floors deliberately not code-alphabetical); (b) the tab matching `activeCode` carries `aria-current="page"`; (c) clicking a NON-active tab calls `onSelect` with THAT floor's code (render 3+, click the third — a component that always reported the first would pass a weaker test); (d) the `+ Add floor` button (`data-testid="add-floor"`) calls `onAdd`; (e) each tab shows `code` plus `name` when non-null (`GF — Ground` style, exact separator up to the implementer). RED → implement (tab bar visual language: active tab `text-blue-700 border-b-2 border-blue-600 font-semibold`, inactive `text-neutral-500 hover:text-neutral-900`) → GREEN.

- [ ] **Step 3: Run both named files, typecheck, commit**

```bash
npx vitest run src/features/clients/DeleteDialog.test.tsx
npx vitest run src/features/clients/FloorTabs.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
git add src/features/clients/DeleteDialog.tsx src/features/clients/DeleteDialog.test.tsx src/features/clients/FloorTabs.tsx src/features/clients/FloorTabs.test.tsx
git commit -m "feat(clients): floor tab bar; DeleteDialog learns floors, rooms and notes"
```

---

### Task 6: FloorDevicesPanel (TDD)

**Files:**
- Create: `src/features/clients/FloorDevicesPanel.tsx`, `src/features/clients/FloorDevicesPanel.test.tsx`

**Interfaces:**
- Consumes: `groupDevicesByRoom`, `suggestDeviceCode` (Task 2); `createRoomAction`, `renameRoomAction`, `deleteRoomAction` (Task 3); `createFloorDeviceAction`, `updateFloorDeviceAction`, `deleteFloorDeviceAction` (Task 4); `DeleteDialog` with `note` (Task 5); `DeviceTypeRow`.
- Produces: `FloorDevicesPanel({ floor, rooms, devices, deviceTypes, allSiteDeviceCodes }: { floor: FloorRow; rooms: RoomRow[]; devices: FloorDeviceRow[]; deviceTypes: DeviceTypeRow[]; allSiteDeviceCodes: string[] })` — `"use client"`; rooms/devices are already filtered to this floor by the caller; `allSiteDeviceCodes` spans the whole site (code suggestion is site-scoped); `deviceTypes` is pre-filtered to `category === "floor"` by the caller.

Contract (markup bounded by it plus `ClientDetail.tsx` styling):

- One card per room section: header `{code}` + name + type chip (`MDF`/`IDF` chips `bg-blue-50 text-blue-700`, `other` no chip) + `Rename` / `Delete` room buttons (`data-testid={"room-rename-"+room.code}` / `"room-delete-"+room.code`). Devices table inside: columns Code · Type · Name · Status · Actions. Status chip: `planned` → `bg-neutral-100 text-neutral-600`, `installed` → `bg-green-50 text-green-700`, `data-testid={"device-status-"+device.code}`.
- A final **"Floor level"** card, rendered ONLY when the floor-level bucket is non-empty.
- `+ Add room` (`data-testid="add-room"`) and `+ Add device` (`data-testid="add-device"`) buttons in the panel header.
- Add/edit device modal: type `<select name="deviceTypeId">` (floor types), code `<input name="code">` pre-filled from `suggestDeviceCode(selectedType.code, allSiteDeviceCodes)` and re-suggested when the type changes (but NEVER overwriting a code the user has edited — track a `codeTouched` flag), name, room `<select name="roomId">` with `""` = "Floor level", status select. Submits the matching action, `router.refresh()` on ok, renders `error` inline on failure (house pattern from `SiteDetail`'s `handleCreate`).
- Room delete uses `DeleteDialog` with `counts={{ racks }}` and `note` = `"N devices will move to floor level"` when `movedDevices > 0` — count values arrive via a `getRoomCascade` prop? NO — keep it simple and honest: the panel receives `rackCountByRoomId: Record<string, number>` from the caller (derived from the racks the page already loads) and computes moved devices from its own `devices` prop. No new data fetch.
- Add room modal: code, name, type select (ROOM_TYPES), submitting `createRoomAction` with this floor's id.

- [ ] **Step 1: Failing tests.** Cover: devices group under the right room cards; the Floor-level card is ABSENT when no roomless devices exist and present when they do; status chips render the right classes for both statuses; add-device modal pre-fills the suggested code and RE-suggests on type change but keeps a user-edited code; submitting add-device calls `createFloorDeviceAction` with THIS floor's id and the chosen roomId (assert real FormData values; include a multi-room case where a NON-first room is chosen); room delete passes `note` mentioning the device count and does NOT list devices in `counts`; `deleteFloorDeviceAction` fires with the right device id when a NON-first device row's delete is clicked. All actions mocked with `vi.mock`; no DB, no network.
- [ ] **Step 2: Run `npx vitest run src/features/clients/FloorDevicesPanel.test.tsx` → RED.**
- [ ] **Step 3: Implement to the contract. GREEN.**
- [ ] **Step 4: Typecheck + commit**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
git add src/features/clients/FloorDevicesPanel.tsx src/features/clients/FloorDevicesPanel.test.tsx
git commit -m "feat(clients): per-floor rooms and device inventory panel"
```

---

### Task 7: Site page composition + browser verification

**Files:**
- Modify: `src/app/clients/[clientCode]/[siteCode]/page.tsx`, `src/features/clients/SiteDetail.tsx`, `src/features/clients/SiteDetail.test.tsx`

**Interfaces:**
- Consumes: everything above. `SiteDetail` props become `{ client, site, racks, floors, rooms, devices, deviceTypes }` (rooms/devices site-wide; SiteDetail slices per active floor).

- [ ] **Step 1: Page loader.** `page.tsx` additionally loads `listFloorsForSite`, `listRoomsForSite`, `listFloorDevicesForSite` (all from `@/features/locations/repository`) and `listDeviceTypes` (from `@/features/device-library/repository`), passes `deviceTypes.filter((t) => t.category === "floor")`.

- [ ] **Step 2: SiteDetail rework.** Keep: breadcrumb, `+ Add rack` flow, rack groups, rack DeleteDialog. Add:
  - `FloorTabs` under the heading. Active floor: `useSearchParams().get("floor")` normalised via `normaliseCode`; no match or no param → first floor. Tab click → `router.replace(pathname + "?floor=" + encodeURIComponent(code), { scroll: false })`.
  - Below the tabs: `FloorDevicesPanel` for the active floor (rooms/devices filtered by `floor_id`; `allSiteDeviceCodes` = all devices' codes site-wide; `rackCountByRoomId` derived from `racks` — `SiteRackRow` carries `roomCode` + `floorCode`, not roomId, so match rooms by (floor, code): build the map with the active floor's rooms and `racks.filter(r => r.floorCode === activeFloor.code)`).
  - Rack groups filtered to the active floor (`groupRacks(racks.filter(r => r.floorCode === activeFloor.code))`).
  - Floor management: `+ Add floor` (from FloorTabs `onAdd`) opens a modal (code, name) → `createFloorAction(siteId,…)`; `Rename floor` / `Delete floor` controls beside the panel header; floor delete uses `DeleteDialog kind="floor"` with counts computed CLIENT-side from props (rooms on floor, racks on floor via `floorCode`, devices = this floor's floor devices + the summed `SiteRackRow.deviceCount` of its racks) — the same props-based counting today's rack delete already uses.
  - **No floors:** empty state card "No floors yet" + `+ Add floor` button; the rack section renders nothing extra.
  - **Deep link degradation:** `?floor=NOPE` falls back to the first floor — never 404.
  - **`useSearchParams` note:** the page is already `dynamic = "force-dynamic"`, so the client component may call `useSearchParams` without a Suspense boundary; no static prerender exists to bail out of.

- [ ] **Step 3: Extend SiteDetail.test.tsx.** Update the fixture for the new props (floors/rooms/devices/deviceTypes). Cover: tabs render and the FIRST floor's panel shows by default; `?floor=` (mock `useSearchParams`) selects that floor and its devices; unknown `?floor=` falls back to the first floor; racks shown are only the active floor's; the no-floors empty state renders with the add button; existing rack tests still pass unweakened.

- [ ] **Step 4: Run named tests + typecheck**

```bash
npx vitest run src/features/clients/SiteDetail.test.tsx
npx vitest run src/features/clients/FloorDevicesPanel.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
```

- [ ] **Step 5: Browser verification (controller-driven; use the preview tooling, never `npm run dev` in a shell)**
  1. `/clients/uri/hq` (or any URI site) — starts with no floors → empty state, add floor `GF`.
  2. Add rooms `MDF` (type MDF) and `101` (other); add devices: `CAM01` in 101, `TO01` at floor level; verify grouping, status chips, floor-level section.
  3. Add a second floor `1F`; switch tabs; confirm `?floor=1F` lands in the URL and deep-links after reload; `?floor=NOPE` falls back to GF.
  4. Add device on 1F of the same type → code suggests `CAM02` (site-scoped, proving cross-floor counting).
  5. Delete room `101` → dialog says the device count MOVES ("1 device will move to floor level"), racks count only; confirm CAM01 appears under Floor level afterwards (the SET NULL proven live).
  6. Existing rack flows: add a rack on GF via the untouched modal; rack appears only under GF's tab.
  7. `select site_id, code, status from floor_devices order by code;` via docker psql — codes uppercase, site_id consistent.

- [ ] **Step 6: Commit**

```bash
git add src/app/clients/[clientCode]/[siteCode]/page.tsx src/features/clients/SiteDetail.tsx src/features/clients/SiteDetail.test.tsx
git commit -m "feat(clients): floor-tabbed site page with rooms and device inventory"
```

---

## Self-Review

**Spec coverage:** §2 schema → Task 1. §3 codes (suggestion, normalisation, exact-match) → Tasks 2, 4. §4 page behaviour: tabs/deep-link/empty states → Tasks 5, 7; rooms sections/device rows/modals → Task 6; delete gates with move-not-delete copy → Tasks 3, 5, 6. §5 server layer → Tasks 3, 4. §6 files → all tasks. §7 testing → every task carries its own named-file cycle. Spec §9's open question (status toggle placement) resolved: modal-only, YAGNI.

**Placeholder scan:** no TBD/TODO. Tasks 5–7 bound component markup by contract (props, test ids, exact copy, behaviours, styling reference) rather than full JSX — the stated convention of every prior UI plan in this repo (clients-directory, sites-map), called out to reviewers in the task briefs.

**Type consistency:** `FloorDeviceRow.status` union (Task 1) flows through `createFloorDevice`/`updateFloorDevice` (Task 4) and the status-chip contract (Task 6). `CascadeCounts.rooms` (Task 3) feeds the `DeleteDialog` floor copy (Tasks 5, 7). `FloorTabs` props (Task 5) match SiteDetail's usage (Task 7). `groupDevicesByRoom`'s `{sections, floorLevel}` shape (Task 2) matches Task 6's card contract. `suggestDeviceCode(typeCode, existingCodes)` (Task 2) called with `DeviceTypeRow.code` + `allSiteDeviceCodes` (Task 6).

**Design note recorded for reviewers:** delete-gate counts are client-side from props throughout, matching the existing rack delete. No server-side cascade counters exist in this slice — a reviewer finding one should treat it as scope creep.
