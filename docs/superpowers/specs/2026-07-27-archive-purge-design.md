# Permanent Delete from the Archive (Slice G2) — Design

**Depends on [Slice G1](./2026-07-27-archive-design.md), and deliberately follows it.** G1 makes
deletion recoverable. This slice is the only genuinely destructive code in the feature, and it is
built last so that the recovery path already exists and has been used before anything can bypass it.

## 1. Why this is separate

Everything in G1 is additive or reversible. Everything here permanently destroys data, including
files that no backup inside the app can recover. Bundling the two would mean the first release that
lets you archive is also the first release that can wipe a client — with the purge path having had
exactly as much real use as the restore path, which is none.

There is also a real reason to want it: an archive with no exit fills up, and a client whose
contract ended years ago should eventually be removable. Until this ships, purging is a database
operation.

## 2. What it does

One control, **Delete permanently**, on each row of `/settings/archive`. Available only for archived
records — nothing live can be permanently deleted from anywhere in the app.

Two things happen, in this order:

1. **Storage objects are removed** for every floor plan beneath the record.
2. **The row is deleted**, and Postgres cascades the rest.

Storage first, deliberately. If storage removal fails the row is still there, the record is still
archived, and the operation can be retried. Deleting the row first and then failing on storage would
leave files with nothing left in the database that names them — unreachable and unattributable.

## 3. Storage cleanup — the dangerous part

Plans live in the `floor-plans` bucket at paths that embed site and floor ids, and today **nothing**
cleans them up on delete: only explicit plan deletion or replacement calls `removePlanObject` /
`removePlanPdf`. So deleting a client already orphans its PDFs and PNGs permanently. This slice
fixes that as part of doing the deletion honestly.

**Paths are enumerated, never prefixed.** The implementation collects the floors beneath the record,
reads `floor_plans.storage_path` and `floor_plans.pdf_storage_path` row by row, and removes exactly
those objects.

A prefix delete on `SITE-A/` would be shorter and is how you take out a neighbouring site's files:
paths are grouped by site id, so one wrong prefix reaches data belonging to a record nobody asked to
delete. That shape must not appear in this code.

**A missing object is not an error.** Storage and database can already disagree — a failed upload,
an interrupted replace — and refusing to purge because a file is already gone would strand the
record permanently. Removal treats "not found" as success and continues.

## 4. Confirmation

Keeps the type-the-code gate that delete has today, because this is the one place it is warranted.

The warning states what will be destroyed using the cascade counters, which now include floor
devices — so it reads *"31 sites, 1 rack and 23 devices"* rather than the *"4 devices"* it would
have claimed before that fix. It also names the plan files, since those are invisible in the app's
own listings and are the part a user is least likely to have pictured.

## 5. Testing

- **Actions**, DB-free with recorded arguments: purge calls storage removal for **every** plan path
  beneath the record before it calls delete, and calls delete exactly once. A test asserts the
  ORDER, since it is the property that makes a failure retryable.
- Purge refuses a record that is **not archived** — the only route to destruction is through the
  archive, and a live id arriving at this action means something upstream is wrong.
- Storage removal tolerates a missing object and still deletes the row.
- **Live, the acceptance bar**: on a THROWAWAY client with a real uploaded plan, never on real data.
  Purge it; confirm the rows are gone, the bucket no longer holds its objects, and — the assertion
  that matters — a neighbouring client's plan files are still present, byte for byte.
- A `pg_dump` and a copy of the storage bucket are taken before any live exercise. Both live outside
  the repository: `~/backups/network-doc-platform/`.
- Tests run by EXPLICIT FILENAME or `--exclude '**/*.integration.test.ts'` — the integration files
  wipe the local database.

## 6. Out of scope

Bulk purge, or any "empty the archive" control — every destruction is one record, chosen
deliberately. Scheduled or automatic purging after a retention period: a background job that deletes
client data unattended is a much larger decision than this slice, and needs a policy behind it
rather than a default. Undo of a purge; there is none, which is the point of the gate.
