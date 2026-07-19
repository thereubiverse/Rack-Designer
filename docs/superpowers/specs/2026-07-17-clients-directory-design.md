# Clients Directory — Design

**Status:** approved 2026-07-17

**Goal:** Organise racks in a directory per client and site, reached through the Clients section, instead of a flat `Racks` list sitting in the sidebar.

---

## 1. Problem

Racks are reachable only from a flat `/racks` table whose `PATH` column (`PATCH/GF/MDF/RK01`) is the sole hint of where a rack actually lives. There is no client entity at all: a single `DEFAULT` organization owns every site directly, and the `Clients` sidebar entry is a dead button. For an MSP documenting many customers, the rack list does not scale and cannot answer "show me everything for this customer".

## 2. Decisions

Each of these was chosen explicitly during brainstorming; they are recorded here because several are destructive or hard to reverse.

| Decision | Choice | Consequence |
|---|---|---|
| Client entity | New `clients` table replacing `organizations` | Hierarchy becomes `client → site → floor → room → rack` |
| `organizations` table | Dropped entirely | Nothing references it afterwards; no RLS policy mentions it |
| Device library | Global — `organization_id` dropped from `brands`, `device_types`, `device_templates` | One shared catalogue across all clients |
| Navigation | Drill-down pages | `/clients` → client → site → rack builder |
| `Racks` sidebar entry | Removed | Racks are reachable only via Clients → site |
| CRUD scope | Full, including delete | Delete needs an explicit cascade-warning flow |
| Existing data | **Wiped** | Destroys all sites/floors/rooms/racks and their devices, connections and endpoints |
| URL segments | Readable codes | `/clients/acme/hq`; renaming a code changes its URL |

### 2.1 Blast radius of the wipe

`delete from sites` cascades the full chain (all `CASCADE`, verified):

```
sites → floors → rooms → racks → rack_devices → connections
                                              → port_endpoints
```

**Destroyed:** every site, floor, room, rack, rack device, connection and port endpoint — including rack `RK01` with its 3 devices and 19 connections.

**Survives:** the device library (4 templates, 24 device types, 4 brands) and `app_settings`. The library is made global, not deleted.

**Safety net:** before running the destructive statements, the implementer dumps the current location
tables to `~/rack-designer-locations-backup-<YYYYMMDD-HHMM>.sql` via
`docker exec supabase_db_network-doc-platform pg_dump -U postgres -d postgres -t sites -t floors -t rooms -t racks -t rack_devices -t connections -t port_endpoints`.
This is outside the repo so it is never committed. It is a one-way door otherwise; the dump is
insurance the user can ignore.

## 3. Data model

### 3.1 New table

```sql
create table clients (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,   -- URL segment, stored uppercase, e.g. ACME
  name       text not null,
  created_at timestamptz not null default now()
);
```

### 3.2 Migration `0008_clients.sql`, in order

1. Create `clients`.
2. **Wipe:** `delete from sites;` (cascades as above).
3. **Reparent sites:** drop `sites.organization_id` and `sites_organization_id_code_key`; add
   `client_id uuid not null references clients(id) on delete cascade`; add `unique (client_id, code)`.
4. **Library global:** drop `organization_id` from `brands`, `device_types`, `device_templates`;
   replace each composite unique with a global one:

   | Table | Was | Becomes |
   |---|---|---|
   | `brands` | `(organization_id, name)` | `(name)` |
   | `device_templates` | `(organization_id, name)` | `(name)` |
   | `device_types` | `(organization_id, code)` | `(code)` |
   | `device_types` | `(organization_id, category, name)` | `(category, name)` |

5. `drop table organizations;`
6. RLS: enable on `clients` with an open policy matching the existing `single_org_all` pattern.

`floors`, `rooms` and `racks` uniques are untouched — already scoped to their parent
(`floors(site_id, code)`, `rooms(floor_id, code)`, `racks(room_id, code)`).

Deleting a client cascades to sites and therefore the whole subtree — the delete UI relies on this
rather than orchestrating deletes in application code.

### 3.3 Codes

Codes match the existing `isValidCode` pattern (`/^[A-Za-z0-9_-]+$/`), are stored uppercase, and are
matched case-insensitively when resolving a URL, so `/clients/acme` finds `ACME`. Uniqueness is
per parent: client codes are globally unique, site codes unique within their client.

## 4. Routes

| Route | Shows |
|---|---|
| `/clients` | Client list with site and rack counts; create client |
| `/clients/[clientCode]` | That client's sites with rack counts; create site |
| `/clients/[clientCode]/[siteCode]` | Its racks grouped by floor · room; create rack |
| `/racks/[rackId]` | Rack builder — **unchanged** |

The rack builder keeps a UUID permalink: rack codes repeat across rooms (`RK01` exists in every MDF),
so they cannot identify a rack globally. Keeping this route also leaves the app's most complex page,
and every link and test targeting it, untouched. Breadcrumbs on the rack page resolve the rack's path
upward, extending the existing room → floor → site lookup in `siteScope.ts` to include the client.

An unknown or misspelled code returns Next's `notFound()` (404), not an empty page.

## 5. Files

```
src/features/clients/
  repository.ts        clients + sites reads/writes; tree queries with counts
  actions.ts           server actions: create / rename / delete
  validation.ts        pure — code format, duplicate and cascade-warning messages
  ClientsTable.tsx     /clients list + create
  ClientDetail.tsx     sites under a client + create
  SiteDetail.tsx       racks grouped by floor · room + create
  DeleteDialog.tsx     shared confirm; states what cascades
src/app/clients/page.tsx
src/app/clients/[clientCode]/page.tsx
src/app/clients/[clientCode]/[siteCode]/page.tsx
```

**Removed:** `src/app/racks/page.tsx`, `RacksTable.tsx`, `CreateRackModal.tsx`, and
`listRacksWithPath` from `features/locations/repository.ts`. Rack creation moves onto the site page,
where floor and room are chosen in context instead of typed as free text.

`features/locations/repository.ts` keeps floor/room/rack creation, with `getDefaultOrganization`
replaced by client-scoped lookups. Its `actions.ts` keeps the rack-creation action but takes a
resolved site id from the site page instead of free-text site/floor/room codes.

The `Racks` entry is removed from `AppSidebar`; `Clients` becomes a real link to `/clients`.

## 6. Deletes

Cascade is enforced by the database, so the UI's only job is making the consequence legible before
the fact. `DeleteDialog` counts the subtree first and requires typing the code to confirm:

> Delete **ACME**? This removes 3 sites, 7 racks and 41 devices. Type `ACME` to confirm.

- **Client** — cascades to every site, rack and device beneath it.
- **Site** — cascades to its floors, rooms, racks and their devices.
- **Rack** — cascades to its devices, connections and endpoints.
- **Floors and rooms** are implicit: created on demand when a rack needs them, removed when their
  last rack goes. They are never deleted directly.

Typing-to-confirm is required only where the count is non-zero; deleting an empty client is a plain
confirm.

## 7. Error handling

- Duplicate code within a parent → inline field error naming the conflict, not a thrown error.
- Invalid code characters → inline error citing the allowed set.
- Unknown code in a URL → `notFound()`.
- A delete that races another session's delete → treated as success (the row is already gone).
- Server actions return `{ ok, error? }` in the existing style rather than throwing.

## 8. Testing

- **`validation.ts`** — pure unit tests: code format, case normalisation, duplicate and cascade
  message construction.
- **Repository and actions** — one scoped integration test. **It must be run by explicit filename
  only, never a directory or glob**, matching the existing constraint: the integration tests in this
  repo delete rows wholesale and will wipe the local database if run broadly.
- **Pages** — render tests for the empty state, the floor · room grouping on the site page, and the
  delete-confirm gate (the destructive button stays disabled until the typed code matches).

## 9. Out of scope

Moving a rack between rooms or clients; bulk import; per-client branding; client contacts or
addresses beyond the existing `sites.address`; multi-tenancy (the app stays single-tenant — dropping
`organizations` is precisely the removal of the unused tenant placeholder).
