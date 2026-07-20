import { describe, expect, it } from "vitest";
import { toBlips, boundsOf, isMappable, type Blip } from "./sitesMapOps";
import type { SiteSummary } from "./repository";

function makeSite(overrides: Partial<SiteSummary> = {}): SiteSummary {
  return {
    id: "site-1",
    code: "S1",
    name: "Site One",
    address: "1 Main St",
    latitude: 10,
    longitude: 20,
    geocodeStatus: "ok",
    rackCount: 3,
    deviceCount: 12,
    ...overrides,
  };
}

describe("toBlips", () => {
  it("includes only sites with geocodeStatus ok", () => {
    const sites: SiteSummary[] = [
      makeSite({ id: "a", geocodeStatus: "ok" }),
      makeSite({ id: "b", geocodeStatus: "pending" }),
      makeSite({ id: "c", geocodeStatus: "not_found" }),
      makeSite({ id: "d", geocodeStatus: "failed" }),
    ];

    const blips = toBlips(sites);

    expect(blips.map((b) => b.id)).toEqual(["a"]);
  });

  it("drops sites with null latitude even when status says ok (belt and braces)", () => {
    const sites: SiteSummary[] = [
      makeSite({ id: "a", geocodeStatus: "ok", latitude: null }),
    ];

    expect(toBlips(sites)).toEqual([]);
  });

  it("drops sites with null longitude even when status says ok (belt and braces)", () => {
    const sites: SiteSummary[] = [
      makeSite({ id: "a", geocodeStatus: "ok", longitude: null }),
    ];

    expect(toBlips(sites)).toEqual([]);
  });

  it("drops sites with undefined-like missing coordinates", () => {
    const sites: SiteSummary[] = [
      makeSite({ id: "a", geocodeStatus: "ok", latitude: null, longitude: null }),
    ];

    expect(toBlips(sites)).toEqual([]);
  });

  it("maps the fields Blip needs, including rackCount", () => {
    const sites: SiteSummary[] = [
      makeSite({
        id: "a",
        code: "ABC",
        name: "Alpha Site",
        latitude: 51.5,
        longitude: -0.1,
        rackCount: 7,
        geocodeStatus: "ok",
      }),
    ];

    const blips = toBlips(sites);

    expect(blips).toEqual([
      { id: "a", code: "ABC", name: "Alpha Site", lat: 51.5, lng: -0.1, rackCount: 7 },
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(toBlips([])).toEqual([]);
  });

  it("keeps a site at Null Island (0, 0) when geocodeStatus is ok — 0 is a real coordinate, not a missing one", () => {
    const sites: SiteSummary[] = [
      makeSite({ id: "a", geocodeStatus: "ok", latitude: 0, longitude: 0 }),
    ];

    const blips = toBlips(sites);

    expect(blips.map((b) => b.id)).toEqual(["a"]);
    expect(blips[0].lat).toBe(0);
    expect(blips[0].lng).toBe(0);
  });

  it("keeps a site on the equator (latitude 0, non-zero longitude)", () => {
    const sites: SiteSummary[] = [
      makeSite({ id: "a", geocodeStatus: "ok", latitude: 0, longitude: 20 }),
    ];

    const blips = toBlips(sites);

    expect(blips.map((b) => b.id)).toEqual(["a"]);
    expect(blips[0].lat).toBe(0);
  });

  it("keeps a site on the prime meridian (longitude 0, non-zero latitude)", () => {
    const sites: SiteSummary[] = [
      makeSite({ id: "a", geocodeStatus: "ok", latitude: 10, longitude: 0 }),
    ];

    const blips = toBlips(sites);

    expect(blips.map((b) => b.id)).toEqual(["a"]);
    expect(blips[0].lng).toBe(0);
  });
});

describe("isMappable", () => {
  it("is true for a site with ok status and both coordinates present", () => {
    expect(isMappable(makeSite({ geocodeStatus: "ok", latitude: 10, longitude: 20 }))).toBe(true);
  });

  it("is false for a site with ok status but a null latitude — the exact case toBlips must also drop", () => {
    // This is the shared predicate at the center of Fix 2: toBlips and UnlocatedSites both call
    // this function, so a site like this one is guaranteed to be excluded from the map AND
    // included in UnlocatedSites — never neither.
    const site = makeSite({ geocodeStatus: "ok", latitude: null, longitude: 20 });
    expect(isMappable(site)).toBe(false);
    // Confirm toBlips (which filters via this same predicate) agrees.
    expect(toBlips([site])).toEqual([]);
  });

  it("is false for a site with ok status but a null longitude", () => {
    expect(isMappable(makeSite({ geocodeStatus: "ok", latitude: 10, longitude: null }))).toBe(false);
  });

  it("is false for a non-ok status even with coordinates present", () => {
    expect(isMappable(makeSite({ geocodeStatus: "not_found", latitude: 10, longitude: 20 }))).toBe(false);
  });
});

describe("boundsOf", () => {
  it("returns null for an empty list", () => {
    expect(boundsOf([])).toBeNull();
  });

  it("returns a degenerate (zero-area) box for a single blip", () => {
    const blips: Blip[] = [{ id: "a", code: "A", name: "A", lat: 10, lng: 20, rackCount: 1 }];

    expect(boundsOf(blips)).toEqual([
      [10, 20],
      [10, 20],
    ]);
  });

  it("returns a box containing all blips, spanning positive and negative lat/lng", () => {
    const blips: Blip[] = [
      { id: "a", code: "A", name: "A", lat: 10, lng: -30, rackCount: 1 },
      { id: "b", code: "B", name: "B", lat: -5, lng: 40, rackCount: 1 },
      { id: "c", code: "C", name: "C", lat: 25, lng: 5, rackCount: 1 },
    ];

    const bounds = boundsOf(blips);

    // min lat = -5, max lat = 25; min lng = -30, max lng = 40
    expect(bounds).toEqual([
      [-5, -30],
      [25, 40],
    ]);
  });
});
