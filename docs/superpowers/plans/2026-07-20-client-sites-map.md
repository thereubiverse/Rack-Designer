# Client Sites Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a client's sites on a map as selectable blips that open the site.

**Architecture:** Sites gain nullable coordinates plus a `geocode_status`. Addresses are geocoded once on write (never per page view) through Nominatim, server-side. The client page renders a Leaflet map of the sites that resolved, and — critically — a visible list of the ones that did not, so a site can never silently vanish.

**Tech Stack:** Next.js 16 (app router, server components + server actions), TypeScript strict, Supabase (local via Docker), Leaflet + react-leaflet, Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-20-client-sites-map-design.md` — read §2 before starting.

## Global Constraints

- **NEVER run vitest against a directory or glob.** `*.integration.test.ts` files here delete rows wholesale and WILL wipe the developer's local database. Run tests by EXPLICIT FILENAME only.
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- No local `psql`. Use `docker exec supabase_db_network-doc-platform psql -U postgres -d postgres`.
- Every migration ends with the same blanket grant statements the others carry. **`0008` omitted them and every query failed with "permission denied" until `0009` patched it — do not repeat that.**
- Server actions return `{ ok: boolean; error?: string }` and never throw to the caller.
- Nominatim: send `User-Agent: rack-designer/1.0`, ≤1 request/second, and display "© OpenStreetMap contributors" on the map. These are usage-policy obligations, not preferences.
- Geocoding must NEVER fail a write. A site saves whether or not its address resolves.
- Run commands from the project root; the Bash tool's cwd resets between calls.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Migration 0010 — site coordinates

**Files:**
- Create: `supabase/migrations/0010_site_coordinates.sql`
- Modify: `src/lib/supabase/types.ts`

**Interfaces:**
- Produces: `SiteRow` gains `latitude: number | null`, `longitude: number | null`, `geocode_status: "pending" | "ok" | "not_found" | "failed"`, `geocoded_at: string | null`.

- [ ] **Step 1: Write the migration**

```sql
-- Sites get coordinates so they can be plotted. All nullable/defaulted so existing rows migrate
-- cleanly and simply start as 'pending'. geocode_status is what keeps a failure LEGIBLE — without
-- it, "never attempted" and "attempted and matched nothing" are indistinguishable, and a site that
-- cannot be located would silently disappear from the map.
alter table sites add column latitude       double precision;
alter table sites add column longitude      double precision;
alter table sites add column geocode_status text not null default 'pending'
  check (geocode_status in ('pending', 'ok', 'not_found', 'failed'));
alter table sites add column geocoded_at    timestamptz;

grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
```

- [ ] **Step 2: Apply and verify**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0010_site_coordinates.sql
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t -c "select column_name from information_schema.columns where table_schema='public' and table_name='sites' order by ordinal_position;"
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t -c "select code, geocode_status from sites;"
```
Expected: the four new columns present; every existing site reads `pending`.

- [ ] **Step 3: Update `SiteRow`, typecheck, commit**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
git add supabase/migrations/0010_site_coordinates.sql src/lib/supabase/types.ts
git commit -m "feat(db): site coordinates and geocode status"
```
Expected: tsc silent.

---

### Task 2: Pure geocode ops (TDD)

**Files:**
- Create: `src/features/clients/geocodeOps.ts`, `src/features/clients/geocodeOps.test.ts`

**Interfaces:**
- Produces: `GeocodeResult = { status: "ok"; lat: number; lng: number } | { status: "not_found" } | { status: "failed"; error: string }`; `parseNominatimResponse(json: unknown): GeocodeResult`; `isAddressGeocodable(address: string | null): boolean`; `VAGUE_ADDRESS_HINT: string`.

This module is the whole feature's testable core: it never touches the network, so the response shape and the pre-flight can be pinned exactly.

- [ ] **Step 1: Write the failing tests**

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/features/clients/geocodeOps.test.ts
```
Expected: FAIL — cannot resolve `./geocodeOps`.

- [ ] **Step 3: Implement**

```ts
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
```

- [ ] **Step 4: Run the tests, then commit**

```bash
npx vitest run src/features/clients/geocodeOps.test.ts
git add src/features/clients/geocodeOps.ts src/features/clients/geocodeOps.test.ts
git commit -m "feat(clients): pure geocode parsing and vague-address pre-flight"
```
Expected: PASS.

---

### Task 3: The Nominatim client

**Files:**
- Create: `src/features/clients/geocode.ts`, `src/features/clients/geocode.test.ts`

**Interfaces:**
- Consumes: `parseNominatimResponse`, `isAddressGeocodable`, `GeocodeResult`, `VAGUE_ADDRESS_HINT` (Task 2).
- Produces: `geocodeAddress(address: string | null): Promise<GeocodeResult>` — the ONLY network-touching function in the feature.

- [ ] **Step 1: Write the failing tests**

Mock `fetch` with `vi.stubGlobal`. Cover: a vague address short-circuits to `not_found` **without** calling fetch (assert the mock was never called — this is the rate-limit guarantee); a good address sends `User-Agent: rack-designer/1.0`; a non-OK HTTP status yields `failed`; a thrown/aborted fetch yields `failed` rather than propagating.

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/geocode.test.ts
```

- [ ] **Step 3: Implement**

```ts
import { parseNominatimResponse, isAddressGeocodable, type GeocodeResult } from "./geocodeOps";

const ENDPOINT = "https://nominatim.openstreetmap.org/search";
const TIMEOUT_MS = 5000;

/** Server-side ONLY: Nominatim's policy requires an identifying User-Agent, which a browser cannot
 *  set, and a client-side call would also hit CORS. Never throws — a geocode must not be able to
 *  fail the write it decorates. */
export async function geocodeAddress(address: string | null): Promise<GeocodeResult> {
  if (!isAddressGeocodable(address)) return { status: "not_found" };
  const url = `${ENDPOINT}?format=jsonv2&limit=1&q=${encodeURIComponent(address!.trim())}`;
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
```

- [ ] **Step 4: Run the tests, then commit**

```bash
npx vitest run src/features/clients/geocode.test.ts
git add src/features/clients/geocode.ts src/features/clients/geocode.test.ts
git commit -m "feat(clients): Nominatim geocoding client"
```

---

### Task 4: Geocode on write, plus a Locate action

**Files:**
- Modify: `src/features/clients/repository.ts`, `src/features/clients/actions.ts`

**Interfaces:**
- Consumes: `geocodeAddress` (Task 3).
- Produces: `setSiteGeocode(db, siteId, result: GeocodeResult): Promise<void>`; `SiteSummary` gains `latitude`, `longitude`, `geocodeStatus`; `locateSiteAction(formData)` taking `siteId`.

- [ ] **Step 1: Carry the columns through the repository**

Add `latitude`, `longitude`, `geocodeStatus` to `SiteSummary` and to whatever `listSitesForClient` selects. Add `setSiteGeocode`, which maps a `GeocodeResult` onto the four columns and stamps `geocoded_at`.

- [ ] **Step 2: Geocode after a successful write**

In `createSiteAction` and `renameSiteAction`: after the write succeeds, `await geocodeAddress(address)` and persist via `setSiteGeocode`. Wrap that in its own `try/catch` that swallows errors — **a geocoding failure must not fail the write**. Only re-geocode in `renameSiteAction` when the address actually changed, so renaming does not spend a request.

- [ ] **Step 3: Add `locateSiteAction`**

Takes `siteId`, reads the site's address, geocodes, persists, `revalidatePath("/clients")`, returns `{ ok, error? }`. This is the retry button behind §5 of the spec, and the reason a bulk backfill script is optional.

- [ ] **Step 4: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
git add src/features/clients/repository.ts src/features/clients/actions.ts
git commit -m "feat(clients): geocode sites on write; add a Locate retry action"
```

---

### Task 5: UnlocatedSites — the sites that are NOT on the map

**Files:**
- Create: `src/features/clients/UnlocatedSites.tsx`, `src/features/clients/UnlocatedSites.test.tsx`

**Interfaces:**
- Consumes: `SiteSummary` (Task 4), `VAGUE_ADDRESS_HINT` (Task 2), `locateSiteAction` (Task 4).
- Produces: `UnlocatedSites({ sites }: { sites: SiteSummary[] })` — renders only sites whose `geocodeStatus !== "ok"`.

**Build this BEFORE the map.** It is the spec's §2 requirement, it is fully testable, and it is what stops a site disappearing. The map is the decoration; this is the correctness.

- [ ] **Step 1: Write the failing tests**

Cover: an `ok` site never appears here; `not_found` renders `VAGUE_ADDRESS_HINT`; `pending` reads as not yet located; `failed` offers a retry; the Locate button calls `locateSiteAction` with that site's id; the component renders NOTHING when every site is `ok` (no stray empty panel).

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/UnlocatedSites.test.tsx
```

- [ ] **Step 3: Implement**

`"use client"`. Heading states the count ("2 sites aren't on the map yet"). One row per site: name, code, its status in plain words, and a **Locate** button (`data-testid={`locate-${site.code}`}`). Return `null` when the filtered list is empty. Match the card styling used by `ClientDetail.tsx`.

- [ ] **Step 4: Run the tests, then commit**

```bash
npx vitest run src/features/clients/UnlocatedSites.test.tsx
git add src/features/clients/UnlocatedSites.tsx src/features/clients/UnlocatedSites.test.tsx
git commit -m "feat(clients): surface sites that could not be placed on the map"
```

---

### Task 6: SitesMap

**Files:**
- Create: `src/features/clients/sitesMapOps.ts`, `src/features/clients/sitesMapOps.test.ts`, `src/features/clients/SitesMap.tsx`
- Modify: `package.json`

**Interfaces:**
- Consumes: `SiteSummary` (Task 4).
- Produces: `Blip { id, code, name, lat, lng, rackCount }`; `toBlips(sites: SiteSummary[]): Blip[]`; `boundsOf(blips: Blip[]): [[number,number],[number,number]] | null`; `SitesMap({ blips, clientCode, selectedId, onSelect })`.

Leaflet does not render meaningfully in jsdom, so the logic worth testing is extracted into a pure module and the map itself is verified in the browser. Do not chase DOM assertions against Leaflet.

- [ ] **Step 1: Install**

```bash
npm install leaflet react-leaflet && npm install -D @types/leaflet
```

- [ ] **Step 2: Write the failing tests for the pure ops**

Cover: `toBlips` includes only `ok` sites and drops any with null coordinates (belt and braces — status and coordinates could disagree); `boundsOf` returns `null` for an empty list, a degenerate box for one blip, and a box containing all of several.

- [ ] **Step 3: Implement `sitesMapOps.ts`, then `SitesMap.tsx`**

`"use client"`. `MapContainer` fitted to `boundsOf`, `TileLayer` pointing at OSM with the **required** attribution `&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`, one `Marker` per blip with a `Popup` carrying name, code, rack count and a link to `/clients/${clientCode}/${site.code}`. Clicking a marker calls `onSelect(site.id)`.

Leaflet's default marker icons break under bundlers; set an explicit `L.icon` rather than relying on the defaults.

- [ ] **Step 4: Run the pure tests, typecheck, commit**

```bash
npx vitest run src/features/clients/sitesMapOps.test.ts
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
git add package.json package-lock.json src/features/clients/sitesMapOps.ts src/features/clients/sitesMapOps.test.ts src/features/clients/SitesMap.tsx
git commit -m "feat(clients): sites map with OSM tiles and site blips"
```

---

### Task 7: Wire into the client page and verify in the browser

**Files:**
- Modify: `src/features/clients/ClientDetail.tsx`, `src/features/clients/ClientDetail.test.tsx`

- [ ] **Step 1: Render the map and the unlocated list**

Import the map with `next/dynamic` and `{ ssr: false }` — **Leaflet touches `window` at import time and a direct import breaks the server render**:

```tsx
const SitesMap = dynamic(() => import("./SitesMap").then((m) => m.SitesMap), { ssr: false });
```

Order on the page: breadcrumb → map (only when at least one blip exists) → `UnlocatedSites` → the existing sites table. Selecting a blip highlights its table row; selecting a row highlights its blip.

- [ ] **Step 2: Extend the tests**

Add to `ClientDetail.test.tsx`: with zero geocoded sites no map frame renders (no empty grey rectangle) but the unlocated list does; with a mix, both render. Mock the dynamic map import.

- [ ] **Step 3: Run the tests and typecheck**

```bash
npx vitest run src/features/clients/ClientDetail.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
```

- [ ] **Step 4: Browser verification**

Use the preview tooling; never `npm run dev` in a shell.
1. Open `/clients/acme`. The existing `HQ` site is `pending` → it appears in the unlocated list, not on a map.
2. Click **Locate**. Its address is "12 Main St" → the pre-flight rejects it, status becomes `not_found`, and the hint tells you to add a city and country. **This is the headline behaviour: the site stays visible.**
3. Edit the address to "12 Main St, Manchester, UK" → it geocodes, the map appears, and a blip sits in Manchester.
4. Click the blip → the popup shows the site and its "Open site" link navigates to the site page.
5. Confirm "© OpenStreetMap contributors" is visible on the map.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(clients): show client sites on a map"
```

---

## Self-Review

**Spec coverage:** §3 schema → Task 1. §4 geocoding (pure + network + rate limit + attribution) → Tasks 2, 3, 6. §5 behaviour: geocode on write → Task 4; map and blips → Tasks 6, 7; unlocated list → Task 5; empty states → Task 7. §6 files → all tasks. §7 testing → Tasks 2, 3, 5, 6, 7. §9's open question is answered by `locateSiteAction` (Task 4), making a backfill script unnecessary at this scale.

**Placeholder scan:** no TBD/TODO. Component markup in Tasks 5–7 is bounded by explicit contracts (props, test ids, ordering, required attribution) plus a named file to match styling — consistent with how the clients-directory plan handled UI.

**Type consistency:** `GeocodeResult` (Task 2) flows into Tasks 3 and 4. `SiteSummary`'s new fields (Task 4) are consumed by Tasks 5, 6, 7. `Blip` (Task 6) is produced by `toBlips` and consumed by `SitesMap` and `boundsOf`. `locateSiteAction` is named identically in Tasks 4 and 5.

**Ordering note:** Task 5 deliberately precedes the map. The unlocated list is the correctness requirement (§2); the map is the feature request. Built in this order, the feature is never in a state where a site can silently disappear.
