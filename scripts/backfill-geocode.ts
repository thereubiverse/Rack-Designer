/**
 * One-off backfill: geocodes every site whose geocode_status is still "pending".
 *
 * Runs outside Next.js, so process.env is not populated by the framework the way it is for the
 * app or for vitest — load .env.local the same way vitest.config.ts does. Note that ESM hoists
 * imports, so every imported module below is already evaluated by the time this line runs — this
 * works not because loadEnv() runs "before the imports" (it doesn't) but because
 * createServiceClient() reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from
 * process.env inside its own function body, called later from main(), rather than at module
 * scope.
 *
 * Requests are strictly sequential with a 1100ms sleep BETWEEN calls (never Promise.all) to stay
 * under Nominatim's ~1 req/sec policy — breaching it risks the app's IP getting blocked.
 *
 * Usage: npm run backfill:geocode   (equivalent to: npx tsx scripts/backfill-geocode.ts)
 */
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local", quiet: true });

import { createServiceClient } from "@/lib/supabase/server";
import { geocodeAddress } from "@/features/clients/geocode";
import { setSiteGeocode } from "@/features/clients/repository";
import type { SiteRow } from "@/lib/supabase/types";

const SLEEP_MS = 1100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const db = createServiceClient();

  const { data, error } = await db
    .from("sites")
    .select("*")
    .eq("geocode_status", "pending")
    .order("code", { ascending: true });
  if (error) throw new Error(`backfill-geocode: ${error.message}`);

  const sites = (data ?? []) as SiteRow[];
  console.log(`backfill-geocode: found ${sites.length} pending site(s)`);

  let ok = 0;
  let notFound = 0;
  let failed = 0;
  let errored = 0;

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];

    // This is a single ~35-second unattended run over every pending site. One bad site (a
    // transient DB blip, an unexpected geocodeAddress/setSiteGeocode throw) must not abandon
    // every remaining site — log it and move on to the next one.
    try {
      const result = await geocodeAddress(site.address);
      await setSiteGeocode(db, site.id, result);

      if (result.status === "ok") ok++;
      else if (result.status === "not_found") notFound++;
      else failed++;

      console.log(
        `[${i + 1}/${sites.length}] ${site.code}: ${result.status}` +
          (result.status === "failed" ? ` (${result.error})` : "")
      );
    } catch (e) {
      errored++;
      console.error(
        `[${i + 1}/${sites.length}] ${site.code}: errored — ${e instanceof Error ? e.message : e}`
      );
    }

    // Sleep between calls, not after the last one, and never in parallel with the next request.
    // This still runs on the error path — the rate limit applies regardless of outcome.
    if (i < sites.length - 1) await sleep(SLEEP_MS);
  }

  console.log(
    `backfill-geocode: done — ok=${ok} not_found=${notFound} failed=${failed} errored=${errored}`
  );
}

main().catch((e) => {
  console.error("backfill-geocode: fatal error", e);
  process.exitCode = 1;
});
