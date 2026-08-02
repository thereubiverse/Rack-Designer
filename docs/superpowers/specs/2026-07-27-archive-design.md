# Archive & Restore (Slice G1) — Design

## 1. Why

Deletion here is one click with an enormous blast radius. `racks.room_id` is `ON DELETE CASCADE NOT
NULL`, and the chain runs clients → sites → floors → rooms → racks → devices. Deleting one client
destroys 31 sites, every floor plan under them, every traced room and every placed device, with no
way back. The user named this as the emergency worth designing for, in preference to bulk-operation
undo or a general change feed.

There is a second, unrelated reason that makes an archive the right shape rather than an undo: when
a client contract ends, the data should be **kept for records** while disappearing from the working
app. Archive serves both, which a time-boxed undo would not.

## 2. Scope

**This spec is archive and restore only.** Clients, sites and floors become soft-deletable and
restorable from one page under Settings. **Permanent deletion is NOT in this slice** — it is
[Slice G2](./2026-07-27-archive-purge-design.md).

The split is deliberate and is the whole point of the ordering: every step below leaves the system
safer than it found it, and the only genuinely destructive code in the feature arrives afterwards,
once the recovery path already exists and has been exercised. Shipping G1 alone is a strict
improvement — deletes stop destroying — and "we cannot purge yet" is a far better problem to have
than "purge had a bug".

**Build order within this slice**, for the same reason:

1. Migration — additive, touches no existing row.
2. Repository filtering and the archive/restore actions, with the delete buttons LEFT ALONE. Nothing
   user-visible changes; nothing can go missing.
3. The archive page with Restore. Recovery exists and is proven before anything can use it.
4. Only then, repoint the delete controls to archive.

A general "log every change" feed is **not** built. It was the original framing, but the emergency
is destruction and an archive addresses that directly. A change feed remains a separate slice; the
Activity Log nav item stays inert.

**Rooms, racks and individual devices stay hard deletes.** Their blast radius is small, they are
deleted routinely during normal editing, and archiving them would fill the archive with noise.

## 3. Data model — `0016_archive.sql`

```sql
alter table clients add column archived_at timestamptz;
alter table sites   add column archived_at timestamptz;
alter table floors  add column archived_at timestamptz;

-- Partial indexes: the archive page reads the rare archived rows, and every list query filters on
-- `archived_at is null`, which a partial index on the non-null side does not help. These exist for
-- the archive page, which is why they are partial.
create index clients_archived_idx on clients (archived_at) where archived_at is not null;
create index sites_archived_idx   on sites   (archived_at) where archived_at is not null;
create index floors_archived_idx  on floors  (archived_at) where archived_at is not null;
```

Every migration ends with the three blanket grant statements from `0001`'s tail, byte-identical.

**Nothing is added below floors.** Archiving a floor leaves its rooms, racks, devices, plans and
wall geometry exactly as they are. That is what makes a restore *exact* rather than reconstructed —
row ids survive, so `racks.room_id`, `floor_devices.floor_id` and the storage paths that embed site
and floor ids all keep pointing at live rows.

**Codes stay reserved.** `clients.code` is `UNIQUE`; `sites` is `UNIQUE (client_id, code)`; `floors`
is `UNIQUE (site_id, code)`. An archived row keeps its code, so creating a new `URI` while an
archived `URI` exists fails — deliberately. The create action catches the constraint violation and
says the code belongs to an archived record, with a link to the archive. Suffixing archived codes to
free the namespace would corrupt the very record being kept.

## 4. Behaviour

### Delete becomes Archive

The trash control on the clients directory, the client page's sites table, and the floor tabs
archives instead of deleting.

**The confirmation stops threatening.** Today it reads *"This will permanently delete 31 sites, 1
rack and 23 devices"* — after this change that is simply false. It becomes "Archive URI? It stops
appearing in the app and can be restored from Settings → Archive." The type-the-code gate is
dropped for archiving: the action is reversible, and a confirmation that costs as much as a
destructive one teaches people to type through it.

### Hiding is transitive, and mostly free

Every query that **lists** clients, sites or floors filters `archived_at is null`:

- `listClients`, `listSites`, `listFloors` (`locations/repository.ts`)
- the sites map and unlocated-sites lists, which read through `listSites`

Queries that resolve a **single** row by code or id for a page render return null for archived rows,
so `/clients/URI` and a site page 404 once archived.

Two categories are deliberately **not** filtered:

- **Cascade counters** (`countSiteCascade`, `countClientCascade`) — they answer "what does
  permanently deleting this destroy", and an archived child is still destroyed.
- **Scope resolvers** (`racks/siteScope.ts`, `getRackBreadcrumb`) — they walk *upward* from a row
  that was reached some other way. Filtering there would break a page rather than hide a listing.

An archived client's sites need no flags of their own: their only route in is the client page, which
404s.

### Permanent delete — NOT in this slice

Nothing in G1 destroys anything. Until [G2](./2026-07-27-archive-purge-design.md) lands, purging an
archived record is a database operation, not a product feature.

**The cost of that, stated plainly:** an archived code stays reserved with no way to release it. If
`URI` is archived, creating a new client called `URI` fails until it is restored. That is the right
trade for this slice — a blocked create is recoverable in seconds, a bad purge is not.

## 5. The archive page

At **`/settings/archive`**, reached from the Settings sub-nav, which gains a "Data" group above the
existing "Features". The sub-nav's items become links (today "Device Wizard" is a static `<span>`).

Three levels, nested by ownership:

- **Archived clients** — name, code, when archived, and what is inside (sites / racks / devices).
- **Archived sites** — nested under their client's name.
- **Archived floors** — nested under client → site.

Each row offers **Restore**. "Delete permanently" arrives with G2 and is deliberately absent here —
a destructive control on a page whose restore path has not yet been exercised in anger is exactly
the thing this ordering avoids.

**A row appears only if its ancestors are live.** An archived site whose client is also archived is
not listed separately, and neither is a floor under an archived site — restoring one alone would put
it back somewhere still invisible, which reads as a broken restore. They return with their ancestor.

## 6. Cases that will bite

| Case | Behaviour |
|---|---|
| Restore a site whose client is live | Reappears immediately, with every floor, plan and device |
| Restore a site whose client is archived | Cannot arise — not listed separately (§5) |
| Archive a client, restore it later | Sites/floors archived *individually beforehand* stay archived. Independent flags, no memory of ordering |
| Create a client reusing an archived code | Fails with a message naming the archive, not a raw constraint error |
| Archived client's counts | Excluded from the dashboard, its cards and its totals — `listClients` filters |

## 7. Testing

- **Pure** (`archiveOps.ts`): the nesting rule — given archived clients, sites and floors plus their
  ancestry, produce the page's tree, omitting rows whose ancestor is archived. This is the only real
  logic in the slice, and it is worth isolating from both React and the database.
- **Actions**, DB-free with recorded arguments: archive sets `archived_at` and — the assertion that
  matters — never calls a delete; restore clears it.
- **Repository**, in the existing integration suite: list queries exclude archived rows; by-code
  lookups return null for them; cascade counters still count archived children.
- **Live, the acceptance bar**: exercised on a THROWAWAY client created for the purpose, never on
  real data. Archive it, confirm it leaves the dashboard, the clients directory and the sites map,
  restore it, and confirm its sites, floors, plans and devices are intact and unchanged.
- A `pg_dump` of the database and a copy of the storage bucket are taken before any of this runs.
  Both live outside the repository: `~/backups/network-doc-platform/`.
- Tests run by EXPLICIT FILENAME or `--exclude '**/*.integration.test.ts'` — the integration files
  wipe the local database.

## 8. Out of scope

Permanent deletion and storage cleanup — [Slice G2](./2026-07-27-archive-purge-design.md). A change
feed of every edit (the original "activity log" framing). Archiving rooms, racks or individual
devices. Bulk restore. Retention policies or auto-purge. Attribution of who archived what — there is no auth yet (`createServiceClient`: "Phase 1 uses the service role because there is
no auth yet"), so the archive records *when*, not *who*, and gains the actor for free when auth
lands.
