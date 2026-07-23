# Floor Plan Upload & Manual Mapping (Slice B) — Design

**Status:** design agreed 2026-07-23; NOT yet planned or built.
**Build this in a fresh session:** run `superpowers:writing-plans` against this spec, then
`superpowers:subagent-driven-development`.

**Goal:** Each floor can carry one uploaded plan (image or PDF page), and rooms and floor devices
can be placed on it by hand — polygon outlines for rooms, pins for devices — in an SVG
viewer/editor living in the floor tab.

---

## 0. Where this sits — the four-slice roadmap

| Slice | Delivers | Status |
|---|---|---|
| A | Floor tabs, floor/room CRUD, `floor_devices` inventory | **MERGED** (a029832, 2026-07-22) |
| **B (this spec)** | Plan upload + storage + manual mapping editor | designing |
| C | AI discovery: Gemini reads the plan, proposes room polygons/names and device pins; user adjusts in B's editor | after B |
| D | Port linkage: ports reference floor devices; room/device picker in port settings; `described`-endpoint migration | after A (UI benefits from B) |

Binding facts from Slice A this spec builds on: `floor_devices` is the unified inventory (a device
exists whether or not it is placed or patched); devices never silently vanish (unknown/absent
placement falls back to the Slice A lists); the floor tab pane is full-width precisely so this
slice's canvas can drop in.

## 1. Decisions taken

| Decision | Choice |
|---|---|
| Accepted formats | **PNG/JPG/WebP + PDF**. PDFs convert to PNG in the browser at upload (chosen page, `pdfjs-dist`) — what's stored is ALWAYS a plain raster image, which Slice C's vision model reads directly |
| Room representation on the plan | **Full polygons** (user's explicit call over rectangles): faithful outlines, vertex editing in the editor. AI polygons (C) will be rougher than boxes — the editor is the corrective |
| Devices on the plan | Point pins, one per device, optional (unplaced devices stay in the Slice A lists) |
| Canvas technology | **Custom SVG** viewer/editor — the repo's established muscle (faceplate editor, rack canvas, patch layer); no new rendering dependency; polygon vertex editing is natural in SVG and unit-testable as pure ops |
| Coordinates | **Normalized 0..1** relative to the plan image, not pixels — placements survive re-uploads at different resolutions |
| Plans per floor | Exactly one (`unique(floor_id)`); replacement keeps placements with a notice; deletion clears them behind the typed-confirm gate |
| Storage | Private Supabase Storage bucket `floor-plans`; server-side writes via service client; signed URLs for display. First persisted binaries in the app |
| Save model | Per-gesture server actions (place/clear/setPolygon/clearPolygon) — no autosave machinery, no undo stack in this slice |
| Blank grid | **Skipped** (PatchDocs allows placing devices with no plan; we don't — Slice A's lists serve plan-less floors, canvas renders only when a plan exists) |

## 2. Schema — migration `0012_floor_plans.sql`

```sql
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

alter table floor_devices add column x double precision;
alter table floor_devices add column y double precision;
alter table rooms add column plan_polygon jsonb;
```

- Ends with the same THREE blanket grant statements every migration carries (the 0008 lesson,
  twice relearned; copy `0001`'s tail verbatim).
- `x`/`y` normalized 0..1; **placed ⇔ both non-null** — the repository enforces both-or-neither.
- `plan_polygon` is a JSON array of `[x, y]` pairs, normalized, **minimum 3 vertices** — validated
  in the pure ops AND rejected server-side (never trust the client shape).
- `width_px`/`height_px` are the stored image's true dimensions — needed for aspect ratio and for
  Slice C to map model output back onto normalized space.
- Storage bucket creation: `insert into storage.buckets (id, name, public) values
  ('floor-plans', 'floor-plans', false) on conflict do nothing;` in the same migration.

Types: `FloorPlanRow` added to `src/lib/supabase/types.ts` (`source` as the literal union);
`FloorDeviceRow` gains `x: number | null; y: number | null`; `RoomRow` gains
`plan_polygon: [number, number][] | null`.

## 3. Storage & serving

- Bucket `floor-plans`, private. Path convention: `{siteId}/{floorId}.png` — one object per floor,
  replacement overwrites (`upsert: true`).
- Uploads go through a server action (service client). The action validates: content type
  `image/png` (the client always converts to PNG before upload), byte size ≤ 15MB, and that the
  target floor exists (deriving `site_id` server-side — same discipline as `floor_devices`).
- Display: the site page's server component generates a **signed URL** (1 hour) per floor plan at
  load. The client never sees service credentials and the bucket never goes public.
- Local dev: the Supabase storage container already runs in the Docker stack; no new
  infrastructure.

## 4. Upload pipeline (client-side, conversion happens exactly once)

- Dropzone in the floor tab when no plan exists ("Upload a floor plan — PNG, JPG, WebP or PDF").
- Images: downscale in-browser to ≤ 3000px long edge (canvas), re-encode PNG, upload.
- PDFs: `pdfjs-dist` (the slice's only new dependency) renders in the browser. Multi-page PDFs
  show a page picker (thumbnails); the chosen page renders at high resolution (~2600px long edge)
  to PNG and THAT uploads. The PDF itself is never stored.
- The action records `width_px`/`height_px` by decoding them SERVER-SIDE from the uploaded bytes —
  a PNG's dimensions sit in its IHDR chunk (bytes 16–24), readable with no image library. Client-
  reported dimensions are never trusted; a non-PNG or unparsable payload is rejected before any
  storage write.
- **Replace** (a plan exists): same pipeline, overwrites the object, updates the row, keeps every
  placement, shows "Placements kept — check them against the new plan."
- **Delete plan**: typed-confirm `DeleteDialog` (kind `"plan"` — extend the union) with a note
  carrying real counts: "N device pins and N room outlines will be cleared." Clearing nulls
  `x`/`y` and `plan_polygon` for the floor; devices and rooms themselves are untouched (Slice A
  lists still show everything — nothing vanishes).

## 5. Viewer/editor — `FloorPlanCanvas` (custom SVG)

**View mode (default, renders whenever the floor has a plan):**
- Plan image (`<image>` with the signed URL) fitted to the pane, pan by dragging, wheel zoom.
- Zoom carries the sites-map lessons from day one: no per-event animation restarts, no
  ceil-floored step amplification, pinch (ctrlKey wheel) tuned separately from scroll.
- Rooms: translucent fill (`fill-blue-500/10`, `stroke-blue-600`), label chip with room code at
  the polygon centroid. Devices: pin glyph + type-code chip (`CAM01`), status-tinted
  (planned grey / installed green — same chips as the lists).

**Edit mode ("Edit layout" toggle):**
- **Place device**: an "unplaced devices" tray lists this floor's devices with null coordinates;
  select one, click the plan to drop it. Placing calls `placeFloorDeviceAction(id, x, y)`.
- **Move device**: drag its pin → same action on release.
- **Un-place device**: select pin, Delete/button → `clearFloorDevicePlacementAction(id)`. The
  device returns to the tray and stays in the Slice A lists — never deleted from here.
- **Draw room**: pick a room without a polygon (tray section "Rooms not outlined"), click to add
  vertices, Enter or double-click closes (min 3 vertices), Esc cancels →
  `setRoomPolygonAction(roomId, polygon)`.
- **Edit room**: select polygon → drag whole shape; drag a vertex handle; click an edge midpoint
  handle to insert a vertex; Delete on a selected vertex removes it (blocked below 3); "Clear
  outline" → `clearRoomPolygonAction(roomId)`.
- Every gesture commits through its own server action returning `{ok, error?}`; errors surface
  inline; success → `router.refresh()`. No autosave loop, no undo stack (out of scope).

**Never-silently-vanish (the standing §2 invariant):** the canvas is a PROJECTION. Everything
placed or not placed remains fully visible and manageable in the Slice A room/device lists below
the canvas. Deleting from the canvas only ever clears a placement.

## 6. Server layer

House pattern throughout: actions return `{ok, error?}`, never throw; repository derives scope
server-side; `revalidatePath("/clients")`.

- Repository (`locations/repository.ts`): `getFloorPlan(db, floorId)`,
  `upsertFloorPlan(db, {floorId, storagePath, widthPx, heightPx, originalFilename, source})`
  (derives site validity from the floor row), `deleteFloorPlan(db, floorId)` (row + placements:
  nulls this floor's device x/y and its rooms' polygons in the same operation),
  `placeFloorDevice(db, id, {x, y})` (rejects out-of-range ⇒ both must be 0..1),
  `clearFloorDevicePlacement(db, id)`, `setRoomPolygon(db, roomId, polygon)` (validates ≥3
  normalized pairs), `clearRoomPolygon(db, roomId)`.
- Storage helper (`src/features/clients/planStorage.ts`, server-only): `uploadPlanObject`,
  `createPlanSignedUrl`, `removePlanObject` — thin wrappers over `db.storage.from("floor-plans")`
  so actions stay testable with a fake.
- Actions (`clients/actions.ts`): `uploadFloorPlanAction(formData)` (floorId + file + client-
  reported dimensions verified server-side), `deleteFloorPlanAction`, and the four placement
  actions above.

## 7. Pure ops — `floorPlanOps.ts` (unit-tested, no DOM, no network)

- `clampNorm(v)` / normalize↔denormalize between screen space and 0..1 plan space given pan/zoom.
- `isValidPolygon(p)`: ≥3 vertices, every pair in 0..1, finite numbers.
- `insertVertexOnEdge(polygon, edgeIndex)`: midpoint insertion.
- `removeVertex(polygon, index)`: refuses below 3.
- `polygonCentroid(p)`: label anchor.
- `partitionPlacement(devices)`: `{placed, unplaced}` — both-non-null rule in ONE place.
- The 0-coordinate lesson stands: `x === 0` is a valid placement (top-left edge); all checks are
  `!= null`, never falsy — and tests pin 0 explicitly.

## 8. Testing

- `floorPlanOps` — full unit coverage including the 0-edge, sub-3-vertex refusal, out-of-range
  rejection.
- Action tests (DB-free, fake db + fake storage helper): upload validates size/type/floor and
  derives scope; delete clears placements in the same flow; placement actions reject out-of-range
  and non-placed edge cases; polygon action rejects 2-vertex payloads.
- Canvas component tests (jsdom): mode toggle, tray contents (placed/unplaced partition), gesture
  handlers calling the right actions with the right ids (multi-device fixtures clicking NON-first
  items — the standing rule), vertex-count guards. SVG geometry/pan-zoom/PDF rendering are
  browser-verified live (jsdom renders neither), same convention as the sites map and rack canvas.
- **NEVER run vitest against a directory or glob** — integration tests wipe the local DB.
  Explicit filenames only.

## 9. Out of scope

Real-world scale / distance measurement (PatchDocs has it; YAGNI until asked); blank-grid
placement without a plan; undo/redo; multiple plans or pages per floor; image rotation/deskew;
AI discovery (Slice C); port-link highlighting on the canvas (Slice D); storing original PDFs.

## 10. Open questions for the builder

None blocking. Two niceties left to the planner: whether the unplaced-devices tray lives left of
the canvas or below it (either; pick what fits the tab pane), and whether polygon drawing shows a
live rubber-band edge to the cursor (nice, cheap, optional).
