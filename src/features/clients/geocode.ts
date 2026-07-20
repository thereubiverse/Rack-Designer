import {
  parseNominatimResponse,
  isAddressGeocodable,
  normaliseForGeocoding,
  type GeocodeResult,
} from "./geocodeOps";

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 5000;

/** Server-side ONLY: Nominatim's policy requires an identifying User-Agent, which a browser cannot
 *  set, and a client-side call would also hit CORS. Never throws — a geocode must not be able to
 *  fail the write it decorates. */
export async function geocodeAddress(address: string | null): Promise<GeocodeResult> {
  // Normalise the QUERY only — this never touches the stored address. Nominatim chokes on
  // "Suite 300" / "13th Floor" / apostrophes that are otherwise-correct operational detail.
  const normalised = address === null ? null : normaliseForGeocoding(address);
  if (!isAddressGeocodable(normalised)) return { status: "not_found" };
  const url = `${ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(normalised!.trim())}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": "rack-designer/1.0", "Accept": "application/json" },
    });
    if (!res.ok) return { status: "failed", error: `Geocoder returned ${res.status}` };
    return parseNominatimResponse(await res.json());
  } catch (e) {
    return { status: "failed", error: e instanceof Error ? e.message : "Geocoder unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
