# Archive & Restore (Slice G1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make deleting a client, site or floor reversible — the row is flagged archived, hidden everywhere it is listed, and restorable from a page under Settings.

**Architecture:** A nullable `archived_at` timestamp on `clients`, `sites` and `floors` only — never on their children, so a restore is exact rather than reconstructed and every foreign key and storage path keeps pointing at a live row. List queries filter `archived_at is null`; cascade counters and upward scope resolvers deliberately do not. Nothing in this slice destroys anything.

**Tech Stack:** Next.js 16 (app router, server actions), TypeScript strict, Supabase (local Docker), Vitest + @testing-library/react.

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** `*.integration.test.ts` files wipe the local database. Run named files, or `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`.
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- Use `command grep`, not bare `grep`.
- When piping SQL into psql use `docker exec -i`; without `-i` psql silently receives nothing.
- Every migration ends with these three statements, byte-identical, copied from `0001`'s tail:
  ```sql
  grant usage on schema public to anon, authenticated, service_role;
  grant all privileges on all tables in schema public to service_role;
  grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  ```
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Never commit scripts or tests that reference the user's external PDF paths.
- **Live verification uses a throwaway client only** — never `URI`. Backups already exist at `~/backups/network-doc-platform/`.
- **Nothing in this slice may call `.delete()` on clients, sites or floors.** If a task seems to need it, the task is wrong.
- Existing behaviour to preserve: `deleteRoom`, `deleteRack`, `deleteFloorDevice` and `deleteFloorPlan` stay hard deletes and are not touched.

---

### Task 1: Migration — the archived_at columns

**Files:**
- Create: `supabase/migrations/0016_archive.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: `clients.archived_at`, `sites.archived_at`, `floors.archived_at`, all `timestamptz null`.

- [ ] **Step 1: Write the migration**

```sql
-- Archive: deleting a client, site or floor flags the row instead of destroying it. The flag lives
-- ONLY on the archived row, never on its children — that is what makes a restore exact rather than
-- reconstructed. Row ids survive, so racks.room_id, floor_devices.floor_id and the storage paths
-- that embed site and floor ids all keep pointing at live rows.
alter table clients add column archived_at timestamptz;
alter table sites   add column archived_at timestamptz;
alter table floors  add column archived_at timestamptz;

-- Partial, on the NON-NULL side, because they serve the archive page reading the rare archived
-- rows. The list queries filter `archived_at is null`, which is the overwhelming majority of every
-- table and is better served by a sequential scan than an index.
create index clients_archived_idx on clients (archived_at) where archived_at is not null;
create index sites_archived_idx   on sites   (archived_at) where archived_at is not null;
create index floors_archived_idx  on floors  (archived_at) where archived_at is not null;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

- [ ] **Step 2: Apply it and verify the columns exist**

Run:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0016_archive.sql
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -t -A -c "select table_name from information_schema.columns where column_name='archived_at' order by table_name;"
```
Expected output, exactly these three lines:
```
clients
floors
sites
```

- [ ] **Step 3: Verify no existing row was touched**

Run:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -t -A -c "select count(*) from clients where archived_at is not null;"
```
Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0016_archive.sql
git commit -m "$(cat <<'MSG'
Add archived_at to clients, sites and floors

Additive and reversible: three nullable columns and three partial indexes,
touching no existing row. The flag lives only on the archived row, never on its
children, so a restore keeps every id and therefore every foreign key and
storage path intact.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: Pure nesting logic

**Files:**
- Create: `src/features/clients/archiveOps.ts`
- Test: `src/features/clients/archiveOps.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface ArchivedClient { id: string; code: string; name: string; archivedAt: string }
  export interface ArchivedSite { id: string; code: string; name: string; archivedAt: string; clientId: string }
  export interface ArchivedFloor { id: string; code: string; name: string | null; archivedAt: string; siteId: string }
  export interface ArchiveTree {
    clients: ArchivedClient[];
    sites: { site: ArchivedSite; clientCode: string; clientName: string }[];
    floors: { floor: ArchivedFloor; clientCode: string; siteCode: string; siteName: string }[];
  }
  export function buildArchiveTree(input: {
    archivedClients: ArchivedClient[];
    archivedSites: ArchivedSite[];
    archivedFloors: ArchivedFloor[];
    liveClients: { id: string; code: string; name: string }[];
    liveSites: { id: string; code: string; name: string; clientId: string }[];
  }): ArchiveTree
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/clients/archiveOps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildArchiveTree } from "./archiveOps";

const AT = "2026-07-27T10:00:00Z";

const liveClient = { id: "c1", code: "URI", name: "Urban Resource Institute" };
const liveSite = { id: "s1", code: "HQ", name: "Headquarters", clientId: "c1" };

describe("buildArchiveTree", () => {
  it("lists an archived client on its own", () => {
    const tree = buildArchiveTree({
      archivedClients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }],
      archivedSites: [],
      archivedFloors: [],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.clients).toHaveLength(1);
    expect(tree.clients[0].code).toBe("OLD");
  });

  it("nests an archived site under its LIVE client", () => {
    const tree = buildArchiveTree({
      archivedClients: [],
      archivedSites: [{ id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c1" }],
      archivedFloors: [],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.sites).toHaveLength(1);
    expect(tree.sites[0].clientCode).toBe("URI");
    expect(tree.sites[0].clientName).toBe("Urban Resource Institute");
  });

  it("OMITS an archived site whose client is also archived — it returns with its client", () => {
    // Listing it separately would offer a Restore that puts it back somewhere still invisible,
    // which reads as a broken restore.
    const tree = buildArchiveTree({
      archivedClients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }],
      archivedSites: [{ id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c9" }],
      archivedFloors: [],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.clients).toHaveLength(1);
    expect(tree.sites).toEqual([]);
  });

  it("nests an archived floor under its live client and site", () => {
    const tree = buildArchiveTree({
      archivedClients: [],
      archivedSites: [],
      archivedFloors: [{ id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "s1" }],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.floors).toHaveLength(1);
    expect(tree.floors[0].clientCode).toBe("URI");
    expect(tree.floors[0].siteCode).toBe("HQ");
    expect(tree.floors[0].siteName).toBe("Headquarters");
  });

  it("OMITS an archived floor whose site is archived", () => {
    const tree = buildArchiveTree({
      archivedClients: [],
      archivedSites: [{ id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c1" }],
      archivedFloors: [{ id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "s9" }],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.sites).toHaveLength(1);
    expect(tree.floors).toEqual([]);
  });

  it("OMITS an archived floor whose CLIENT is archived, even though its site is live", () => {
    // The site is live but unreachable, because its client is archived. Two levels up still counts.
    const tree = buildArchiveTree({
      archivedClients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }],
      archivedSites: [],
      archivedFloors: [{ id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "s2" }],
      liveClients: [liveClient],
      liveSites: [liveSite, { id: "s2", code: "S2", name: "Site Two", clientId: "c9" }],
    });
    expect(tree.floors).toEqual([]);
  });

  it("drops a row whose ancestor is missing entirely rather than crashing", () => {
    // Defensive: a race between the page's queries could hand us a floor whose site row is gone.
    const tree = buildArchiveTree({
      archivedClients: [],
      archivedSites: [{ id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "nope" }],
      archivedFloors: [{ id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "nope" }],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.sites).toEqual([]);
    expect(tree.floors).toEqual([]);
  });

  it("sorts each group by code so the page is stable between loads", () => {
    const tree = buildArchiveTree({
      archivedClients: [
        { id: "c9", code: "ZED", name: "Zed", archivedAt: AT },
        { id: "c8", code: "ACME", name: "Acme", archivedAt: AT },
      ],
      archivedSites: [],
      archivedFloors: [],
      liveClients: [liveClient],
      liveSites: [liveSite],
    });
    expect(tree.clients.map((c) => c.code)).toEqual(["ACME", "ZED"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/features/clients/archiveOps.test.ts`
Expected: FAIL — `Failed to resolve import "./archiveOps"`

- [ ] **Step 3: Write the implementation**

Create `src/features/clients/archiveOps.ts`:

```ts
/** Shaping for the archive page: which archived rows to show, and what to nest them under.
 *
 *  PURE — no database, no React. The one rule with any subtlety is that a row is listed only when
 *  every ancestor above it is live, and that rule is easier to trust with tests than with a join. */

export interface ArchivedClient {
  id: string;
  code: string;
  name: string;
  archivedAt: string;
}

export interface ArchivedSite {
  id: string;
  code: string;
  name: string;
  archivedAt: string;
  clientId: string;
}

export interface ArchivedFloor {
  id: string;
  code: string;
  name: string | null;
  archivedAt: string;
  siteId: string;
}

export interface ArchiveTree {
  clients: ArchivedClient[];
  sites: { site: ArchivedSite; clientCode: string; clientName: string }[];
  floors: { floor: ArchivedFloor; clientCode: string; siteCode: string; siteName: string }[];
}

const byCode = <T extends { code: string }>(a: T, b: T) => a.code.localeCompare(b.code);

/**
 * Group archived rows under their live ancestors.
 *
 * A row appears ONLY if every ancestor above it is live. An archived site under an archived client
 * is omitted, and so is an archived floor under either an archived site or an archived client —
 * restoring one alone would put it back somewhere still invisible, which reads as a broken restore.
 * Those rows come back with their ancestor instead.
 *
 * `liveClients` and `liveSites` are the UNARCHIVED rows; a row whose ancestor appears in neither the
 * live nor the archived list is dropped rather than thrown on, so a race between the page's queries
 * degrades to a missing line instead of a crash.
 */
export function buildArchiveTree(input: {
  archivedClients: ArchivedClient[];
  archivedSites: ArchivedSite[];
  archivedFloors: ArchivedFloor[];
  liveClients: { id: string; code: string; name: string }[];
  liveSites: { id: string; code: string; name: string; clientId: string }[];
}): ArchiveTree {
  const liveClientById = new Map(input.liveClients.map((c) => [c.id, c]));
  const liveSiteById = new Map(input.liveSites.map((s) => [s.id, s]));

  const sites = input.archivedSites
    .map((site) => {
      const client = liveClientById.get(site.clientId);
      return client ? { site, clientCode: client.code, clientName: client.name } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => byCode(a.site, b.site));

  const floors = input.archivedFloors
    .map((floor) => {
      const site = liveSiteById.get(floor.siteId);
      if (!site) return null;
      // Two levels up still counts: a live site under an archived client is itself unreachable.
      const client = liveClientById.get(site.clientId);
      if (!client) return null;
      return { floor, clientCode: client.code, siteCode: site.code, siteName: site.name };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => byCode(a.floor, b.floor));

  return { clients: [...input.archivedClients].sort(byCode), sites, floors };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/vitest run src/features/clients/archiveOps.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/features/clients/archiveOps.ts src/features/clients/archiveOps.test.ts
git commit -m "$(cat <<'MSG'
Add the archive page's nesting rule as a pure function

A row is listed only when every ancestor above it is live. An archived site
under an archived client is omitted, as is a floor under an archived site OR an
archived client - restoring one alone would put it back somewhere still
invisible, which reads as a broken restore.

Pure and separately tested because it is the only real logic in the slice, and a
missing-ancestor race degrades to a dropped line rather than a crash.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Repository — archive, restore, and filter the lists

**Files:**
- Modify: `src/features/clients/repository.ts`
- Modify: `src/features/locations/repository.ts`
- Modify: `src/features/clients/repository.integration.test.ts`

**Interfaces:**
- Consumes: Task 1's columns; Task 2's `ArchivedClient` / `ArchivedSite` / `ArchivedFloor`.
- Produces, in `src/features/clients/repository.ts`:
  ```ts
  export async function archiveClient(db: SupabaseClient, id: string): Promise<void>
  export async function restoreClient(db: SupabaseClient, id: string): Promise<void>
  export async function archiveSite(db: SupabaseClient, id: string): Promise<void>
  export async function restoreSite(db: SupabaseClient, id: string): Promise<void>
  export async function listArchived(db: SupabaseClient): Promise<{
    archivedClients: ArchivedClient[];
    archivedSites: ArchivedSite[];
    archivedFloors: ArchivedFloor[];
    liveClients: { id: string; code: string; name: string }[];
    liveSites: { id: string; code: string; name: string; clientId: string }[];
  }>
  ```
  and in `src/features/locations/repository.ts`:
  ```ts
  export async function archiveFloor(db: SupabaseClient, id: string): Promise<void>
  export async function restoreFloor(db: SupabaseClient, id: string): Promise<void>
  ```

- [ ] **Step 1: Add the archive/restore writers to `src/features/clients/repository.ts`**

Insert immediately after `deleteClient` (currently line 202-205):

```ts
/** Archive rather than delete. The flag goes on THIS row only — children are untouched, which is
 *  what lets restoreClient put everything back exactly as it was, ids and all. Nothing in Slice G1
 *  calls `.delete()` on clients, sites or floors. */
export async function archiveClient(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from("clients")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`archiveClient: ${error.message}`);
}

export async function restoreClient(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("clients").update({ archived_at: null }).eq("id", id);
  if (error) throw new Error(`restoreClient: ${error.message}`);
}
```

Insert immediately after `deleteSite`:

```ts
export async function archiveSite(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from("sites")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`archiveSite: ${error.message}`);
}

export async function restoreSite(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("sites").update({ archived_at: null }).eq("id", id);
  if (error) throw new Error(`restoreSite: ${error.message}`);
}
```

- [ ] **Step 2: Filter the list and by-code reads in `src/features/clients/repository.ts`**

In `listClients`, add `.is("archived_at", null)` to the chain:

```ts
  const { data: clients, error } = await db
    .from("clients")
    .select("*")
    // Archived clients are hidden everywhere they are LISTED. Cascade counters and upward scope
    // resolvers deliberately still see them — see the archive spec, section 4.
    .is("archived_at", null)
    .order("code", { ascending: true });
```

In `getClientByCode`, add `.is("archived_at", null)` before `.maybeSingle()` so `/clients/URI` 404s once archived.

In `listSitesForClient`, add `.is("archived_at", null)` after `.eq("client_id", clientId)`.

In `getSiteByCode`, add `.is("archived_at", null)` before `.maybeSingle()`.

Leave `getSiteById`, `countSiteCascade`, `countClientCascade` and `getRackBreadcrumb` **unfiltered**.

- [ ] **Step 3: Add `listArchived` to `src/features/clients/repository.ts`**

Append at the end of the file:

```ts
/** Everything the archive page needs, in five queries: the archived rows at each level, plus the
 *  LIVE clients and sites used to work out what each archived row nests under. The nesting itself is
 *  buildArchiveTree's job — this function only fetches. */
export async function listArchived(db: SupabaseClient): Promise<{
  archivedClients: ArchivedClient[];
  archivedSites: ArchivedSite[];
  archivedFloors: ArchivedFloor[];
  liveClients: { id: string; code: string; name: string }[];
  liveSites: { id: string; code: string; name: string; clientId: string }[];
}> {
  const [ac, as, af, lc, ls] = await Promise.all([
    db.from("clients").select("id, code, name, archived_at").not("archived_at", "is", null),
    db.from("sites").select("id, code, name, archived_at, client_id").not("archived_at", "is", null),
    db.from("floors").select("id, code, name, archived_at, site_id").not("archived_at", "is", null),
    db.from("clients").select("id, code, name").is("archived_at", null),
    db.from("sites").select("id, code, name, client_id").is("archived_at", null),
  ]);
  for (const r of [ac, as, af, lc, ls]) {
    if (r.error) throw new Error(`listArchived: ${r.error.message}`);
  }
  type Raw = Record<string, string | null>;
  return {
    archivedClients: ((ac.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name ?? ""), archivedAt: String(r.archived_at),
    })),
    archivedSites: ((as.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name ?? ""), archivedAt: String(r.archived_at),
      clientId: String(r.client_id),
    })),
    archivedFloors: ((af.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: r.name === null ? null : String(r.name),
      archivedAt: String(r.archived_at), siteId: String(r.site_id),
    })),
    liveClients: ((lc.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name ?? ""),
    })),
    liveSites: ((ls.data ?? []) as Raw[]).map((r) => ({
      id: String(r.id), code: String(r.code), name: String(r.name ?? ""), clientId: String(r.client_id),
    })),
  };
}
```

Add to the imports at the top of the file:

```ts
import type { ArchivedClient, ArchivedFloor, ArchivedSite } from "./archiveOps";
```

- [ ] **Step 4: Add floor archive/restore and filtering in `src/features/locations/repository.ts`**

Insert immediately after `deleteFloor` (currently line 119-122):

```ts
/** See archiveClient: the flag goes on the floor only, so its rooms, racks, devices, plan and wall
 *  geometry are untouched and come back exactly as they were. */
export async function archiveFloor(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from("floors")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`archiveFloor: ${error.message}`);
}

export async function restoreFloor(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("floors").update({ archived_at: null }).eq("id", id);
  if (error) throw new Error(`restoreFloor: ${error.message}`);
}
```

In `listFloorsForSite`, add the filter:

```ts
export async function listFloorsForSite(db: SupabaseClient, siteId: string): Promise<FloorRow[]> {
  const { data, error } = await db.from("floors").select("*").eq("site_id", siteId)
    .is("archived_at", null)
    .order("sort_order", { ascending: true }).order("code", { ascending: true });
  if (error) throw new Error(`listFloorsForSite: ${error.message}`);
  return (data ?? []) as FloorRow[];
}
```

- [ ] **Step 5: Add integration coverage (for CI — do NOT run this file)**

Append inside the existing top-level `describe` in `src/features/clients/repository.integration.test.ts`:

```ts
  it("hides archived rows from the lists but keeps them countable and fetchable by id", async () => {
    const client = await createClientRow(db, { code: "T-CLI-I", name: "Client I" });
    const site = await createSiteForClient(db, { clientId: client.id, code: "S1", name: "Site 1" });

    expect((await listClients(db)).some((c) => c.id === client.id)).toBe(true);

    await archiveClient(db, client.id);
    expect((await listClients(db)).some((c) => c.id === client.id)).toBe(false);
    expect(await getClientByCode(db, "T-CLI-I")).toBeNull();

    // Deliberately still visible: the cascade counter answers "what would deleting this destroy",
    // and getSiteById is an upward resolver, not a listing.
    expect((await countClientCascade(db, client.id)).sites).toBe(1);
    expect(await getSiteById(db, site.id)).not.toBeNull();

    await restoreClient(db, client.id);
    expect((await listClients(db)).some((c) => c.id === client.id)).toBe(true);
    expect(await getClientByCode(db, "T-CLI-I")).not.toBeNull();
  });

  it("archives a site and a floor without touching anything beneath them", async () => {
    const client = await createClientRow(db, { code: "T-CLI-J", name: "Client J" });
    const site = await createSiteForClient(db, { clientId: client.id, code: "S1", name: "Site 1" });
    const { data: floor } = await db
      .from("floors")
      .insert({ site_id: site.id, code: "GF" })
      .select("*")
      .single();
    const { data: room } = await db
      .from("rooms")
      .insert({ floor_id: floor!.id, code: "MDF1", type: "MDF" })
      .select("*")
      .single();

    await archiveSite(db, site.id);
    expect((await listSitesForClient(db, client.id)).some((s) => s.id === site.id)).toBe(false);
    // The room is untouched — that is what makes the restore exact.
    const { data: stillThere } = await db.from("rooms").select("id").eq("id", room!.id).maybeSingle();
    expect(stillThere).not.toBeNull();

    await restoreSite(db, site.id);
    expect((await listSitesForClient(db, client.id)).some((s) => s.id === site.id)).toBe(true);

    await archiveFloor(db, floor!.id);
    expect((await listFloorsForSite(db, site.id)).some((f) => f.id === floor!.id)).toBe(false);
    await restoreFloor(db, floor!.id);
    expect((await listFloorsForSite(db, site.id)).some((f) => f.id === floor!.id)).toBe(true);
  });
```

Add the new names to that file's existing import from `./repository`: `archiveClient`, `restoreClient`, `archiveSite`, `restoreSite`, `listClients`, `listSitesForClient`, `getClientByCode`, `getSiteById`. Add a new import for the floor helpers:

```ts
import { archiveFloor, restoreFloor, listFloorsForSite } from "@/features/locations/repository";
```

- [ ] **Step 6: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no output

- [ ] **Step 7: Verify the existing suite still passes**

Run: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
Expected: all files pass. Nothing user-visible has changed yet — the delete buttons still delete.

- [ ] **Step 8: Commit**

```bash
git add src/features/clients/repository.ts src/features/locations/repository.ts src/features/clients/repository.integration.test.ts
git commit -m "$(cat <<'MSG'
Add archive/restore reads and writes, with the lists filtered

Archived rows disappear from every query that LISTS clients, sites or floors,
and from the by-code lookups that render their pages, so an archived client 404s
rather than rendering empty.

Two categories deliberately keep seeing archived rows: the cascade counters,
which answer what a permanent delete would destroy, and the upward scope
resolvers, which walk from a row reached some other way and would break a page
rather than hide a listing.

No behaviour changes yet - the delete buttons still delete. This step exists so
the recovery path is in place before anything can be archived.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: Server actions — archive and restore

**Files:**
- Modify: `src/features/clients/actions.ts`
- Create: `src/features/clients/archiveActions.test.ts`

**Interfaces:**
- Consumes: Task 3's `archiveClient`, `restoreClient`, `archiveSite`, `restoreSite`, `archiveFloor`, `restoreFloor`.
- Produces, all in `src/features/clients/actions.ts`:
  ```ts
  export async function archiveClientAction(formData: FormData): Promise<{ ok: boolean; error?: string }>
  export async function restoreClientAction(formData: FormData): Promise<{ ok: boolean; error?: string }>
  export async function archiveSiteAction(formData: FormData): Promise<{ ok: boolean; error?: string }>
  export async function restoreSiteAction(formData: FormData): Promise<{ ok: boolean; error?: string }>
  export async function archiveFloorAction(formData: FormData): Promise<{ ok: boolean; error?: string }>
  export async function restoreFloorAction(formData: FormData): Promise<{ ok: boolean; error?: string }>
  ```
  Each reads `id` from the form data and revalidates both `/clients` and `/settings/archive`.

- [ ] **Step 1: Write the failing test**

Create `src/features/clients/archiveActions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// DB-free: the repository is mocked outright, so these tests assert which repository function the
// action reaches for — the property that matters here is that archiving never reaches a delete.
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./repository", () => ({
  archiveClient: vi.fn(),
  restoreClient: vi.fn(),
  archiveSite: vi.fn(),
  restoreSite: vi.fn(),
  deleteClient: vi.fn(),
  deleteSite: vi.fn(),
}));
vi.mock("@/features/locations/repository", () => ({
  archiveFloor: vi.fn(),
  restoreFloor: vi.fn(),
  deleteFloor: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { archiveClient, restoreClient, archiveSite, restoreSite, deleteClient, deleteSite } from "./repository";
import { archiveFloor, restoreFloor, deleteFloor } from "@/features/locations/repository";
import {
  archiveClientAction,
  restoreClientAction,
  archiveSiteAction,
  restoreSiteAction,
  archiveFloorAction,
  restoreFloorAction,
} from "./actions";

const fd = (id: string) => {
  const f = new FormData();
  f.set("id", id);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("archive actions", () => {
  it("archives a client and NEVER deletes it", async () => {
    await expect(archiveClientAction(fd("c1"))).resolves.toEqual({ ok: true });
    expect(archiveClient).toHaveBeenCalledWith(expect.anything(), "c1");
    // The assertion this slice exists for.
    expect(deleteClient).not.toHaveBeenCalled();
  });

  it("archives a site and a floor without deleting either", async () => {
    await archiveSiteAction(fd("s1"));
    await archiveFloorAction(fd("f1"));
    expect(archiveSite).toHaveBeenCalledWith(expect.anything(), "s1");
    expect(archiveFloor).toHaveBeenCalledWith(expect.anything(), "f1");
    expect(deleteSite).not.toHaveBeenCalled();
    expect(deleteFloor).not.toHaveBeenCalled();
  });

  it("restores each level", async () => {
    await restoreClientAction(fd("c1"));
    await restoreSiteAction(fd("s1"));
    await restoreFloorAction(fd("f1"));
    expect(restoreClient).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(restoreSite).toHaveBeenCalledWith(expect.anything(), "s1");
    expect(restoreFloor).toHaveBeenCalledWith(expect.anything(), "f1");
  });

  it("revalidates BOTH the directory and the archive page", async () => {
    // Archiving changes what each page shows; refreshing only one leaves the other stale.
    await archiveClientAction(fd("c1"));
    expect(revalidatePath).toHaveBeenCalledWith("/clients");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/archive");
  });

  it("resolves {ok:false} when the repository throws — never rejects", async () => {
    vi.mocked(archiveClient).mockRejectedValueOnce(new Error("db down"));
    const res = await archiveClientAction(fd("c1"));
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/features/clients/archiveActions.test.ts`
Expected: FAIL — `archiveClientAction is not a function`

- [ ] **Step 3: Write the actions**

In `src/features/clients/actions.ts`, add to the existing import from `./repository`: `archiveClient`, `restoreClient`, `archiveSite`, `restoreSite`. Add to the existing import from `@/features/locations/repository`: `archiveFloor`, `restoreFloor`.

Append after `deleteFloorAction`:

```ts
// ---- Archive & restore -----------------------------------------------------------------------
//
// Archiving is the new meaning of the delete controls on clients, sites and floors: the row is
// flagged, not destroyed, and every child is left alone. Both paths revalidate the directory AND
// the archive page, because one operation changes what each of them shows.

async function archiveOrRestore(
  id: string,
  run: (db: ReturnType<typeof createServiceClient>, id: string) => Promise<void>,
  kind: "client" | "site" | "floor"
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    await run(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e, kind) };
  }
  revalidatePath("/clients");
  revalidatePath("/settings/archive");
  return { ok: true };
}

export async function archiveClientAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  return archiveOrRestore(String(formData.get("id") ?? ""), archiveClient, "client");
}

export async function restoreClientAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  return archiveOrRestore(String(formData.get("id") ?? ""), restoreClient, "client");
}

export async function archiveSiteAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  return archiveOrRestore(String(formData.get("id") ?? ""), archiveSite, "site");
}

export async function restoreSiteAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  return archiveOrRestore(String(formData.get("id") ?? ""), restoreSite, "site");
}

export async function archiveFloorAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  return archiveOrRestore(String(formData.get("id") ?? ""), archiveFloor, "floor");
}

export async function restoreFloorAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  return archiveOrRestore(String(formData.get("id") ?? ""), restoreFloor, "floor");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/vitest run src/features/clients/archiveActions.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Typecheck and check nothing else broke**

Run:
```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run src/features/clients/actions.test.ts src/features/clients/archiveActions.test.ts
```
Expected: no tsc output; both files pass.

- [ ] **Step 6: Commit**

```bash
git add src/features/clients/actions.ts src/features/clients/archiveActions.test.ts
git commit -m "$(cat <<'MSG'
Add archive and restore server actions

Six actions over one shared helper, each revalidating both the directory and the
archive page because a single archive changes what both show.

The load-bearing assertions are negative: archiving a client, site or floor must
never reach a delete. Those run against a mocked repository, so they check which
function the action chose rather than what a database ended up holding.

Still not wired to any button - the delete controls are repointed in a later
task, after the archive page exists.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: The archive page

**Files:**
- Create: `src/features/settings/ArchivePanel.tsx`
- Create: `src/features/settings/ArchivePanel.test.tsx`
- Create: `src/app/settings/archive/page.tsx`
- Modify: `src/features/settings/SettingsPage.tsx`

**Interfaces:**
- Consumes: Task 2's `buildArchiveTree` and `ArchiveTree`; Task 3's `listArchived`; Task 4's `restoreClientAction`, `restoreSiteAction`, `restoreFloorAction`.
- Produces: `export function ArchivePanel({ tree }: { tree: ArchiveTree })`, and the route `/settings/archive`.

- [ ] **Step 1: Write the failing test**

Create `src/features/settings/ArchivePanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ArchivePanel } from "./ArchivePanel";
import type { ArchiveTree } from "@/features/clients/archiveOps";

vi.mock("@/features/clients/actions", () => ({
  restoreClientAction: vi.fn(async () => ({ ok: true })),
  restoreSiteAction: vi.fn(async () => ({ ok: true })),
  restoreFloorAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { restoreClientAction, restoreSiteAction } from "@/features/clients/actions";

const AT = "2026-07-27T10:00:00Z";
const empty: ArchiveTree = { clients: [], sites: [], floors: [] };

beforeEach(() => vi.clearAllMocks());

describe("ArchivePanel", () => {
  it("says so when nothing is archived", () => {
    render(<ArchivePanel tree={empty} />);
    expect(screen.getByTestId("archive-empty")).toBeInTheDocument();
  });

  it("lists an archived client with its code", () => {
    render(
      <ArchivePanel
        tree={{ ...empty, clients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }] }}
      />
    );
    const row = screen.getByTestId("archived-client-c9");
    expect(row.textContent).toContain("Old Co");
    expect(row.textContent).toContain("OLD");
  });

  it("shows an archived site under its client's name", () => {
    render(
      <ArchivePanel
        tree={{
          ...empty,
          sites: [
            {
              site: { id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c1" },
              clientCode: "URI",
              clientName: "Urban Resource Institute",
            },
          ],
        }}
      />
    );
    const row = screen.getByTestId("archived-site-s9");
    expect(row.textContent).toContain("Branch");
    expect(row.textContent).toContain("Urban Resource Institute");
  });

  it("shows an archived floor under its client AND site", () => {
    render(
      <ArchivePanel
        tree={{
          ...empty,
          floors: [
            {
              floor: { id: "f9", code: "GF", name: "Ground", archivedAt: AT, siteId: "s1" },
              clientCode: "URI",
              siteCode: "HQ",
              siteName: "Headquarters",
            },
          ],
        }}
      />
    );
    const row = screen.getByTestId("archived-floor-f9");
    expect(row.textContent).toContain("Ground");
    expect(row.textContent).toContain("Headquarters");
  });

  it("restores a client when its Restore is clicked", async () => {
    render(
      <ArchivePanel
        tree={{ ...empty, clients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }] }}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-client-c9"));
    });
    const sent = vi.mocked(restoreClientAction).mock.calls[0][0] as FormData;
    expect(sent.get("id")).toBe("c9");
  });

  it("restores a site when its Restore is clicked", async () => {
    render(
      <ArchivePanel
        tree={{
          ...empty,
          sites: [
            {
              site: { id: "s9", code: "BR", name: "Branch", archivedAt: AT, clientId: "c1" },
              clientCode: "URI",
              clientName: "Urban Resource Institute",
            },
          ],
        }}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-site-s9"));
    });
    const sent = vi.mocked(restoreSiteAction).mock.calls[0][0] as FormData;
    expect(sent.get("id")).toBe("s9");
  });

  it("offers NO permanent delete anywhere — that is Slice G2", () => {
    render(
      <ArchivePanel
        tree={{ ...empty, clients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }] }}
      />
    );
    expect(screen.queryByTestId("purge-client-c9")).toBeNull();
    expect(screen.queryByText(/permanently/i)).toBeNull();
  });

  it("surfaces a failed restore instead of silently doing nothing", async () => {
    vi.mocked(restoreClientAction).mockResolvedValueOnce({ ok: false, error: "db down" });
    render(
      <ArchivePanel
        tree={{ ...empty, clients: [{ id: "c9", code: "OLD", name: "Old Co", archivedAt: AT }] }}
      />
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("restore-client-c9"));
    });
    expect(screen.getByTestId("archive-error").textContent).toContain("db down");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/features/settings/ArchivePanel.test.tsx`
Expected: FAIL — `Failed to resolve import "./ArchivePanel"`

- [ ] **Step 3: Write the component**

Create `src/features/settings/ArchivePanel.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import {
  restoreClientAction,
  restoreSiteAction,
  restoreFloorAction,
} from "@/features/clients/actions";
import type { ArchiveTree } from "@/features/clients/archiveOps";

/** Settings → Archive: everything that has been archived, nested under whatever it belongs to.
 *
 *  There is deliberately NO permanent delete here. That is Slice G2, and it arrives only once this
 *  restore path has been used in anger — a destructive control on a page whose recovery path is
 *  untested is exactly what the two-slice split exists to avoid. */

/** ISO timestamp -> "27 Jul 2026". Fixed locale so the rendering does not drift between the server
 *  and the browser, which would trip React's hydration check. */
function archivedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function Row({
  testId,
  title,
  subtitle,
  parent,
  archivedAt,
  onRestore,
  busy,
}: {
  testId: string;
  title: string;
  subtitle: string;
  parent?: string;
  archivedAt: string;
  onRestore: () => void;
  busy: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-center gap-3 border-b border-neutral-100 px-4 py-3 last:border-0"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-neutral-900">{title}</p>
        <p className="truncate text-xs text-neutral-500">
          {subtitle}
          {parent ? ` · in ${parent}` : ""}
        </p>
      </div>
      <span className="shrink-0 text-xs text-neutral-400">Archived {archivedOn(archivedAt)}</span>
      <button
        type="button"
        data-testid={`restore-${testId.replace("archived-", "")}`}
        disabled={busy}
        onClick={onRestore}
        className="shrink-0 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
      >
        Restore
      </button>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <h3 className="border-b border-neutral-100 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ArchivePanel({ tree }: { tree: ArchiveTree }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = tree.clients.length + tree.sites.length + tree.floors.length;

  async function run(action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, id: string) {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("id", id);
    const res = await action(fd);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Restore failed");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-neutral-900">Archive</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Archived records are hidden from the app but keep all of their data. Restore one to bring
          it back exactly as it was.
        </p>
      </div>

      {error && (
        <p
          data-testid="archive-error"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      {total === 0 ? (
        <div
          data-testid="archive-empty"
          className="rounded-2xl border border-dashed border-neutral-200 bg-white px-6 py-14 text-center"
        >
          <Icon icon="tabler:archive" width={22} height={22} className="mx-auto text-neutral-300" />
          <p className="mt-2 text-sm font-medium text-neutral-900">Nothing archived</p>
          <p className="mt-1 text-sm text-neutral-500">
            Deleting a client, site or floor archives it here instead of destroying it.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {tree.clients.length > 0 && (
            <Group title="Clients">
              {tree.clients.map((c) => (
                <Row
                  key={c.id}
                  testId={`archived-client-${c.id}`}
                  title={c.name}
                  subtitle={c.code}
                  archivedAt={c.archivedAt}
                  busy={busy}
                  onRestore={() => void run(restoreClientAction, c.id)}
                />
              ))}
            </Group>
          )}

          {tree.sites.length > 0 && (
            <Group title="Sites">
              {tree.sites.map((s) => (
                <Row
                  key={s.site.id}
                  testId={`archived-site-${s.site.id}`}
                  title={s.site.name}
                  subtitle={s.site.code}
                  parent={s.clientName}
                  archivedAt={s.site.archivedAt}
                  busy={busy}
                  onRestore={() => void run(restoreSiteAction, s.site.id)}
                />
              ))}
            </Group>
          )}

          {tree.floors.length > 0 && (
            <Group title="Floors">
              {tree.floors.map((f) => (
                <Row
                  key={f.floor.id}
                  testId={`archived-floor-${f.floor.id}`}
                  title={f.floor.name || f.floor.code}
                  subtitle={f.floor.code}
                  parent={`${f.siteName} · ${f.clientCode}`}
                  archivedAt={f.floor.archivedAt}
                  busy={busy}
                  onRestore={() => void run(restoreFloorAction, f.floor.id)}
                />
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/vitest run src/features/settings/ArchivePanel.test.tsx`
Expected: PASS, 8 tests

- [ ] **Step 5: Add the route**

Create `src/app/settings/archive/page.tsx`:

```tsx
import { createServiceClient } from "@/lib/supabase/server";
import { listArchived } from "@/features/clients/repository";
import { buildArchiveTree } from "@/features/clients/archiveOps";
import { ArchivePanel } from "@/features/settings/ArchivePanel";
import { SettingsShell } from "@/features/settings/SettingsShell";

// Archive contents change whenever anything is archived or restored; never prerender it.
export const dynamic = "force-dynamic";

export default async function ArchiveSettings() {
  const db = createServiceClient();
  return (
    <SettingsShell active="archive">
      <ArchivePanel tree={buildArchiveTree(await listArchived(db))} />
    </SettingsShell>
  );
}
```

- [ ] **Step 6: Extract the settings shell so both pages share one sub-nav**

Create `src/features/settings/SettingsShell.tsx`:

```tsx
import Link from "next/link";

/** The Settings sub-nav, shared by every settings page. Extracted from SettingsPage when the
 *  archive gained its own route: the items are links now, not the static span the single-page
 *  version could get away with. */
const ITEMS: { key: string; label: string; href: string; group: string }[] = [
  { key: "device-wizard", label: "Device Wizard", href: "/settings", group: "Features" },
  { key: "archive", label: "Archive", href: "/settings/archive", group: "Data" },
];

export function SettingsShell({
  active,
  children,
}: {
  active: string;
  children: React.ReactNode;
}) {
  const groups = [...new Set(ITEMS.map((i) => i.group))];
  return (
    <div className="flex gap-8">
      <nav className="w-56 shrink-0 space-y-4">
        {groups.map((group) => (
          <div key={group}>
            <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              {group}
            </p>
            {ITEMS.filter((i) => i.group === group).map((item) => (
              <Link
                key={item.key}
                href={item.href}
                data-testid={`settings-nav-${item.key}`}
                className={`block rounded-lg px-3 py-2 text-sm font-medium ${
                  active === item.key
                    ? "bg-blue-50 text-blue-700"
                    : "text-neutral-600 hover:bg-neutral-100"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <section className="min-w-0 flex-1">{children}</section>
    </div>
  );
}
```

Replace the body of `src/features/settings/SettingsPage.tsx` with:

```tsx
"use client";

import { DeviceWizardSettingsPanel } from "./DeviceWizardSettingsPanel";
import { SettingsShell } from "./SettingsShell";

export function SettingsPage({ deviceWizard }: { deviceWizard: { enabled: boolean; hasKey: boolean } }) {
  return (
    <SettingsShell active="device-wizard">
      <DeviceWizardSettingsPanel initial={deviceWizard} />
    </SettingsShell>
  );
}
```

- [ ] **Step 7: Typecheck and run the settings tests**

Run:
```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run src/features/settings/ArchivePanel.test.tsx src/features/settings/DeviceWizardSettingsPanel.test.tsx
```
Expected: no tsc output; both files pass.

- [ ] **Step 8: Verify the page renders**

Run: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
Expected: every file passes.

Then, with the dev server running, open `http://localhost:3100/settings/archive` and confirm it shows "Nothing archived" and that the sub-nav has Features → Device Wizard and Data → Archive.

- [ ] **Step 9: Commit**

```bash
git add src/features/settings/ArchivePanel.tsx src/features/settings/ArchivePanel.test.tsx src/features/settings/SettingsShell.tsx src/features/settings/SettingsPage.tsx src/app/settings/archive/page.tsx
git commit -m "$(cat <<'MSG'
Add the archive page under Settings

Lists archived clients, sites and floors, each nested under whatever it belongs
to, with Restore on every row. The Settings sub-nav is extracted into a shared
shell so both pages use it and its items become real links.

Deliberately NO permanent delete: that is Slice G2, and it arrives only once
this restore path has been used. A test asserts its absence so it cannot appear
by accident.

Nothing can be archived yet - the delete controls are repointed next, now that
the way back exists.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: Repoint the delete controls to archive

**Files:**
- Create: `src/features/clients/ArchiveDialog.tsx`
- Create: `src/features/clients/ArchiveDialog.test.tsx`
- Modify: `src/features/clients/ClientsTable.tsx`
- Modify: `src/features/clients/ClientDetail.tsx`
- Modify: `src/features/clients/SiteDetail.tsx`
- Modify: `src/features/clients/ClientsTable.test.tsx`
- Modify: `src/features/clients/ClientDetail.test.tsx`

**Interfaces:**
- Consumes: Task 4's `archiveClientAction`, `archiveSiteAction`, `archiveFloorAction`.
- Produces: `export function ArchiveDialog({ kind, code, error, busy, onConfirm, onCancel }: ArchiveDialogProps)` where `kind: "client" | "site" | "floor"`.

`DeleteDialog` is **not** modified — it still serves racks, rooms and plans, which remain hard deletes. A separate dialog is cheaper than a mode flag and keeps the destructive copy away from the reversible action.

- [ ] **Step 1: Write the failing test**

Create `src/features/clients/ArchiveDialog.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArchiveDialog } from "./ArchiveDialog";

const base = {
  kind: "client" as const,
  code: "URI",
  error: null,
  busy: false,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe("ArchiveDialog", () => {
  it("says the record can be restored, and does NOT threaten deletion", () => {
    render(<ArchiveDialog {...base} />);
    const text = screen.getByTestId("archive-dialog").textContent ?? "";
    expect(text).toContain("restored");
    // The old copy claimed "This will permanently delete ..." — after archiving that is false.
    expect(text).not.toMatch(/permanently/i);
    expect(text).not.toMatch(/delete/i);
  });

  it("confirms WITHOUT a typed code — archiving is reversible", () => {
    // A confirmation that costs as much as a destructive one teaches people to type through both.
    const onConfirm = vi.fn();
    render(<ArchiveDialog {...base} onConfirm={onConfirm} />);
    expect(screen.queryByLabelText(/type/i)).toBeNull();
    fireEvent.click(screen.getByTestId("archive-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("names the thing being archived", () => {
    render(<ArchiveDialog {...base} kind="floor" code="GF" />);
    expect(screen.getByTestId("archive-dialog").textContent).toContain("GF");
  });

  it("shows an error and stays open", () => {
    render(<ArchiveDialog {...base} error="db down" />);
    expect(screen.getByTestId("archive-error-message").textContent).toContain("db down");
  });

  it("disables both buttons while busy so a double click cannot double-archive", () => {
    render(<ArchiveDialog {...base} busy />);
    expect(screen.getByTestId("archive-confirm")).toBeDisabled();
    expect(screen.getByTestId("archive-cancel")).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/features/clients/ArchiveDialog.test.tsx`
Expected: FAIL — `Failed to resolve import "./ArchiveDialog"`

- [ ] **Step 3: Write the dialog**

Create `src/features/clients/ArchiveDialog.tsx`:

```tsx
"use client";

/** Confirmation for archiving a client, site or floor.
 *
 *  Separate from DeleteDialog on purpose. DeleteDialog still serves racks, rooms and plans, which
 *  really are destroyed, and its copy and typed-code gate belong to that. Archiving is reversible,
 *  so it neither threatens nor gates: a confirmation that costs as much as a destructive one just
 *  teaches people to type through both. */

const KIND_LABEL: Record<"client" | "site" | "floor", string> = {
  client: "client",
  site: "site",
  floor: "floor",
};

export interface ArchiveDialogProps {
  kind: "client" | "site" | "floor";
  code: string;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ArchiveDialog({ kind, code, error, busy, onConfirm, onCancel }: ArchiveDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-label={`Archive ${KIND_LABEL[kind]}`}
    >
      <div data-testid="archive-dialog" className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-base font-bold">
          Archive {KIND_LABEL[kind]} &ldquo;{code}&rdquo;?
        </h3>
        <p className="mt-2 text-sm text-neutral-600">
          It stops appearing in the app but keeps all of its data, and can be restored from Settings
          → Archive.
        </p>
        {error && (
          <p data-testid="archive-error-message" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="archive-cancel"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="archive-confirm"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            Archive
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/vitest run src/features/clients/ArchiveDialog.test.tsx`
Expected: PASS, 5 tests

- [ ] **Step 5: Repoint the three call sites**

In `src/features/clients/ClientsTable.tsx`: import `ArchiveDialog` and `archiveClientAction`; change the delete trash button's tip to `"Archive client"`; replace the `<DeleteDialog … kind="client" …>` block with `<ArchiveDialog kind="client" code={deleteTarget.code} error={deleteError} busy={busy} onConfirm={…} onCancel={…} />`, and have `onConfirm` call `archiveClientAction` instead of `deleteClientAction`. Remove the now-unused `counts={{…}}` prop and the `DeleteDialog` import if nothing else in the file uses it.

In `src/features/clients/ClientDetail.tsx`: the same change for sites — tip `"Archive site"`, `archiveSiteAction`, `ArchiveDialog kind="site"`.

In `src/features/clients/SiteDetail.tsx`: the same for floors — the `delete-floor` IconButton's tip becomes `"Archive floor"`, and the floor `DeleteDialog` (currently `kind="floor"` with `counts={floorDeleteCounts}`) becomes `ArchiveDialog kind="floor"` calling `archiveFloorAction`. Leave every other `DeleteDialog` in this file (rack, room, plan) exactly as it is.

- [ ] **Step 6: Update the two affected test files**

In `src/features/clients/ClientsTable.test.tsx` and `src/features/clients/ClientDetail.test.tsx`, any test that asserted the delete flow now asserts the archive flow: the confirm button is `archive-confirm`, there is no typed-code field, and the action called is `archiveClientAction` / `archiveSiteAction`. Update the module mocks to include the archive actions.

- [ ] **Step 7: Run the full suite**

Run: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
Expected: every file passes.

- [ ] **Step 8: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no output

- [ ] **Step 9: Commit**

```bash
git add src/features/clients/ArchiveDialog.tsx src/features/clients/ArchiveDialog.test.tsx src/features/clients/ClientsTable.tsx src/features/clients/ClientDetail.tsx src/features/clients/SiteDetail.tsx src/features/clients/ClientsTable.test.tsx src/features/clients/ClientDetail.test.tsx
git commit -m "$(cat <<'MSG'
Deleting a client, site or floor now archives it

The three trash controls call the archive actions, behind a dialog that neither
threatens nor gates: the old copy claimed "This will permanently delete 31 sites,
1 rack and 23 devices", which after this change is simply false.

ArchiveDialog is separate from DeleteDialog rather than a mode of it.
DeleteDialog still serves racks, rooms and plans, which really are destroyed,
and its typed-code gate belongs to that. Tests assert the archive copy says
"restored" and never says "delete".

This is the last step of G1 and the one that changes behaviour: from here,
deleting these three things stops destroying them.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: Live verification on a throwaway client

**Files:** none — this task changes no code.

**Interfaces:**
- Consumes: everything above.
- Produces: evidence, and a ledger entry.

- [ ] **Step 1: Confirm the backups exist before touching anything**

Run: `ls -lh ~/backups/network-doc-platform/`
Expected: a `db-*.sql` of roughly 600K and a `storage-*` directory. If either is missing, take them again before continuing:
```bash
docker exec supabase_db_network-doc-platform pg_dump -U postgres -d postgres > ~/backups/network-doc-platform/db-$(date +%Y%m%d-%H%M%S).sql
docker cp supabase_storage_network-doc-platform:/mnt/stub ~/backups/network-doc-platform/storage-$(date +%Y%m%d-%H%M%S)
```

- [ ] **Step 2: Create a throwaway client, site and floor**

In the running app, create a client `ZZTEST` with a site and one floor. **Do not use `URI` for any part of this task.**

- [ ] **Step 3: Record the "before" state**

Run:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -t -A -F'|' -c "select code, archived_at is null as live from clients order by code;"
```
Expected: every row `live` = `t`.

- [ ] **Step 4: Archive the throwaway client and verify it hides**

Archive `ZZTEST` from the clients directory. Then confirm:
- it is gone from `/` (the dashboard) and its counts are out of the totals
- it is gone from `/clients`
- `/clients/ZZTEST` returns 404
- the row still exists and its children are untouched:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -t -A -F'|' -c "select c.code, c.archived_at is not null as archived, (select count(*) from sites s where s.client_id=c.id) as sites from clients c where c.code='ZZTEST';"
```
Expected: `ZZTEST|t|1` — archived, and its site still there.

- [ ] **Step 5: Restore it and verify everything comes back**

Restore from `/settings/archive`, then confirm `ZZTEST` is back on the dashboard and `/clients/ZZTEST` renders with its site and floor intact.

- [ ] **Step 6: Confirm the real data was never touched**

Run:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -t -A -F'|' -c "select (select count(*) from clients where archived_at is null), (select count(*) from sites), (select count(*) from rooms), (select count(*) from floor_devices), (select count(*) from floor_plans);"
```
Expected: `2|31|11|19|2` — unchanged from before the slice.

- [ ] **Step 7: Record the outcome in the ledger**

Append what was verified to `.superpowers/sdd/progress.md` (gitignored): the counts above, and that the throwaway client was archived and restored with its children intact.

- [ ] **Step 8: Delete the throwaway client**

Permanent deletion is not built in G1, so remove it directly:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "delete from clients where code='ZZTEST';"
```

- [ ] **Step 9: Commit the ledger note if anything else changed**

If tasks 1–6 left the tree clean, there is nothing to commit here and that is the expected outcome.

---

## Self-Review

**Spec coverage.** §3 data model → Task 1. §4 hiding and the two deliberate non-filters → Task 3 steps 2 and 4. §4 "delete becomes archive" and the non-threatening copy → Task 6. §5 archive page, nesting, Settings sub-nav, no permanent delete → Tasks 2 and 5. §6 the bite cases → Task 2's tests (ancestor rules) and Task 3's integration tests (children untouched). §7 testing → Tasks 2, 4, 5, 6 and the live bar in Task 7.

**One spec item deliberately deferred within this slice:** §3's "the create action catches the constraint violation and says the code belongs to an archived record". The existing `friendly()` helper already turns a unique-violation into a readable message; improving its wording to name the archive is a one-line change with no behavioural risk, and belongs with G2 where purging becomes the remedy it would point at. Noted here so it is not mistaken for an oversight.

**Placeholders:** none. Every code step carries its code; Task 6 step 5 describes edits to three existing files by exact prop and identifier rather than pasting three large components, which is the one place a diff would be less clear than instructions.

**Type consistency:** `ArchiveTree`, `ArchivedClient`, `ArchivedSite`, `ArchivedFloor` are defined in Task 2 and consumed unchanged in Tasks 3 and 5. `listArchived`'s return type matches `buildArchiveTree`'s parameter exactly, so `buildArchiveTree(await listArchived(db))` in Task 5 step 5 typechecks. Action names are consistent between Tasks 4, 5 and 6.
