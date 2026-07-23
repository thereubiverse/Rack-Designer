# Floors & Floor Devices (Slice A) — Design

**Status:** design agreed 2026-07-22; NOT yet planned or built.
**Build this in a fresh session:** run `superpowers:writing-plans` against this spec, then
`superpowers:subagent-driven-development`.

**Goal:** A site page organised by floor: add/edit floors and rooms explicitly, and keep an
inventory of floor devices (cameras, APs, data drops…) placed on floors and in rooms — before any
floor plan or AI exists.

---

## 0. Where this sits — the four-slice roadmap

This is **Slice A** of the floor-plans programme, decomposed and agreed 2026-07-22:

| Slice | Delivers | Depends on |
|---|---|---|
| **A (this spec)** | Floor tabs on the site page; floor/room CRUD; `floor_devices` inventory | nothing |
| B | Floor plan image upload + manual mapping editor (place rooms/devices on the plan) | A |
| C | AI discovery: Gemini reads the plan, proposes rooms/names/drops/cameras/stairs; user adjusts in B's editor | A, B |
| D | Port linkage: `port_endpoints` reference floor devices; room/device picker in port settings; migrate `described` endpoints | A |

Two decisions taken here bind the later slices:

1. **Unified inventory.** `floor_devices` is THE record of a physical floor device. In Slice D,
   patching a port to a device becomes a *reference* to a `floor_devices` row, and today's
   port-attached `described` endpoints (type + free-text name, no location) migrate into it.
   A device exists whether or not it is patched — which Slice C requires, since a plan scan
   discovers devices before any cabling exists.
2. **A must not paint B/C into a corner.** The floor tab pane is full-width so B's plan canvas
   drops into it without a page redesign; the schema gains coordinates in B's migration, not now.

## 1. Decisions taken

| Decision | Choice |
|---|---|
| Device identity | One `floor_devices` table; ports will reference it (Slice D) |
| Device code scope | **Unique per site** (`CAM01…` counts across floors — it's what goes on the physical label) |
| Room membership | Optional — hallway cameras and stairwell APs have no room; deleting a room orphans devices to floor level |
| Fields | Type, code, name, status (`planned`/`installed`) only. No notes, no photo (deferred; photo would drag in Slice B's storage) |
| Site page shape | **Floor tabs** (`GF · 1F · + Add floor`), active floor in the URL query — deep-linkable, and each tab is a full-width pane for B's canvas |
| Connections by floor | **Deferred to Slice D** — needs the port↔device link. In A a device shows status, not patching |

## 2. Schema — migration `0011_floor_devices.sql`

```sql
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
```

- **`site_id` is deliberately denormalized** so the code-uniqueness constraint can be site-scoped.
  The repository derives `site_id` from the floor row server-side on every insert/move — it never
  trusts a client-supplied `site_id`, so the two cannot disagree.
- **`on delete set null` for `room_id`**: deleting a room must not delete its devices — they fall
  back to floor level and stay visible. Deleting a floor or site does cascade.
- **`device_type_id` must be a `category = 'floor'` type.** A FK cannot check a column on the
  referenced row; the repository enforces it (reject non-floor types with a friendly error).
  Rack-mounted gear stays in `rack_devices`.
- **Grants:** the migration ends with the same THREE blanket grant statements every other
  migration carries (grant usage on schema; grant all privileges to service_role; grant
  select/insert/update/delete to anon, authenticated). `0008` omitted them and every query failed
  until `0009`; the sites-map plan's own Task 1 SQL repeated the mistake and was caught in review.
  Copy the tail of `0001` verbatim.

`SiteRow`-style typing: add `FloorDeviceRow` to `src/lib/supabase/types.ts` with `status` typed as
the literal union `"planned" | "installed"`, not bare `string`.

## 3. Device codes

- Uppercase alphanumeric, 1–8 chars, normalised via the existing `normaliseCode`. Lookups use
  exact `.eq` on the normalised code, never `.ilike` (the clients-directory final review found the
  wildcard bug; do not reintroduce it).
- **Auto-suggestion:** the add-device modal pre-fills the next free code for the chosen type at
  this site: type code + zero-padded 2-digit number (`CAM01`, `CAM02`; `CAM100` after `CAM99`).
  Suggestion fills the lowest gap (`CAM02` if `CAM01`/`CAM03` exist) — pure function, unit-tested.
  The suggestion is editable; uniqueness is enforced by the DB constraint and surfaced as
  "That device code is already used at this site".

## 4. Site page behaviour

`/clients/[clientCode]/[siteCode]` becomes floor-tabbed:

- **Tab bar:** one tab per floor ordered by `sort_order`, then `+ Add floor`. Active tab mirrors
  to `?floor=GF` (deep-linkable); no query param → first floor. Invalid floor code in the query →
  fall back to the first floor, never a 404 (the site exists; a stale link should degrade).
- **No floors yet:** empty state with "+ Add floor" — the existing add-rack flow (which creates
  floors implicitly) remains untouched and tabs pick up whatever it creates.
- **Inside a tab:**
  - **Rooms** as sections (code, name, MDF/IDF/other type chip), each listing its devices; a
    final **"Floor level"** section holds roomless devices. Add/rename/delete room controls at last
    — until now rooms only came into existence as a side effect of adding racks.
  - **Device rows:** code, type name, friendly name, status chip (planned = grey,
    installed = green), edit/delete. Row edit opens the same modal as add.
  - **Add device modal:** floor-category type picker (from `device_types`), auto-suggested code,
    name, room dropdown (defaulting to "Floor level"), status.
  - **Racks** render exactly as today, filtered to the active floor.
  - **Add/rename floor modal:** code + optional name (`sort_order` auto-assigned max+1 on create).
    **Add/rename room modal:** code + optional name + type (MDF/IDF/other, matching the existing
    check constraint). Codes validated with the existing `validateCode` rules.
- **Deletes** go through the existing `DeleteDialog` typed-confirmation gate with real cascade
  counts: floor → "N rooms, N racks, N devices"; room → "N racks; N devices will move to floor
  level" (devices are NOT deleted with a room — the copy must say "move", not "delete").
  Device delete is a plain confirm (nothing cascades from it in Slice A).

## 5. Server layer

House pattern throughout, no exceptions:

- Data access joins the existing `src/features/locations/repository.ts` (which already owns
  `createFloor`/`createRoom`): list/rename/delete for floors and rooms, cascade counters, and the
  new floor-device CRUD (`listFloorDevicesForSite`, `createFloorDevice`, `updateFloorDevice`,
  `deleteFloorDevice`, `suggestDeviceCode` support query).
- Server actions in the clients feature (`actions.ts` beside the page that uses them), returning
  `{ ok: boolean; error?: string }`, never throwing to the caller; `friendly()` maps duplicate-key
  errors; `revalidatePath` after writes.
- `createFloorDevice(db, { floorId, ... })` reads the floor row first and derives `site_id` from
  it. Moving a device to another floor re-derives it. A device can only move within its site.

## 6. Files

```
supabase/migrations/0011_floor_devices.sql
src/lib/supabase/types.ts                       FloorDeviceRow
src/features/clients/floorDeviceOps.ts          pure: code suggestion, per-room grouping   ← unit tested
src/features/clients/floorDeviceOps.test.ts
src/features/locations/repository.ts            floor/room/device CRUD + cascade counts
src/features/clients/actions.ts                 floor/room/device server actions
src/features/clients/FloorTabs.tsx              tab bar + ?floor= sync
src/features/clients/FloorDevicesPanel.tsx      rooms sections + device rows + modals      ← component tested
src/features/clients/FloorDevicesPanel.test.tsx
src/features/clients/SiteDetail.tsx             becomes the tabbed composition
src/features/clients/SiteDetail.test.tsx        extended
```

## 7. Testing

- `floorDeviceOps` — pure unit tests: code suggestion (empty site, gap-filling, 2→3 digit
  rollover, per-type independence), grouping devices into room sections + floor-level.
- Component tests (actions mocked, DB-free): tab bar renders floors in sort order and syncs the
  query param; device rows group under the right room; the roomless section appears only when
  roomless devices exist; both modals submit the right FormData (assert the actual values, and for
  multi-row cases click a NON-first row — the sites-map review caught a test that could not fail
  because it only ever rendered one candidate).
- Repository functions: integration coverage only if added to the EXISTING scoped integration
  files' conventions (every delete scoped to seeded ids).
- **Constraint: NEVER run vitest against a directory or glob** — `*.integration.test.ts` files
  wipe the local database. Explicit filenames only.

## 8. Out of scope

Plan images and storage (B); coordinates on devices/rooms (B); AI discovery (C); port↔device
linking, the port-settings room picker, and the `described`-endpoint migration (D); device
notes/photos; floor reordering UI (sort_order is set at creation: max+1).

## 9. Open question for the builder

None blocking. One nicety left to the planner's judgment: whether the status chip toggles inline
(click planned→installed on the row) or only via the edit modal. Either satisfies this spec.
