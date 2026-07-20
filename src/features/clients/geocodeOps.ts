export type GeocodeResult =
  | { status: "ok"; lat: number; lng: number }
  | { status: "not_found" }
  | { status: "failed"; error: string };

export const VAGUE_ADDRESS_HINT =
  "Add a city and country to this address so it can be found on the map";

/** Only a number, or a non-empty (post-trim) string, is an acceptable coordinate value.
 *  Everything else — null, undefined, arrays, objects, booleans — coerces through bare
 *  Number() to 0 or NaN, and 0 is a false-positive "ok" (Null Island) that Number.isFinite
 *  can't catch on its own. Reject the type before ever coercing it. */
function isCoordinateLike(value: unknown): value is number | string {
  if (typeof value === "number") return true;
  return typeof value === "string" && value.trim().length > 0;
}

/** Nominatim returns lat/lon as STRINGS in a JSON array — [] means no match. */
export function parseNominatimResponse(json: unknown): GeocodeResult {
  if (!Array.isArray(json)) return { status: "failed", error: "Unexpected response" };
  if (json.length === 0) return { status: "not_found" };
  const first = json[0] as { lat?: unknown; lon?: unknown };
  if (!isCoordinateLike(first?.lat) || !isCoordinateLike(first?.lon)) {
    return { status: "failed", error: "Response had no usable coordinates" };
  }
  const lat = Number(first.lat), lng = Number(first.lon);
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

/** Ordinal + Floor/Fl phrase, e.g. "13th Floor", "2nd Fl." — the whole phrase must go, since
 *  "13th" alone left behind reads as a street-number fragment, not a real address token. The \b
 *  right after the alternation is load-bearing: without it, "Fl" partial-matches the first two
 *  letters of "Flushing"/"Florida"/"Flatbush" and the rest of the word gets swept up as if it
 *  were the unit identifier. */
const ORDINAL_FLOOR_RE = /\b\d+(?:st|nd|rd|th)\s+(?:Floor|Fl)\b\.?/gi;

/** Suite/Ste/Floor/Fl/Unit/Apt/Apartment/Room/Rm followed by an identifier (300, 3A, B-2).
 *  Same word-boundary requirement as above and for the same reason. */
const UNIT_DESIGNATOR_RE =
  /\b(?:Suite|Ste|Floor|Fl|Unit|Apartment|Apt|Room|Rm)\b\.?\s+[A-Za-z0-9][A-Za-z0-9-]*\b/gi;

/** "#300" style unit markers. */
const HASH_UNIT_RE = /#\s*[A-Za-z0-9][A-Za-z0-9-]*\b/g;

/** Straight and curly apostrophes. */
const APOSTROPHE_RE = /['’]/g;

/** Normalises an address for the geocoder QUERY only — the stored address is never touched.
 *  Nominatim chokes on unit/suite/floor designators and on apostrophes ("St. John's" fails,
 *  "St. Johns" succeeds); stripping them here, not in storage, keeps the MSP's operational
 *  detail (which suite, which floor) intact in the database. */
export function normaliseForGeocoding(address: string): string {
  let result = address;

  result = result.replace(ORDINAL_FLOOR_RE, "");
  result = result.replace(UNIT_DESIGNATOR_RE, "");
  result = result.replace(HASH_UNIT_RE, "");
  result = result.replace(APOSTROPHE_RE, "");

  // Tidy up whatever the removals above left behind: collapsed whitespace, a comma stranded
  // with nothing (or just whitespace) before the next comma, and leading/trailing cruft.
  result = result.replace(/\s+/g, " ");
  result = result.replace(/\s*,\s*,/g, ",");
  result = result.replace(/\s+,/g, ",");
  result = result.replace(/^,\s*/, "");
  result = result.replace(/,\s*$/, "");

  return result.trim();
}
