"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SiteSummary } from "./repository";
import { locateSiteAction } from "./actions";
import { isAddressGeocodable, VAGUE_ADDRESS_HINT } from "./geocodeOps";
import { isMappable } from "./sitesMapOps";

/** `not_found` covers THREE different situations underneath, and the copy must tell the user what
 *  to DO next rather than asserting which one happened:
 *   1. No address on file at all — nothing was ever searchable.
 *   2. An address that failed the `isAddressGeocodable` pre-flight (see geocodeOps.ts) — vague,
 *      missing a locality, etc. No request was ever sent, so VAGUE_ADDRESS_HINT is exactly right
 *      here. Calling the SAME exported predicate the geocoder itself gates on (rather than
 *      re-implementing or copying its threshold) is the point: the UI's idea of "vague" can never
 *      drift from the geocoder's.
 *   3. An address that passed the pre-flight and was genuinely sent to Nominatim, which found
 *      nothing for it. The address itself is plausible (city/state/zip and all) — Nominatim just
 *      couldn't match the specific building. Telling the user to add a city is actively wrong
 *      here; the real fixes are trimming suite/floor numbers or fixing typos. */
function statusText(site: SiteSummary): string {
  switch (site.geocodeStatus) {
    case "pending":
      return "Not yet located";
    case "not_found": {
      const address = (site.address ?? "").trim();
      if (address.length === 0) {
        return "No address on file — add one so this site can be mapped.";
      }
      if (!isAddressGeocodable(site.address)) {
        return VAGUE_ADDRESS_HINT;
      }
      return "We couldn't find this address on the map — try removing the suite or floor, or check it for typos.";
    }
    case "failed":
      return "Couldn't be located — try again";
    default:
      return "";
  }
}

/** The sites that could NOT be placed on the map. This is the spec's single most important
 *  surface: a site that fails geocoding must stay visible and actionable here, never silently
 *  disappear because the map couldn't plot it. Uses `isMappable` (the same predicate `toBlips`
 *  filters on in sitesMapOps.ts) so the two surfaces are complements by construction — a site is
 *  either plotted on the map or listed here, never neither. Renders nothing at all when every site
 *  is mappable (or the list is empty) so a fully-located client never gets a stray empty panel. */
export function UnlocatedSites({ sites }: { sites: SiteSummary[] }) {
  const router = useRouter();
  const [locatingId, setLocatingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const unlocated = sites.filter((s) => !isMappable(s));
  if (unlocated.length === 0) return null;

  async function handleLocate(site: SiteSummary) {
    setLocatingId(site.id);
    setErrors((prev) => {
      const next = { ...prev };
      delete next[site.id];
      return next;
    });

    const formData = new FormData();
    formData.set("siteId", site.id);
    const res = await locateSiteAction(formData);

    setLocatingId(null);
    if (!res.ok) {
      setErrors((prev) => ({ ...prev, [site.id]: res.error ?? "Locate failed" }));
      return;
    }
    router.refresh();
  }

  const heading =
    unlocated.length === 1
      ? "1 site isn't on the map yet"
      : `${unlocated.length} sites aren't on the map yet`;

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="px-5 py-4">
        <h2 className="text-lg font-bold text-neutral-900">{heading}</h2>
      </div>
      <ul>
        {unlocated.map((site) => (
          <li
            key={site.id}
            data-testid={`unlocated-site-${site.code}`}
            className="flex items-center justify-between gap-4 border-t border-neutral-100 px-5 py-3"
          >
            <div>
              <p className="text-sm font-medium text-neutral-900">
                {site.name} <span className="text-neutral-500">({site.code})</span>
              </p>
              <p className="text-sm text-neutral-600">{statusText(site)}</p>
              {errors[site.id] && (
                <p className="text-sm text-red-600">{errors[site.id]}</p>
              )}
            </div>
            <button
              type="button"
              data-testid={`locate-${site.code}`}
              disabled={locatingId === site.id}
              onClick={() => handleLocate(site)}
              className="h-9 shrink-0 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-[#376ad9] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {locatingId === site.id ? "Locating…" : "Locate"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
