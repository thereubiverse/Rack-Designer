# Floor Plan Upload & Manual Mapping (Slice B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One uploaded plan per floor (image or PDF page → PNG), with rooms placed as polygon outlines and floor devices as pins in a custom SVG viewer/editor inside the floor tab.

**Architecture:** New `floor_plans` table + normalized 0..1 coordinates on `floor_devices` (x/y) and `rooms` (plan_polygon). Private Supabase Storage bucket, server-side writes, signed URLs for display. Client-side conversion (downscale / pdf.js page render) so storage only ever holds PNG. Custom SVG canvas with per-gesture server actions — no autosave loop, no undo.

**Tech Stack:** Next.js 16, TypeScript strict, Supabase (DB + Storage, local via Docker), pdfjs-dist (only new dependency), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-23-floor-plan-upload-design.md` — read §0–§2 before starting.

## Global Constraints

- **NEVER run vitest against a directory or glob.** `*.integration.test.ts` files here delete rows wholesale and WILL wipe the developer's local database. Run tests by EXPLICIT FILENAME only.
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- No local `psql`. Use `docker exec supabase_db_network-doc-platform psql -U postgres -d postgres`.
- Every migration ends with the THREE blanket grant statements from `0001`'s tail, byte-identical. (`0008` omitted them; two later plans repeated the mistake; reviews caught both.)
- Server actions return `{ ok: boolean; error?: string }` and never throw to the caller.
- Server-side trust posture: `site_id` is derived from the floor row; image dimensions are decoded from the uploaded bytes; polygon payloads are re-validated server-side. NOTHING scope- or geometry-shaped is trusted from the client.
- Coordinates are normalized 0..1. **Placed ⇔ both x and y non-null**; every check is `!= null`, never falsy — `x === 0` is a valid placement (the Null Island lesson).
- The canvas is a projection: clearing a placement NEVER deletes a device or room. Slice A's lists remain the never-silently-vanish backstop.
- Use `command grep` in shells (interactive grep is aliased to a wrapper that chokes on some flags).
- Run commands from the project root; the Bash tool's cwd resets between calls.
- Match the Slice A visual language (cards `rounded-2xl border border-neutral-200 bg-white shadow-sm`, blue primary buttons, shared `input` class).
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Migration 0012 — floor_plans, coordinates, bucket

**Files:**
- Create: `supabase/migrations/0012_floor_plans.sql`
- Modify: `src/lib/supabase/types.ts`

**Interfaces:**
- Produces: `FloorPlanRow { id, floor_id, storage_path, width_px, height_px, original_filename, source: "image" | "pdf", created_at, updated_at }`; `FloorDeviceRow` gains `x: number | null; y: number | null`; `RoomRow` gains `plan_polygon: [number, number][] | null`.

- [ ] **Step 1: Write the migration**

```sql
-- Slice B of the floor-plans programme: one plan per floor, placements normalized 0..1 against
-- it. width/height are the stored PNG's true dimensions (decoded server-side at upload) — needed
-- for aspect ratio and for Slice C to map vision-model output back onto normalized space.
create table floor_plans (
  id                uuid primary key default gen_random_uuid(),
  floor_id          uuid not null references floors(id) on delete cascade,
  storage_path      text not null,
  width_px          integer not null check (width_px > 0),
  height_px         integer not null check (height_px > 0),
  original_filename text not null default '',
  source            text not null default 'image' check (source in ('image', 'pdf')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (floor_id)
);

-- Placement: BOTH null (unplaced) or BOTH set (placed). App-enforced; the check makes the
-- half-set state unrepresentable at the DB level too.
alter table floor_devices add column x double precision;
alter table floor_devices add column y double precision;
alter table floor_devices add constraint floor_devices_xy_together
  check ((x is null) = (y is null));

alter table rooms add column plan_polygon jsonb;

-- First persisted binaries in the app: private bucket, server-side writes only.
insert into storage.buckets (id, name, public)
  values ('floor-plans', 'floor-plans', false)
  on conflict (id) do nothing;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

- [ ] **Step 2: Apply and verify**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0012_floor_plans.sql
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "\d floor_plans"
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t -c "select id, public from storage.buckets where id='floor-plans';"
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t -c "select count(*) from floor_devices where (x is null) <> (y is null);"
```

Expected: table + unique(floor_id) + both checks; bucket row `floor-plans | f`; xy-together count 0. Existing data untouched (re-count sites/floors/rooms/racks/floor_devices before and after).

- [ ] **Step 3: Update types, typecheck, commit**

Add `FloorPlanRow` (source as the literal union), extend `FloorDeviceRow` and `RoomRow` as in Interfaces. Existing Slice A tests hard-code `FloorDeviceRow`/`RoomRow` fixtures — widening with new NULLABLE fields breaks object-literal fixtures. Update ONLY fixture literals (add `x: null, y: null` / `plan_polygon: null`), never assertions; list every touched test file in the report.

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
npx vitest run src/features/clients/floorDeviceOps.test.ts
npx vitest run src/features/clients/FloorDevicesPanel.test.tsx
npx vitest run src/features/clients/SiteDetail.test.tsx
git add supabase/migrations/0012_floor_plans.sql src/lib/supabase/types.ts src/features/clients/floorDeviceOps.test.ts src/features/clients/FloorDevicesPanel.test.tsx src/features/clients/SiteDetail.test.tsx
git commit -m "feat(db): floor plans, placement coordinates, storage bucket"
```

Expected: tsc silent; the three suites green with fixture-only diffs.

---

### Task 2: Pure floorPlanOps (TDD)

**Files:**
- Create: `src/features/clients/floorPlanOps.ts`, `src/features/clients/floorPlanOps.test.ts`

**Interfaces:**
- Produces:
  - `type NormPoint = [number, number]`
  - `isNorm(v: number): boolean` — finite && 0..1 inclusive
  - `isValidPolygon(p: unknown): p is NormPoint[]` — array, ≥3 vertices, every pair `[isNorm, isNorm]`
  - `insertVertexOnEdge(polygon: NormPoint[], edgeIndex: number): NormPoint[]` — midpoint of edge i→i+1 (wrapping), pure/new array
  - `removeVertex(polygon: NormPoint[], index: number): NormPoint[]` — returns the SAME polygon unchanged if length would drop below 3
  - `polygonCentroid(polygon: NormPoint[]): NormPoint` — arithmetic mean (label anchor, not area centroid — cheap and stable for labels)
  - `partitionPlacement(devices: FloorDeviceRow[]): { placed: FloorDeviceRow[]; unplaced: FloorDeviceRow[] }` — the both-non-null rule in ONE place, `!= null` checks
  - `screenToNorm(screen: {x,y}, view: {panX, panY, zoom, imgW, imgH}): NormPoint | null` — null when outside 0..1
  - `normToScreen(p: NormPoint, view): {x, y}`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import type { FloorDeviceRow } from "@/lib/supabase/types";
import {
  isNorm, isValidPolygon, insertVertexOnEdge, removeVertex,
  polygonCentroid, partitionPlacement, screenToNorm, normToScreen,
} from "./floorPlanOps";

function device(over: Partial<FloorDeviceRow>): FloorDeviceRow {
  return {
    id: "d1", site_id: "s1", floor_id: "f1", room_id: null, device_type_id: "t1",
    code: "CAM01", name: "", status: "planned", x: null, y: null,
    created_at: "2026-01-01", updated_at: "2026-01-01", ...over,
  };
}

describe("isNorm / isValidPolygon", () => {
  it("accepts 0 and 1 (edges are real placements — the Null Island lesson)", () => {
    expect(isNorm(0)).toBe(true);
    expect(isNorm(1)).toBe(true);
  });
  it("rejects out-of-range, NaN, Infinity", () => {
    for (const v of [-0.001, 1.001, NaN, Infinity, -Infinity]) expect(isNorm(v)).toBe(false);
  });
  it("rejects polygons below 3 vertices and malformed shapes, never throws", () => {
    for (const bad of [null, "x", [], [[0, 0]], [[0, 0], [1, 1]], [[0, 0], [1, 1], [0.5]], [[0, 0], [1, 1], [0.5, 2]]]) {
      expect(isValidPolygon(bad)).toBe(false);
    }
  });
  it("accepts a triangle on the exact edges", () => {
    expect(isValidPolygon([[0, 0], [1, 0], [0.5, 1]])).toBe(true);
  });
});

describe("insertVertexOnEdge / removeVertex", () => {
  const tri: [number, number][] = [[0, 0], [1, 0], [0.5, 1]];
  it("inserts the midpoint of the WRAPPING edge (last->first)", () => {
    const out = insertVertexOnEdge(tri, 2);
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual([0.25, 0.5]);
  });
  it("does not mutate its input", () => {
    insertVertexOnEdge(tri, 0);
    expect(tri).toHaveLength(3);
  });
  it("refuses to remove below 3 vertices — returns the polygon unchanged", () => {
    expect(removeVertex(tri, 1)).toEqual(tri);
  });
  it("removes from a quad", () => {
    const quad: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(removeVertex(quad, 3)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});

describe("partitionPlacement", () => {
  it("x=0, y=0 is PLACED — falsy checks are the bug this test exists to catch", () => {
    const d = device({ id: "edge", x: 0, y: 0 });
    const { placed, unplaced } = partitionPlacement([d]);
    expect(placed.map((p) => p.id)).toEqual(["edge"]);
    expect(unplaced).toEqual([]);
  });
  it("half-set coordinates count as unplaced (defensive; DB forbids the state)", () => {
    const { unplaced } = partitionPlacement([device({ x: 0.5, y: null })]);
    expect(unplaced).toHaveLength(1);
  });
});

describe("screenToNorm / normToScreen", () => {
  const view = { panX: 10, panY: 20, zoom: 2, imgW: 1000, imgH: 500 };
  it("round-trips", () => {
    const screen = normToScreen([0.25, 0.5], view);
    expect(screenToNorm(screen, view)).toEqual([0.25, 0.5]);
  });
  it("returns null outside the image", () => {
    expect(screenToNorm({ x: -1e9, y: 0 }, view)).toBeNull();
  });
  it("maps the origin corner exactly to [0,0]", () => {
    expect(screenToNorm({ x: 10, y: 20 }, view)).toEqual([0, 0]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/floorPlanOps.test.ts
```
Expected: FAIL — cannot resolve `./floorPlanOps`.

- [ ] **Step 3: Implement**

```ts
import type { FloorDeviceRow } from "@/lib/supabase/types";

export type NormPoint = [number, number];

export interface PlanView { panX: number; panY: number; zoom: number; imgW: number; imgH: number }

export function isNorm(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

/** ≥3 vertices, every entry a [0..1, 0..1] pair. Never throws — Slice C will feed this
 *  model-generated JSON, so it must shrug at any shape. */
export function isValidPolygon(p: unknown): p is NormPoint[] {
  if (!Array.isArray(p) || p.length < 3) return false;
  return p.every(
    (pt) => Array.isArray(pt) && pt.length === 2 &&
      typeof pt[0] === "number" && typeof pt[1] === "number" && isNorm(pt[0]) && isNorm(pt[1])
  );
}

/** Midpoint insertion on edge i -> i+1 (wrapping), returning a new array. */
export function insertVertexOnEdge(polygon: NormPoint[], edgeIndex: number): NormPoint[] {
  const a = polygon[edgeIndex];
  const b = polygon[(edgeIndex + 1) % polygon.length];
  const mid: NormPoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const out = [...polygon];
  out.splice(edgeIndex + 1, 0, mid);
  return out;
}

/** A polygon must keep ≥3 vertices; below that, the removal is refused (same polygon back). */
export function removeVertex(polygon: NormPoint[], index: number): NormPoint[] {
  if (polygon.length <= 3) return polygon;
  return polygon.filter((_, i) => i !== index);
}

/** Arithmetic mean — a stable, cheap label anchor (not the area centroid; labels don't care). */
export function polygonCentroid(polygon: NormPoint[]): NormPoint {
  const n = polygon.length;
  return [
    polygon.reduce((s, p) => s + p[0], 0) / n,
    polygon.reduce((s, p) => s + p[1], 0) / n,
  ];
}

/** THE both-non-null rule, in one place. `!= null`, never falsy — x === 0 is a real placement. */
export function partitionPlacement(devices: FloorDeviceRow[]): {
  placed: FloorDeviceRow[]; unplaced: FloorDeviceRow[];
} {
  const placed = devices.filter((d) => d.x != null && d.y != null);
  const unplaced = devices.filter((d) => d.x == null || d.y == null);
  return { placed, unplaced };
}

export function normToScreen(p: NormPoint, view: PlanView): { x: number; y: number } {
  return { x: view.panX + p[0] * view.imgW * view.zoom, y: view.panY + p[1] * view.imgH * view.zoom };
}

export function screenToNorm(screen: { x: number; y: number }, view: PlanView): NormPoint | null {
  const nx = (screen.x - view.panX) / (view.imgW * view.zoom);
  const ny = (screen.y - view.panY) / (view.imgH * view.zoom);
  if (!isNorm(nx) || !isNorm(ny)) return null;
  return [nx, ny];
}
```

- [ ] **Step 4: Run (PASS), commit**

```bash
npx vitest run src/features/clients/floorPlanOps.test.ts
git add src/features/clients/floorPlanOps.ts src/features/clients/floorPlanOps.test.ts
git commit -m "feat(clients): pure floor-plan geometry and placement ops"
```

---

### Task 3: Plan storage server layer (PNG decode, storage helper, upload/delete actions)

**Files:**
- Create: `src/features/clients/pngHeader.ts`, `src/features/clients/pngHeader.test.ts`, `src/features/clients/planStorage.ts`
- Modify: `src/features/locations/repository.ts`, `src/features/clients/actions.ts`
- Create: `src/features/clients/planActions.test.ts`

**Interfaces:**
- Produces:
  - `readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null` — pure; null for non-PNG/truncated input, never throws.
  - `planStorage.ts` (server-only, thin so tests can fake it): `uploadPlanObject(db, path, bytes)`, `createPlanSignedUrl(db, path): Promise<string | null>`, `removePlanObject(db, path)` — wrap `db.storage.from("floor-plans")` `.upload(path, bytes, { upsert: true, contentType: "image/png" })` / `.createSignedUrl(path, 3600)` / `.remove([path])`, each throwing `new Error(\`fnName: ${error.message}\`)` on error, house style.
  - Repository: `getFloorPlan(db, floorId): Promise<FloorPlanRow | null>`; `upsertFloorPlan(db, input: { floorId, storagePath, widthPx, heightPx, originalFilename, source })` (reads the floor row first — floor must exist; `.upsert` on `floor_id` conflict); `deleteFloorPlan(db, floorId)` — deletes the row AND nulls this floor's device x/y AND its rooms' plan_polygon (three writes, one function — the "clears placements in the same flow" contract).
  - Actions: `uploadFloorPlanAction(formData)` — fields `floorId`, `file` (Blob). Validates: floor exists (derive site for the storage path), bytes ≤ 15MB, `readPngDimensions` succeeds (rejects non-PNG BEFORE any storage write). Path `{siteId}/{floorId}.png`. Uploads, then upserts the row with the DECODED dimensions. `source` field: `formData.get("source")` validated against `["image","pdf"]` (the client knows what it converted; it only affects the label). `deleteFloorPlanAction(formData)` — `floorId`; removes the object (best-effort — a missing object must not block the row+placements cleanup; wrap in its own try/catch) then `deleteFloorPlan`.

- [ ] **Step 1: pngHeader TDD.** Tests: a real 1x1 PNG fixture (hex literal in the test: `89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489…` — only the first 24 bytes matter for the parse, supply 33 bytes through IHDR CRC), width/height decoded big-endian from offsets 16..19 and 20..23 after verifying the 8-byte signature and `IHDR` at offsets 12..15; truncated buffers (0, 8, 20 bytes) → null; JPEG magic (`ffd8ff…`) → null; never throws for any input. RED → implement (~15 lines, DataView) → GREEN. Run: `npx vitest run src/features/clients/pngHeader.test.ts`

- [ ] **Step 2: planStorage + repository functions** (code per Interfaces; transcribe the contracts exactly — error prefixes are the function names). `deleteFloorPlan`:

```ts
export async function deleteFloorPlan(db: SupabaseClient, floorId: string): Promise<void> {
  const { error: planErr } = await db.from("floor_plans").delete().eq("floor_id", floorId);
  if (planErr) throw new Error(`deleteFloorPlan: ${planErr.message}`);
  const { error: devErr } = await db.from("floor_devices")
    .update({ x: null, y: null }).eq("floor_id", floorId);
  if (devErr) throw new Error(`deleteFloorPlan: ${devErr.message}`);
  const { error: roomErr } = await db.from("rooms")
    .update({ plan_polygon: null }).eq("floor_id", floorId);
  if (roomErr) throw new Error(`deleteFloorPlan: ${roomErr.message}`);
}
```

- [ ] **Step 3: Actions + DB-free tests (planActions.test.ts, RED then GREEN).** Mock `@/lib/supabase/server`, `next/cache`, AND `./planStorage` (plain vi.fn()s). Fake db per the established table-aware pattern (read Task 3/4 test files from Slice A first). Cover, asserting real recorded arguments:
  1. Upload with a valid PNG byte payload → `uploadPlanObject` called with path `SITE-A/f1.png` (site derived from the floors lookup, never FormData) and the row upserted with the DECODED width/height — feed bytes whose IHDR says 640x480 and assert 640/480 landed, proving client-reported dimensions are ignored (send misleading `width` fields in the FormData to prove it).
  2. Non-PNG bytes → `{ok: false}`, `uploadPlanObject` NEVER called (rejected before any storage write).
  3. Oversize (>15MB — fake a 16MB byte length without allocating: `new Uint8Array(...)` is fine at 16MB, or stub `.size`) → `{ok: false}`, no storage call.
  4. Unknown floor → `{ok: false}`, no storage call.
  5. Delete: `removePlanObject` rejection (missing object) does NOT prevent `deleteFloorPlan` — row delete + both placement-clearing updates all recorded.
  6. Delete: all three clearing writes carry the right floorId filter.
- [ ] **Step 4: Run named files + tsc, commit**

```bash
npx vitest run src/features/clients/pngHeader.test.ts
npx vitest run src/features/clients/planActions.test.ts
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/clients/pngHeader.ts src/features/clients/pngHeader.test.ts src/features/clients/planStorage.ts src/features/locations/repository.ts src/features/clients/actions.ts src/features/clients/planActions.test.ts
git commit -m "feat(clients): floor plan storage layer with server-decoded dimensions"
```

---

### Task 4: Placement server layer

**Files:**
- Modify: `src/features/locations/repository.ts`, `src/features/clients/actions.ts`
- Create: `src/features/clients/placementActions.test.ts`

**Interfaces:**
- Consumes: `isValidPolygon`, `isNorm` (Task 2).
- Produces (repository): `placeFloorDevice(db, id, { x, y })` — rejects unless both `isNorm` (throw `placeFloorDevice: coordinates must be within the plan`); `clearFloorDevicePlacement(db, id)` — nulls both; `setRoomPolygon(db, roomId, polygon)` — `isValidPolygon` or throw `setRoomPolygon: invalid polygon`; `clearRoomPolygon(db, roomId)`.
- Produces (actions): `placeFloorDeviceAction` (`id`, `x`, `y` as strings → Number), `clearFloorDevicePlacementAction` (`id`), `setRoomPolygonAction` (`roomId`, `polygon` as JSON string — `JSON.parse` inside try/catch: malformed JSON → `{ok:false}`, never a throw), `clearRoomPolygonAction` (`roomId`). All house-shaped.

- [ ] **Step 1: Tests RED (placementActions.test.ts).** Cover with real recorded args: place with x=0, y=0 → update carries `{x: 0, y: 0}` (the edge IS valid — a falsy-check regression fails here); place with x=1.5 → `{ok:false}`, no update; clear → update carries `{x: null, y: null}`; setRoomPolygon with a valid triangle → update carries the parsed array; 2-vertex payload → `{ok:false}`, no update; malformed JSON string → `{ok:false}`, no throw, no update; clearRoomPolygon → `{plan_polygon: null}` on the right roomId.
- [ ] **Step 2: Implement repository + actions. GREEN.**
- [ ] **Step 3: Run named file + Slice A action suites (same touched files) + tsc, commit**

```bash
npx vitest run src/features/clients/placementActions.test.ts
npx vitest run src/features/clients/floorActions.test.ts
npx vitest run src/features/clients/floorDeviceActions.test.ts
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/locations/repository.ts src/features/clients/actions.ts src/features/clients/placementActions.test.ts
git commit -m "feat(clients): placement actions for pins and room polygons"
```

---

### Task 5: Upload UI — dropzone, conversion, page picker

**Files:**
- Create: `src/features/clients/planUpload.ts`, `src/features/clients/PlanUploadZone.tsx`, `src/features/clients/PlanUploadZone.test.tsx`
- Modify: `package.json` (`pdfjs-dist`)

**Interfaces:**
- Consumes: `uploadFloorPlanAction` (Task 3).
- Produces: `PlanUploadZone({ floorId, hasPlan }: { floorId: string; hasPlan: boolean })` — the dropzone card (no plan) or a compact "Replace plan" affordance (plan exists, with the "Placements kept — check them against the new plan." notice on success). `planUpload.ts`: `convertImageFile(file): Promise<{ blob: Blob; source: "image" }>` (downscale ≤3000px long edge via canvas, PNG re-encode) and `convertPdfPage(file, pageIndex): Promise<{ blob: Blob; source: "pdf" }>` plus `getPdfPageCount(file)` — all browser-only.

**pdf.js integration (the known trap — follow exactly):**
- `npm install pdfjs-dist`
- Worker setup in `planUpload.ts`:
  ```ts
  import * as pdfjs from "pdfjs-dist";
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  ```
  `new URL(..., import.meta.url)` is supported by both Turbopack (dev) and webpack (build). **Contingency, use only if the dev server cannot resolve the worker URL:** copy `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` to `public/pdf.worker.min.mjs` and set `workerSrc = "/pdf.worker.min.mjs"`; record which path was needed in your report.
- Render: `getDocument({ data: await file.arrayBuffer() }).promise` → `doc.getPage(i + 1)` → viewport scaled so the long edge ≈ 2600px → render to an offscreen canvas → `canvas.toBlob("image/png")`.

**Component contract (tests mock `planUpload.ts` and the action — jsdom renders no PDFs or canvases):**
- No plan: dropzone card (`data-testid="plan-dropzone"`), accepts drop + file input (`accept="image/png,image/jpeg,image/webp,application/pdf"`).
- Image file → `convertImageFile` → action called with the converted blob and this floorId (assert FormData: floorId, source "image").
- PDF with ONE page → converts page 0 directly, no picker.
- PDF with MULTIPLE pages → page picker renders (`data-testid="pdf-page-picker"`, one option per page); choosing page 3 (NON-first — the standing rule) calls `convertPdfPage(file, 2)` and uploads with source "pdf".
- Action failure → inline error, zone stays usable. Success → `router.refresh()` + (replace case) the placements-kept notice.
- Reject files > 15MB client-side with an inline message BEFORE conversion (`data-testid="plan-too-big"`).

- [ ] **Step 1: Tests RED** (all conversion fns mocked; assert real FormData values and mock args).
- [ ] **Step 2: Implement `planUpload.ts` + component. GREEN.**
- [ ] **Step 3: Run named file + tsc, commit**

```bash
npx vitest run src/features/clients/PlanUploadZone.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add package.json package-lock.json src/features/clients/planUpload.ts src/features/clients/PlanUploadZone.tsx src/features/clients/PlanUploadZone.test.tsx
git commit -m "feat(clients): plan upload zone with client-side image/PDF conversion"
```

---

### Task 6: FloorPlanCanvas — view mode

**Files:**
- Create: `src/features/clients/FloorPlanCanvas.tsx`, `src/features/clients/FloorPlanCanvas.test.tsx`

**Interfaces:**
- Consumes: `normToScreen`, `polygonCentroid`, `partitionPlacement` (Task 2).
- Produces: `FloorPlanCanvas({ plan, planUrl, rooms, devices, deviceTypes, editable }: { plan: FloorPlanRow; planUrl: string; rooms: RoomRow[]; devices: FloorDeviceRow[]; deviceTypes: DeviceTypeRow[]; editable: boolean })` — `"use client"`. Task 7 adds the edit-mode internals; this task renders view mode and the mode toggle shell (`editable` gates whether the "Edit layout" toggle shows at all — Task 8 passes true).

**Contract (view mode):**
- SVG root `data-testid="floor-plan-canvas"`, explicit height (~560px), full pane width, `<image>` with `planUrl` sized by the plan's aspect ratio, fitted on mount.
- Pan: pointer-drag on empty space (pointer capture; no text selection — `no-select-ui`). Wheel zoom about the cursor, **the settled zoom discipline**: no CSS transition on the transform (SVG attribute transform, instant application — small steps at event rate read smooth), snap-free continuous zoom is FINE here because nothing rounds positions (everything is one `<g transform>`; there is no per-marker rounding — the Leaflet wiggle mechanism does not exist in this architecture; note this in a comment), pinch (ctrlKey wheel) scaled gentler than scroll (divisor ~3x — the trackpad-pinch lesson).
- Rooms with `plan_polygon`: `<polygon>` translucent blue (`fill` `rgb(59 130 246 / 0.10)`, `stroke` `#2563eb`), label chip (room code) at `polygonCentroid`, `data-testid={"plan-room-" + room.code}`.
- Placed devices (`partitionPlacement`): pin glyph + code chip at `normToScreen([x, y])`, status-tinted (planned `#525252`, installed `#15803d`), `data-testid={"plan-pin-" + device.code}`.
- Devices/rooms with no placement: simply absent here (the Slice A lists below the canvas remain their home — never-silently-vanish holds by construction, and Task 8's tests assert the lists still render).
- Zoom controls: small +/- buttons (house zoom-control styling from globals.css sites-map rules is Leaflet-scoped; make lightweight equivalents inline).

**Tests (jsdom — geometry only, no image loading):** rooms with polygons render `plan-room-*` with the right point count; placed pins render at computed positions (assert the transform/cx of a NON-first device against a hand-computed normToScreen value); unplaced devices produce NO pin; x=0/y=0 device DOES render a pin (edge-placement pin — the falsy-check tripwire at the component layer); `editable={false}` hides the toggle. Pan/zoom/image rendering: browser-verified in Task 8, per the sites-map convention.

- [ ] **Step 1: Tests RED.** — [ ] **Step 2: Implement. GREEN.** — [ ] **Step 3: named file + tsc, commit**

```bash
npx vitest run src/features/clients/FloorPlanCanvas.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/clients/FloorPlanCanvas.tsx src/features/clients/FloorPlanCanvas.test.tsx
git commit -m "feat(clients): floor plan SVG canvas, view mode"
```

---

### Task 7: FloorPlanCanvas — edit mode

**Files:**
- Modify: `src/features/clients/FloorPlanCanvas.tsx`, `src/features/clients/FloorPlanCanvas.test.tsx`

**Interfaces:**
- Consumes: placement actions (Task 4), `screenToNorm`, `insertVertexOnEdge`, `removeVertex`, `isValidPolygon` (Task 2).
- Produces: edit mode inside the same component. No prop changes beyond Task 6's signature.

**Contract (edit mode, entered via the "Edit layout" toggle `data-testid="edit-layout-toggle"`):**
- **Tray** (`data-testid="plan-tray"`): section "Devices not on the plan" (from `partitionPlacement().unplaced`; each `data-testid={"tray-device-" + code}`) and "Rooms not outlined" (rooms with null polygon; `data-testid={"tray-room-" + code}`). Tray sections render only when non-empty; when both are empty and nothing is selected the tray shows "Everything is placed".
- **Place device**: select tray device → crosshair state → click on the plan → `placeFloorDeviceAction` with that device id and the `screenToNorm` coordinates (clicks outside the image are ignored — `screenToNorm` null). 
- **Move device**: drag a pin → action on pointer-up with final coordinates (one action call per completed drag, never per move event).
- **Un-place**: selected pin + Delete key or the pin popover's "Remove from plan" → `clearFloorDevicePlacementAction(id)`. Copy says "Remove from plan" — never "Delete".
- **Draw room**: select tray room → click vertices (live rubber-band edge to cursor — the spec's optional nicety, included) → Enter or double-click closes when ≥3 → `setRoomPolygonAction(roomId, JSON.stringify(points))`; Esc cancels cleanly.
- **Edit room**: click polygon selects; vertex handles (`data-testid` `vertex-{roomCode}-{i}`) drag → action on pointer-up; edge midpoints render insert handles (click → `insertVertexOnEdge` locally, action on next commit); Delete on a selected vertex uses `removeVertex` (refusal below 3 leaves state unchanged); "Clear outline" button → `clearRoomPolygonAction`.
- Every action result handled house-style: `{ok:false}` → inline error banner in the canvas header (`data-testid="canvas-error"`), success → `router.refresh()`.

**Tests (mock all four actions + next/navigation):** the placement flow end-to-end with fireEvent pointer/click sequences on a NON-first tray device, asserting the action's real FormData (id + numeric x/y within 0..1); drag-commits-once semantics (pointermove ×3 → pointerup → exactly ONE action call); draw-room flow closing at 3 vertices with Enter and the resulting JSON parsing to a valid polygon; sub-3 Enter does nothing; Esc leaves no action call; un-place calls clear with THAT pin's id (multi-pin fixture, non-first); vertex-delete refusal below 3.

- [ ] **Step 1: Tests RED.** — [ ] **Step 2: Implement. GREEN.** — [ ] **Step 3: named file + tsc, commit**

```bash
npx vitest run src/features/clients/FloorPlanCanvas.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/clients/FloorPlanCanvas.tsx src/features/clients/FloorPlanCanvas.test.tsx
git commit -m "feat(clients): floor plan edit mode — pins, polygons, tray"
```

---

### Task 8: Wire into the floor tab + browser verification

**Files:**
- Modify: `src/app/clients/[clientCode]/[siteCode]/page.tsx`, `src/features/clients/SiteDetail.tsx`, `src/features/clients/SiteDetail.test.tsx`, `src/features/clients/DeleteDialog.tsx`, `src/features/clients/DeleteDialog.test.tsx`

**Interfaces:**
- Consumes: everything above. `SiteDetail` props gain `plans: FloorPlanRow[]` and `planUrls: Record<string, string>` (floorId → signed URL, generated in the server page via `createPlanSignedUrl`).

- [ ] **Step 1: Page loader.** Fetch plans for the site's floors (add `listFloorPlansForSite(db, siteId)` to the repository — floors lookup then `.in("floor_id", ...)`) in the existing `Promise.all`; generate signed URLs server-side for each.
- [ ] **Step 2: SiteDetail.** Inside the active floor tab, above the Slice A panel: plan present → `FloorPlanCanvas` (editable) + a plan header row ("Replace plan" via `PlanUploadZone hasPlan`, "Delete plan" → `DeleteDialog` new `kind="plan"` with note `"N device pins and N room outlines will be cleared."` — counts client-computed from props, the established pattern; devices/rooms NOT in `counts` — nothing is destroyed, so the typed gate stays off and the note carries the message). Plan absent → `PlanUploadZone`. Slice A lists render below in both cases.
- [ ] **Step 3: DeleteDialog `kind="plan"`** (RED first in its test file: heading `Delete plan "GF"?` — code = floor code — plus the note rendering with empty counts, the combo Slice A left unpinned; add the ungated-confirm assertion this time).
- [ ] **Step 4: SiteDetail tests.** Fixture gains a plan on ONE of the two floors: canvas renders on that floor's tab with the right signed URL; the OTHER floor shows the dropzone; Slice A lists render below the canvas in BOTH cases (never-silently-vanish wiring proof); delete-plan dialog shows the hand-computed note counts.
- [ ] **Step 5: Run named files + tsc**

```bash
npx vitest run src/features/clients/SiteDetail.test.tsx
npx vitest run src/features/clients/DeleteDialog.test.tsx
npx vitest run src/features/clients/FloorPlanCanvas.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
```

- [ ] **Step 6: Browser verification (controller-driven; preview tooling, never `npm run dev` in a shell; restart the dev server clean first — session rule).**
  1. `/clients/uri/hq?floor=GF` — dropzone visible. Upload a PNG (generate a synthetic 2000×1400 plan with labeled rectangles if no real plan is provided). Canvas appears; DB row has decoded dimensions; storage object exists (`select * from storage.objects where bucket_id='floor-plans';`).
  2. Upload a MULTI-PAGE PDF to floor 1F — page picker appears; choose page 2; verify the rendered page (not page 1) displays. **This live PDF step is the pdfjs worker's proof — jsdom never exercises it.**
  3. Edit layout: place CAM01 (tray → click) — pin appears; drag it; reload → position survives (DB values 0..1). Place a device at the plan's extreme top-left corner and confirm x≈0 persists and renders after reload (the 0-edge live).
  4. Draw a polygon for room MDF (≥4 vertices, one insert, one vertex delete); reload → outline survives. Esc mid-draw leaves nothing.
  5. Un-place CAM01 from the canvas → pin gone, device still listed in the Slice A panel below (never-silently-vanish live).
  6. Replace GF's plan with a different-size image → placements kept, notice shown.
  7. Delete 1F's plan → dialog note counts correct; after confirm, placements cleared, dropzone back, devices/rooms all still in the lists.
  8. Pan/zoom feel: scroll and pinch on the canvas — no blanking, no wiggle (nothing rounds), pinch gentler than scroll.
  9. WSS2 (real data): no plan → dropzone, lists intact, nothing regressed.

- [ ] **Step 7: Commit**

```bash
git add src/app/clients/[clientCode]/[siteCode]/page.tsx src/features/clients/SiteDetail.tsx src/features/clients/SiteDetail.test.tsx src/features/clients/DeleteDialog.tsx src/features/clients/DeleteDialog.test.tsx src/features/locations/repository.ts
git commit -m "feat(clients): floor plans live in the floor tab"
```

---

## Self-Review

**Spec coverage:** §2 schema+bucket → Task 1. §3 storage/signed URLs/trust → Tasks 3, 8. §4 pipeline (downscale, pdf page picker, replace/delete semantics) → Tasks 3, 5, 8. §5 viewer/editor (view, edit, gestures, per-gesture actions, never-vanish) → Tasks 6, 7, 8. §6 server layer → Tasks 3, 4. §7 pure ops → Task 2. §8 testing conventions → every task. §10's two niceties resolved: tray placement left to implementer within the contract; rubber-band edge INCLUDED (Task 7).

**Placeholder scan:** none. UI tasks are contract-bound (props, test ids, exact copy, behaviours) per the repo's established plan convention; server and pure code are written in full.

**Type consistency:** `NormPoint`/`PlanView` (Task 2) flow into Tasks 4, 6, 7. `FloorPlanRow` (Task 1) → Tasks 3, 6, 8. Action names in Task 4 match Task 7's consumption exactly (`placeFloorDeviceAction`, `clearFloorDevicePlacementAction`, `setRoomPolygonAction`, `clearRoomPolygonAction`). `partitionPlacement` shape `{placed, unplaced}` consistent across Tasks 2, 6, 7. `planUrls: Record<string, string>` keyed by floorId in both Task 8 steps.

**Session lessons encoded:** three-grant tail (Task 1); `!= null` + 0-edge tests at THREE layers (ops, actions, canvas, live); server-side trust for dimensions and scope (Task 3, with a test that actively lies in FormData); mutation-direction discipline is the reviewer's to enforce; the zoom architecture avoids Leaflet's rounding mechanism entirely and documents WHY in a comment (Task 6); non-first fixtures throughout; pdf.js worker contingency named (Task 5).
