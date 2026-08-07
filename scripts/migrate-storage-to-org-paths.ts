/** Moves every stored object under its organisation's prefix, and updates the rows that point at
 *  them. Run once, after the migrations.
 *
 *  What "verify" means here, precisely — the header used to claim "verify-then-delete, never the
 *  reverse" while nothing was verified at all. There is no delete: `move` is a single atomic
 *  Storage operation, so nothing is ever removed by this script. What is verified is the
 *  destination: the source bytes are read and hashed BEFORE the move, and the object at the new
 *  path is read back and hashed AFTER it. The row is updated only once that readback matches, so a
 *  row can never be pointed at an object this script has not itself read at the new path. This is
 *  the spec's "verifies the new object is readable and byte-identical, and only then removes the
 *  old one", allowing for the fact that `move` does the removing.
 *
 *  Re-runnable, and resumable mid-failure — which is the whole point. The dangerous state is a
 *  successful move followed by a failed row update: the object exists only at the new path while
 *  the row still names the old one. An earlier version died on exactly that row on every
 *  subsequent run, because `move` cannot find a source that is already gone. Now a missing source
 *  whose destination reads back correctly is recognised as "a previous run already moved this",
 *  and the row update is simply retried.
 *
 *  One bad row does not end the run. Failures are collected, reported together at the end, and set
 *  a non-zero exit code — an object that cannot be read must not take the rest of the migration
 *  (including the entire avatars pass) down with it.
 *
 *  It also REPORTS, and never touches, objects sitting in a bucket that no row points at. Walking
 *  rows alone leaves those unprefixed and therefore unownable once slice 2's storage policies key
 *  on the first path segment. Deleting a user's objects is not this script's call — a live example
 *  is a plan whose floor row was deleted, which is data loss if guessed wrong and a one-line
 *  cleanup if the operator decides it.
 *
 *  Usage: npx tsx scripts/migrate-storage-to-org-paths.ts [--dry-run]
 */
import { createClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";

const DRY_RUN = process.argv.includes("--dry-run");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const db = createClient(url, key);

const PLANS_BUCKET = "floor-plans";
const AVATARS_BUCKET = "avatars";

/** Every failure is recorded rather than thrown, so the run continues and the operator sees the
 *  whole picture at once instead of the first row that went wrong. */
const failures: string[] = [];
function fail(what: string, reason: string): void {
  failures.push(`${what}: ${reason}`);
  console.error(`  FAILED ${what}: ${reason}`);
}

/** Every path any row names, before or after this run. The orphan pass diffs the buckets against
 *  this, so it must include both — under --dry-run the rows still hold their old paths, and after a
 *  real run they hold the new ones. */
const referencedPlanPaths = new Set<string>();
const referencedAvatarPaths = new Set<string>();

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads an object's bytes, or null when it is not there / not readable. Never throws: "not
 *  readable" is an answer this script acts on, not an error it aborts over. */
async function read(bucket: string, path: string): Promise<Uint8Array | null> {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) return null;
  return new Uint8Array(await data.arrayBuffer());
}

/** What the caller should do with the row afterwards — deliberately not a boolean "did it work",
 *  because "already correct, leave it alone" and "failed, leave it alone" are both non-updates and
 *  conflating them is how the first version ended up unable to resume. */
type RowAction = "update-row" | "leave-row";

/** Move one object and prove the result, tolerating every partial state a previous run can leave. */
async function moveVerified(bucket: string, from: string, to: string): Promise<RowAction> {
  const label = `${bucket}: ${from} -> ${to}`;

  if (from === to) {
    // Already at its destination — the ordinary re-run case, and not a failure. Still verified: a
    // row naming an object that cannot be read is worth surfacing here rather than turning up as a
    // broken image in the app later.
    if (await read(bucket, to)) return "leave-row";
    fail(`${bucket}: ${to}`, "row is already at its destination but no object is readable there");
    return "leave-row";
  }

  console.log(`${DRY_RUN ? "[dry-run] " : ""}${label}`);
  if (DRY_RUN) return "leave-row";

  const before = await read(bucket, from);

  if (!before) {
    // The resumable case: a previous run moved the object and then failed to update the row. The
    // source is legitimately gone. If the destination reads back, this is not an error at all —
    // finish the job by letting the caller update the row.
    if (await read(bucket, to)) {
      console.log(`  already moved by an earlier run — updating the row only`);
      return "update-row";
    }
    fail(label, "source is not readable and nothing is at the destination either");
    return "leave-row";
  }

  const { error: moveErr } = await db.storage.from(bucket).move(from, to);
  if (moveErr) {
    fail(label, `move failed: ${moveErr.message}`);
    return "leave-row";
  }

  const after = await read(bucket, to);
  if (!after) {
    fail(label, "move reported success but the object is not readable at the destination");
    return "leave-row";
  }
  if (sha256(after) !== sha256(before)) {
    fail(label, `bytes differ after the move (${before.length} -> ${after.length} bytes)`);
    return "leave-row";
  }

  return "update-row";
}

interface FloorPlanJoinRow {
  id: string;
  org_id: string;
  floor_id: string;
  storage_path: string | null;
  pdf_storage_path: string | null;
  floors: { site_id: string } | null;
}

async function movePlans(): Promise<void> {
  const { data, error } = await db
    .from("floor_plans")
    .select("id, org_id, floor_id, storage_path, pdf_storage_path, floors(site_id)");
  if (error) {
    fail("movePlans", error.message);
    return;
  }

  const rows = (data ?? []) as unknown as FloorPlanJoinRow[];
  for (const row of rows) {
    const siteId = row.floors?.site_id;
    if (!siteId) {
      console.warn(`floor_plan ${row.id}: no site, skipped`);
      continue;
    }
    for (const [column, ext] of [["storage_path", "png"], ["pdf_storage_path", "pdf"]] as const) {
      const from = row[column];
      if (!from) continue;
      // Must match planPathFor(orgId, siteId, floorId, ext) exactly — the app reads storage_path
      // from the row, so a path this script invents that the app would never build produces a
      // missing plan rather than an error.
      const to = `${row.org_id}/${siteId}/${row.floor_id}.${ext}`;
      referencedPlanPaths.add(from);
      referencedPlanPaths.add(to);

      if ((await moveVerified(PLANS_BUCKET, from, to)) === "leave-row") continue;

      const { error: updErr } = await db.from("floor_plans").update({ [column]: to }).eq("id", row.id);
      // The object is at `to` and verified; only the row is behind. Reported, not thrown — the next
      // run finds the source gone and the destination readable, and retries just this update.
      if (updErr) fail(`floor_plans.${column} for ${row.id}`, `object moved but row update failed: ${updErr.message}`);
    }
  }
}

async function moveAvatars(): Promise<void> {
  const { data, error } = await db.from("members").select("id, org_id, avatar_path");
  if (error) {
    fail("moveAvatars", error.message);
    return;
  }

  for (const row of data ?? []) {
    const from = row.avatar_path as string | null;
    if (!from) continue;
    const to = `${row.org_id}/${row.id}/avatar`;
    referencedAvatarPaths.add(from);
    referencedAvatarPaths.add(to);

    if ((await moveVerified(AVATARS_BUCKET, from, to)) === "leave-row") continue;

    const { error: updErr } = await db.from("members").update({ avatar_path: to }).eq("id", row.id);
    if (updErr) fail(`members.avatar_path for ${row.id}`, `object moved but row update failed: ${updErr.message}`);
  }
}

/** Every object in a bucket, depth-first. Storage's `list` returns one directory level at a time and
 *  marks a prefix (rather than an object) with a null `id`, so the tree has to be walked. */
async function listAllObjects(bucket: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  const pageSize = 100;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.storage.from(bucket).list(prefix, { limit: pageSize, offset });
    if (error) {
      fail(`list ${bucket}/${prefix}`, error.message);
      return found;
    }
    const entries = data ?? [];
    for (const entry of entries) {
      // Storage synthesises this zero-byte object to keep an otherwise-empty prefix visible. It is
      // not a user's file and reporting it as an orphan would be noise.
      if (entry.name === ".emptyFolderPlaceholder") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      // A null id marks a prefix rather than an object — `list` returns one directory level only.
      if (entry.id === null) found.push(...(await listAllObjects(bucket, path)));
      else found.push(path);
    }
    if (entries.length < pageSize) break;
  }
  return found;
}

/** Reports, never deletes. An object no row names cannot be given an owner by walking rows, so
 *  after this migration it is the one thing left sitting outside the org prefixes. */
async function reportOrphans(bucket: string, referenced: Set<string>): Promise<void> {
  const objects = await listAllObjects(bucket);
  const orphans = objects.filter((p) => !referenced.has(p)).sort();
  if (orphans.length === 0) {
    console.log(`${bucket}: no orphaned objects`);
    return;
  }
  console.log(`${bucket}: ${orphans.length} object(s) that no row points at — NOT moved, NOT deleted:`);
  for (const p of orphans) console.log(`  ${p}`);
  console.log(
    `  These stay outside the organisation prefixes. Decide per object: an object under a floor or\n` +
    `  member that no longer exists can be removed by hand, but this script will not guess.`
  );
}

// No top-level await: this package.json has no "type": "module", so tsx transpiles this file to
// CJS, which cannot support it — same reason scripts/backfill-geocode.ts wraps its body in main().
async function main(): Promise<void> {
  await movePlans();
  await moveAvatars();

  // After the moves, so the rows name their final paths. Both sets already hold the old and new
  // path of everything this run touched, so a row that failed to update is not miscounted as an
  // orphan either way.
  const { data: planRows } = await db.from("floor_plans").select("storage_path, pdf_storage_path");
  for (const r of planRows ?? []) {
    if (r.storage_path) referencedPlanPaths.add(r.storage_path as string);
    if (r.pdf_storage_path) referencedPlanPaths.add(r.pdf_storage_path as string);
  }
  const { data: memberRows } = await db.from("members").select("avatar_path");
  for (const r of memberRows ?? []) {
    if (r.avatar_path) referencedAvatarPaths.add(r.avatar_path as string);
  }

  await reportOrphans(PLANS_BUCKET, referencedPlanPaths);
  await reportOrphans(AVATARS_BUCKET, referencedAvatarPaths);

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s) — nothing else was aborted because of them:`);
    for (const f of failures) console.error(`  ${f}`);
    console.error("Fix the cause and re-run: everything already moved and verified is skipped.");
    process.exitCode = 1;
    return;
  }

  console.log(DRY_RUN ? "dry run complete — nothing was moved" : "storage migration complete");
}

main().catch((e) => {
  console.error("migrate-storage-to-org-paths: fatal error", e);
  process.exitCode = 1;
});
