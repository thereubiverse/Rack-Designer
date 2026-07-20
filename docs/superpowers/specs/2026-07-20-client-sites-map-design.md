# Client Sites Map — Design

**Status:** design agreed 2026-07-20; NOT yet planned or built.
**Build this in a fresh session:** run `superpowers:writing-plans` against this spec, then
`superpowers:subagent-driven-development`.

**Goal:** On a client's page, show that client's sites on a map as selectable blips that open the
site.

---

## 1. Decisions taken

| Decision | Choice |
|---|---|
| Where coordinates come from | **Geocode the address automatically** |
| Geocoding service | **Nominatim / OpenStreetMap** — free, no account, no key |
| Tiles | **OpenStreetMap raster tiles** — same vendor story, no account |
| Map library | **Leaflet** via `react-leaflet` (mature, small, key-free, OSM-native) |
| When geocoding runs | **On write** (site create / address edit) — never per page view |

Nominatim was chosen over Mapbox/Google to keep the feature free of accounts, keys and billing. The
cost of that choice is real and is handled explicitly in §4: Nominatim is stricter and less forgiving
of partial addresses.

## 2. The problem this must not paper over

The existing site `HQ` has address **"12 Main St"** — no city, no region, no country. Nominatim will
either fail on it or return a confident match somewhere else in the world.

**Therefore: a site that cannot be geocoded must remain visible and usable — never silently absent
from the page.** A map that quietly drops sites is worse than no map, because the omission is
invisible. This is the single most important requirement in this spec.

## 3. Schema — migration `0010_site_coordinates.sql`

```sql
alter table sites add column latitude       double precision;
alter table sites add column longitude      double precision;
alter table sites add column geocode_status text not null default 'pending'
  check (geocode_status in ('pending', 'ok', 'not_found', 'failed'));
alter table sites add column geocoded_at    timestamptz;
```

All nullable/defaulted, so existing rows migrate cleanly. `geocode_status` is what makes failure
legible rather than indistinguishable from "not tried yet":

- `pending` — never attempted (all existing rows start here)
- `ok` — coordinates present
- `not_found` — the service ran and matched nothing (bad/partial address)
- `failed` — the service errored or timed out (transient; retryable)

**Grants:** end the migration with the same blanket grant statements every other migration in this
repo carries. Migration `0008` omitted them and every query failed with "permission denied" until
`0009` patched it — do not repeat that.

## 4. Geocoding

**Server-side only.** Nominatim's usage policy requires an identifying `User-Agent`, which a browser
cannot set, and calling it from the client would also hit CORS and expose the app's traffic pattern.
It runs in a server action.

`src/features/clients/geocode.ts`:
- `geocodeAddress(address: string): Promise<GeocodeResult>` — the only network-touching function.
- `GeocodeResult = { status: "ok"; lat: number; lng: number } | { status: "not_found" } | { status: "failed"; error: string }`.
- Sends `User-Agent: rack-designer/1.0` and `format=jsonv2&limit=1`.
- Times out (5s) and returns `failed` rather than hanging a server action.

`src/features/clients/geocodeOps.ts` — **pure, unit-tested, no network**:
- `parseNominatimResponse(json: unknown): GeocodeResult` — the response shape lives here so it can be
  tested against real captured payloads without hitting the network.
- `isAddressGeocodable(address: string | null): boolean` — cheap pre-flight. An address with no comma
  and fewer than three words (e.g. "12 Main St") is almost certainly too vague; skip the call and
  record `not_found` with a message telling the user to add a city and country. This turns a confusing
  wrong pin into actionable feedback, and respects the rate limit by not spending a request on it.

**Rate limit:** Nominatim allows ~1 request/second. Geocoding happens one site at a time on save, so
normal use cannot breach it. Any backfill command must sleep ≥1s between calls.

**Attribution:** OSM requires "© OpenStreetMap contributors" visible on the map. Non-negotiable —
include it in the map component, not as a footnote elsewhere.

## 5. Behaviour

**Writes.** `createSiteAction` and `renameSiteAction` (which carries `address`) geocode after a
successful write, then store `latitude`/`longitude`/`geocode_status`/`geocoded_at`. A geocoding
failure must NOT fail the write — the site is saved either way, with its status recorded. Geocoding is
a decoration on the site, not a precondition for it.

**Re-geocode** only when the address actually changed, so renaming a site does not spend a request.

**Client page.** `/clients/[clientCode]` gains a map above the existing sites table:
- One blip per site with `geocode_status = 'ok'`, auto-fitting bounds to show them all.
- Clicking a blip opens a popup: site name, code, rack count, and an "Open site" link to
  `/clients/[clientCode]/[siteCode]`.
- Selecting a blip highlights that site's row in the table beneath, and vice versa.

**Sites that are not on the map** (`pending` / `not_found` / `failed`) render in a short list beneath
the map — "3 sites aren't on the map yet" — each with its status in plain words and a **Locate**
button to retry. `not_found` says what to fix ("add a city and country to the address"). This is the
§2 requirement made concrete.

**Edge cases:** no sites at all → no map, existing empty state stands. Sites exist but none are
geocoded → no map frame, just the not-located list, so an empty grey rectangle never appears.

## 6. Files

```
supabase/migrations/0010_site_coordinates.sql
src/features/clients/geocodeOps.ts        pure parse + pre-flight   ← unit tested
src/features/clients/geocodeOps.test.ts
src/features/clients/geocode.ts           the one network call
src/features/clients/SitesMap.tsx         Leaflet map + blips + popups (client-only)
src/features/clients/UnlocatedSites.tsx   the "not on the map" list + Locate  ← unit tested
```
Modified: `repository.ts` (carry the new columns through `SiteSummary`), `actions.ts` (geocode on
write; add `locateSiteAction`), `ClientDetail.tsx` (render map + list, wire selection).

**Next.js note:** Leaflet touches `window` at import time, so `SitesMap` must be loaded via
`next/dynamic` with `{ ssr: false }`. Importing it directly will break the server render.

## 7. Testing

- `geocodeOps.ts` — pure unit tests over captured Nominatim payloads: a good match, an empty array
  (`not_found`), malformed JSON (`failed`), and the pre-flight rejecting "12 Main St" while accepting
  "12 Main St, Manchester, UK".
- `geocode.ts` — network is mocked (`vi.mock`); assert the `User-Agent` is sent and that a timeout
  yields `failed`, never a throw.
- `UnlocatedSites.tsx` — renders each status in plain words; Locate fires the action.
- `SitesMap.tsx` — Leaflet does not render meaningfully in jsdom. Do **not** chase DOM assertions;
  instead extract blip derivation (`SiteSummary[] → {id, lat, lng, label}[]`, filtering non-`ok`
  sites) into a pure function and test that. Verify the map itself in the browser.
- **Constraint:** integration tests in this repo wipe the local database when run broadly. Run tests
  by EXPLICIT FILENAME only — never a directory or glob.

## 8. Out of scope

Manual pin placement / drag-to-correct (the natural follow-up once real addresses expose Nominatim's
limits); clustering for large site counts; routing or distance; per-site map imagery; offline tiles;
geocoding anything below site level (floors, rooms, racks have no address).

## 9. Open question for the builder

**Bulk backfill.** Existing sites are all `pending`. Either add a one-off script that walks them at
≤1 req/s, or rely on the per-site **Locate** button. With one real site today the button is
sufficient, and it is strictly less code — recommend starting there and only writing the script if
the site count grows.
