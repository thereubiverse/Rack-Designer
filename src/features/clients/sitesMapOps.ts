import type { SiteSummary } from "./repository";

export interface Blip {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  rackCount: number;
}

export type LatLngBounds = [[number, number], [number, number]];

/** Whether a site can be plotted on the map: geocoding succeeded AND both coordinates are
 *  present. The null-coordinate check is belt-and-braces on top of the status check — if the two
 *  ever disagree (a partial write, a manual SQL repair), a site with `geocodeStatus === "ok"` but
 *  a null coordinate must NOT silently render at (0, 0), a confident pin in the Gulf of Guinea.
 *
 *  This is exported and shared with UnlocatedSites (which filters on `!isMappable(site)`) so the
 *  map and the "N sites aren't on the map yet" list are complements BY CONSTRUCTION rather than
 *  two independently-maintained predicates that could drift apart. A site failing this check is
 *  guaranteed to show up in UnlocatedSites instead of being silently absent from both surfaces. */
export function isMappable(site: SiteSummary): boolean {
  return site.geocodeStatus === "ok" && site.latitude != null && site.longitude != null;
}

/** Maps sites onto map blips. Filtering goes through `isMappable` so this function stays in
 *  lock-step with UnlocatedSites by construction — see that function's doc comment. */
export function toBlips(sites: SiteSummary[]): Blip[] {
  return sites
    .filter(isMappable)
    .map((site) => ({
      id: site.id,
      code: site.code,
      name: site.name,
      lat: site.latitude as number,
      lng: site.longitude as number,
      rackCount: site.rackCount,
    }));
}

/** Bounding box containing every blip, for fitting the map viewport. `null` when there is nothing
 *  to show. A single blip yields a degenerate (zero-area) box, which Leaflet handles fine — it
 *  just centers and zooms in on that one point. */
export function boundsOf(blips: Blip[]): LatLngBounds | null {
  if (blips.length === 0) return null;

  let minLat = blips[0].lat;
  let maxLat = blips[0].lat;
  let minLng = blips[0].lng;
  let maxLng = blips[0].lng;

  for (const blip of blips) {
    if (blip.lat < minLat) minLat = blip.lat;
    if (blip.lat > maxLat) maxLat = blip.lat;
    if (blip.lng < minLng) minLng = blip.lng;
    if (blip.lng > maxLng) maxLng = blip.lng;
  }

  return [
    [minLat, minLng],
    [maxLat, maxLng],
  ];
}
