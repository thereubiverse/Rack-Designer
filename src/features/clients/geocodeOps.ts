export type GeocodeResult =
  | { status: "ok"; lat: number; lng: number }
  | { status: "not_found" }
  | { status: "failed"; error: string };

export const VAGUE_ADDRESS_HINT =
  "Add a city and country to this address so it can be found on the map";

/** Nominatim returns lat/lon as STRINGS in a JSON array — [] means no match. */
export function parseNominatimResponse(json: unknown): GeocodeResult {
  if (!Array.isArray(json)) return { status: "failed", error: "Unexpected response" };
  if (json.length === 0) return { status: "not_found" };
  const first = json[0] as { lat?: unknown; lon?: unknown };
  const lat = Number(first?.lat), lng = Number(first?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { status: "failed", error: "Response had no usable coordinates" };
  }
  return { status: "ok", lat, lng };
}

/** Cheap pre-flight. An address with no locality resolves to nothing useful — or worse, to a
 *  confident match on the wrong continent. Skipping it saves a request against a 1/sec budget AND
 *  lets the UI say something actionable instead of showing a wrong pin. */
export function isAddressGeocodable(address: string | null): boolean {
  const a = (address ?? "").trim();
  if (a.length < 8) return false;
  return a.includes(",") || a.split(/\s+/).length >= 4;
}
