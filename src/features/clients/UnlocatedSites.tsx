"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SiteSummary } from "./repository";
import { locateSiteAction } from "./actions";
import { VAGUE_ADDRESS_HINT } from "./geocodeOps";

/** `not_found` covers two different situations underneath (no address at all, and an address that
 *  was searched but matched nothing) — the copy below is worded to make sense in both, and to tell
 *  the user what to DO next rather than asserting which of the two happened. */
function statusText(status: SiteSummary["geocodeStatus"]): string {
  switch (status) {
    case "pending":
      return "Not yet located";
    case "not_found":
      return VAGUE_ADDRESS_HINT;
    case "failed":
      return "Couldn't be located — try again";
    default:
      return "";
  }
}

/** The sites that could NOT be placed on the map. This is the spec's single most important
 *  surface: a site that fails geocoding must stay visible and actionable here, never silently
 *  disappear because the map couldn't plot it. Renders nothing at all when every site is "ok" (or
 *  the list is empty) so a fully-located client never gets a stray empty panel. */
export function UnlocatedSites({ sites }: { sites: SiteSummary[] }) {
  const router = useRouter();
  const [locatingId, setLocatingId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const unlocated = sites.filter((s) => s.geocodeStatus !== "ok");
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
              <p className="text-sm text-neutral-600">{statusText(site.geocodeStatus)}</p>
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
