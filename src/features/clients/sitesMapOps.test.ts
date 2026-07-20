import { describe, expect, it } from "vitest";
import { toBlips, boundsOf, type Blip } from "./sitesMapOps";
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
