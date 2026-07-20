import { describe, it, expect } from "vitest";
import { parseNominatimResponse, isAddressGeocodable, VAGUE_ADDRESS_HINT } from "./geocodeOps";

describe("parseNominatimResponse", () => {
  it("reads lat/lon out of a match (Nominatim returns them as STRINGS)", () => {
    const r = parseNominatimResponse([{ lat: "53.4808", lon: "-2.2426" }]);
    expect(r).toEqual({ status: "ok", lat: 53.4808, lng: -2.2426 });
  });
  it("an empty array is not_found, not an error", () => {
    expect(parseNominatimResponse([])).toEqual({ status: "not_found" });
  });
  it("anything malformed is failed, never a throw", () => {
    for (const bad of [null, undefined, {}, "nope", [{ lat: "x", lon: "y" }], [{}]]) {
      expect(parseNominatimResponse(bad).status).toBe("failed");
    }
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
