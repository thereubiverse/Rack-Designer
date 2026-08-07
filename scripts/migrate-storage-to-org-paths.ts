/** Moves every stored object under its organisation's prefix, and updates the rows that point at
 *  them. Run once, after the migrations. Re-runnable: an object already at its new path is skipped.
 *
 *  Verify-then-delete, never the reverse — `move` is atomic in the Storage API, but the database
 *  update that follows is not part of it, so the row is updated only after the move returns
 *  successfully, and a failure leaves the object findable at one path or the other.
 *
 *  Usage: npx tsx scripts/migrate-storage-to-org-paths.ts [--dry-run]
 */
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const db = createClient(url, key);

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
  if (error) throw new Error(`movePlans: ${error.message}`);

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
      if (from === to) continue;
      console.log(`${DRY_RUN ? "[dry-run] " : ""}floor-plans: ${from} -> ${to}`);
      if (DRY_RUN) continue;
      const { error: moveErr } = await db.storage.from("floor-plans").move(from, to);
      if (moveErr) throw new Error(`move ${from}: ${moveErr.message}`);
      const { error: updErr } = await db.from("floor_plans").update({ [column]: to }).eq("id", row.id);
      if (updErr) throw new Error(`update floor_plans.${column} for ${row.id}: ${updErr.message}`);
    }
  }
}

async function moveAvatars(): Promise<void> {
  const { data, error } = await db.from("members").select("id, org_id, avatar_path");
  if (error) throw new Error(`moveAvatars: ${error.message}`);

  for (const row of data ?? []) {
    const from = row.avatar_path as string | null;
    if (!from) continue;
    const to = `${row.org_id}/${row.id}/avatar`;
    if (from === to) continue;
    console.log(`${DRY_RUN ? "[dry-run] " : ""}avatars: ${from} -> ${to}`);
    if (DRY_RUN) continue;
    const { error: moveErr } = await db.storage.from("avatars").move(from, to);
    if (moveErr) throw new Error(`move ${from}: ${moveErr.message}`);
    const { error: updErr } = await db.from("members").update({ avatar_path: to }).eq("id", row.id);
    if (updErr) throw new Error(`update members.avatar_path for ${row.id}: ${updErr.message}`);
  }
}

// No top-level await: this package.json has no "type": "module", so tsx transpiles this file to
// CJS, which cannot support it — same reason scripts/backfill-geocode.ts wraps its body in main().
async function main(): Promise<void> {
  await movePlans();
  await moveAvatars();
  console.log(DRY_RUN ? "dry run complete — nothing was moved" : "storage migration complete");
}

main().catch((e) => {
  console.error("migrate-storage-to-org-paths: fatal error", e);
  process.exitCode = 1;
});
