import { describe, it, expect } from "vitest";
import {
  parseNominatimResponse,
  isAddressGeocodable,
  VAGUE_ADDRESS_HINT,
  normaliseForGeocoding,
} from "./geocodeOps";

describe("parseNominatimResponse", () => {
  it("reads lat/lon out of a match (Nominatim returns them as STRINGS)", () => {
    const r = parseNominatimResponse([{ lat: "53.4808", lon: "-2.2426" }]);
    expect(r).toEqual({ status: "ok", lat: 53.4808, lng: -2.2426 });
  });
  it("an empty array is not_found, not an error", () => {
    expect(parseNominatimResponse([])).toEqual({ status: "not_found" });
  });
  it("anything malformed is failed, never a throw", () => {
    for (const bad of [
      null,
      undefined,
      {},
      "nope",
      [{ lat: "x", lon: "y" }],
      [{}],
      [{ lat: null, lon: "-2.2426" }],
      [{ lat: "", lon: "-2.2426" }],
      [{ lat: [], lon: "-2.2426" }],
      [{ lat: "53.4808", lon: null }],
      [{ lat: {}, lon: "-2.2426" }],
      [{ lat: true, lon: "-2.2426" }],
    ]) {
      expect(parseNominatimResponse(bad).status).toBe("failed");
    }
  });
  it("a genuine 0 coordinate is a real place, not rejected", () => {
    expect(parseNominatimResponse([{ lat: "0", lon: "0" }])).toEqual({
      status: "ok",
      lat: 0,
      lng: 0,
    });
  });
});

describe("isAddressGeocodable", () => {
  it("rejects the vague addresses that would otherwise burn a request and return a wrong pin", () => {
    // The real case in this database: no city, no country.
    expect(isAddressGeocodable("12 Main St")).toBe(false);
    expect(isAddressGeocodable(null)).toBe(false);
    expect(isAddressGeocodable("   ")).toBe(false);
  });
  it("accepts an address carrying a locality", () => {
    expect(isAddressGeocodable("12 Main St, Manchester, UK")).toBe(true);
    expect(isAddressGeocodable("1 Infinite Loop Cupertino California")).toBe(true);
  });
  it("publishes a hint telling the user what to add", () => {
    expect(VAGUE_ADDRESS_HINT).toMatch(/city/i);
  });
});

describe("normaliseForGeocoding", () => {
  it("strips a Suite designator that Nominatim chokes on", () => {
    expect(normaliseForGeocoding("211 E 43rd St Suite 300, New York, NY 10017")).toBe(
      "211 E 43rd St, New York, NY 10017"
    );
  });

  it("strips an ordinal + Floor designator that Nominatim chokes on", () => {
    expect(normaliseForGeocoding("205 E 42nd St 13th Floor, New York, NY 10017")).toBe(
      "205 E 42nd St, New York, NY 10017"
    );
  });

  it("removes an apostrophe that Nominatim chokes on, without touching St.", () => {
    expect(normaliseForGeocoding("1604 St. John's Pl, Brooklyn, NY 11233")).toBe(
      "1604 St. Johns Pl, Brooklyn, NY 11233"
    );
  });

  it("removes a curly apostrophe too", () => {
    expect(normaliseForGeocoding("1604 St. John’s Pl, Brooklyn, NY 11233")).toBe(
      "1604 St. Johns Pl, Brooklyn, NY 11233"
    );
  });

  it("strips other unit designators: Ste, Apt, Unit, Room, Rm, #", () => {
    expect(normaliseForGeocoding("100 Main St Ste 3A, Boston, MA 02108")).toBe(
      "100 Main St, Boston, MA 02108"
    );
    expect(normaliseForGeocoding("100 Main St Apt 4, Boston, MA 02108")).toBe(
      "100 Main St, Boston, MA 02108"
    );
    expect(normaliseForGeocoding("100 Main St Apartment 4, Boston, MA 02108")).toBe(
      "100 Main St, Boston, MA 02108"
    );
    expect(normaliseForGeocoding("100 Main St Unit B-2, Boston, MA 02108")).toBe(
      "100 Main St, Boston, MA 02108"
    );
    expect(normaliseForGeocoding("100 Main St Room 12, Boston, MA 02108")).toBe(
      "100 Main St, Boston, MA 02108"
    );
    expect(normaliseForGeocoding("100 Main St Rm 12, Boston, MA 02108")).toBe(
      "100 Main St, Boston, MA 02108"
    );
    expect(normaliseForGeocoding("100 Main St #300, Boston, MA 02108")).toBe(
      "100 Main St, Boston, MA 02108"
    );
  });

  it("strips ordinal floors other than 13th: 2nd Floor, 1st Floor", () => {
    expect(normaliseForGeocoding("50 Broad St 2nd Floor, New York, NY 10004")).toBe(
      "50 Broad St, New York, NY 10004"
    );
    expect(normaliseForGeocoding("50 Broad St 1st Floor, New York, NY 10004")).toBe(
      "50 Broad St, New York, NY 10004"
    );
  });

  it("does not mangle Flushing, Florida, or Flatbush (Fl must match only as a whole word)", () => {
    expect(normaliseForGeocoding("39-03 College Point Blvd, Flushing, NY 11354")).toBe(
      "39-03 College Point Blvd, Flushing, NY 11354"
    );
    expect(normaliseForGeocoding("100 Main St, Orlando, Florida 32801")).toBe(
      "100 Main St, Orlando, Florida 32801"
    );
    expect(normaliseForGeocoding("500 Church Ave, Flatbush, NY 11218")).toBe(
      "500 Church Ave, Flatbush, NY 11218"
    );
  });

  it("does not mangle St used as Street, or Jr. in a person's-name-style boulevard", () => {
    expect(normaliseForGeocoding("151 W 133rd St, New York, NY 10030")).toBe(
      "151 W 133rd St, New York, NY 10030"
    );
    expect(normaliseForGeocoding("2250 Adam Clayton Powell Jr. Blvd, New York, NY 10027")).toBe(
      "2250 Adam Clayton Powell Jr. Blvd, New York, NY 10027"
    );
  });

  it("returns an address with no unit designator completely unchanged", () => {
    const a = "375 Rogers Ave, Brooklyn, NY 11225";
    expect(normaliseForGeocoding(a)).toBe(a);
  });

  it("collapses an address that is only a unit designator to something the pre-flight rejects", () => {
    const result = normaliseForGeocoding("Suite 300");
    expect(isAddressGeocodable(result)).toBe(false);
  });

  // Regression guard: these 24 addresses currently geocode successfully in production.
  // Normalising them MUST be a strict no-op, or this change silently breaks working data.
  // Source: docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t -A \
  //   -c "select address from sites where geocode_status='ok' order by code;"
  const CURRENTLY_WORKING_ADDRESSES = [
    "2250 Adam Clayton Powell Jr. Blvd, New York, NY 10027",
    "2332 Adam Clayton Powell Jr. Blvd, New York, NY 10030",
    "375 Rogers Ave, Brooklyn, NY 11225",
    "151 W 133rd St, New York, NY 10030",
    "926 Southern Blvd, Bronx, NY 10459",
    "2390 Hoffman St, Bronx, NY 10458",
    "2351 Walton Ave, Bronx, NY 10468",
    "39-03 College Point Blvd, Flushing, NY 11354",
    "38-60 13th St, Long Island City, NY 11101",
    "671 E 231st St, Bronx, NY 10466",
    "1317 New York Ave, Brooklyn, NY 11203",
    "1270 Pacific St, Brooklyn, NY 11216",
    "2170 Prospect Ave, Bronx, NY 10457",
    "2 Mt. Hope Place, Bronx, NY 10453",
    "1535 Taylor Ave, Bronx, NY 10460",
    "810 Howard Ave, Brooklyn, NY 11212",
    "951 Olmstead Ave, Bronx, NY 10473",
    "539 W 152nd St, New York, NY 10031",
    "304 W 144th St, New York, NY 10030",
    "1011 Ocean Ave, Brooklyn, NY 11226",
    "805 E 139th St, Bronx, NY 10453",
    "362 E 51st St, Brooklyn, NY 11203",
    "217 Hart St, Brooklyn, NY 11206",
    "157 Edgecombe Ave, New York, NY 10030",
  ];

  it.each(CURRENTLY_WORKING_ADDRESSES)(
    "is a strict no-op for the currently-working address: %s",
    (address) => {
      expect(normaliseForGeocoding(address)).toBe(address);
    }
  );
});
