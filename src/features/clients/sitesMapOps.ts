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

/** Maps sites onto map blips. Only sites whose geocoding actually succeeded should ever render a
 *  pin. The null-coordinate check is belt-and-braces on top of the status check: if the two ever
 *  disagree, a blip with a null coordinate would silently render at (0, 0) — a confident pin in
 *  the Gulf of Guinea. Dropping it here means a bug elsewhere fails safe (site missing from the
 *  map, and still visible in UnlocatedSites) rather than failing dangerously (wrong location shown
 *  as if correct). */
export function toBlips(sites: SiteSummary[]): Blip[] {
  return sites
    .filter((site) => site.geocodeStatus === "ok")
    .filter((site) => site.latitude != null && site.longitude != null)
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
