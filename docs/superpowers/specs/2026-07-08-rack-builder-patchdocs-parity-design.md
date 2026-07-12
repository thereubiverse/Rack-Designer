# Rack builder: PatchDocs UI/UX parity pass — design

**Date:** 2026-07-08 · **Status:** approved (design conversation) · **Branch:** continues
`phase-2b-rack-placement`.
**References:** live-app observations in `docs/reference/patchdocs-notes.md` ("Observed live in the
app"); 2b spec `2026-07-08-rack-builder-phase-2b-placement-design.md`.

## 1. Goal & scope

Bring `/racks/[id]` visually and interactively in line with PatchDocs' rack editor. Behavior built
in 2b (placement, auto-IDs, undo/redo, autosave, occupancy) is unchanged — this pass re-skins the
chrome, upgrades the rack rendering, adds their insertion affordances, the bottom Devices panel,
and rack-level inventory/photos/notes.

**In scope**
1. Three-panel chrome: framed left DEVICES panel (vertical edge tab, search, drag hint), framed
   right RACK SETTINGS / DEVICE SETTINGS panel (vertical edge tab, resource-path title,
   collapsible Settings / Photos / Notes sections), breadcrumb bar (`Racks › HQ/28/SL/RK001`).
2. Floating canvas controls: Front/Back pill top-left (dark active), stacked left column
   (zoom in / zoom out / fit, undo, redo), Saving…/✓ Saved chip top-right of the canvas.
   The 2b toolbar row is removed.
3. Rack rendering v2 (pure `RackFrame`) — matched to zoomed reference captures (2026-07-08):
   square-cornered thin-stroke enclosure with a top cap bar, base pedestal with cable-brush and
   feet, an external left RU ruler (ticks at boundaries, numerals at RU centers), inset rails
   with ~3 square holes per RU, dashed RU boundary lines, the blue ⊕ free-slot marker kept
   (theirs is always visible), and a vertical code tag on each placed device. Full detail in §4a.
4. Insertion UX: palette type cards become draggable onto a specific RU; the Add-device picker
   gains two-level navigation (type list → templates with a `← <type>` back arrow). Free-RU
   click opens the picker at the type list; palette click/drag opens it scoped to that type.
5. Bottom DEVICES panel: collapsible bar under the canvas — table ID / Name / Unit / Type /
   Created, sortable, row click selects the device (sidebar + canvas highlight). Tabs UI is
   built so CONNECTIONS/VLANS can slot in during 2c, but only DEVICES exists now.
6. Rack-level fields: inventory (manufacturer, model name, serial number, purchase date,
   operation start), a Notes text block, and Photos (upload/list/delete via Supabase Storage).

**Out of scope:** device-level photos/notes; connections/VLANs; panel resize; drag-to-reorder in
the bottom panel; photo lightbox/captions; concurrency guards (still last-write autosave).

## 2. Data (migration `0005_rack_details.sql`)

```sql
alter table racks
  add column manufacturer text,
  add column model_name text,
  add column serial_number text,
  add column purchase_date date,
  add column operation_start date,
  add column notes text;

create table rack_photos (
  id uuid primary key default gen_random_uuid(),
  rack_id uuid not null references racks(id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);
-- RLS single-org placeholder policy + grants, same pattern as 0004.

-- Public bucket for rack photos (dev-permissive policies, same placeholder posture as tables).
insert into storage.buckets (id, name, public) values ('rack-photos', 'rack-photos', true)
  on conflict (id) do nothing;
create policy "rack_photos_all" on storage.objects for all
  using (bucket_id = 'rack-photos') with check (bucket_id = 'rack-photos');
```

Storage path convention: `{rackId}/{uuid}.{ext}`; public URL rendered via
`${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/rack-photos/{storage_path}`.

## 3. Server layer

- `racks/repository.ts`: `RackRow` gains the six new columns; `updateRack` patch extends to
  `{ name?, heightU?, manufacturer?, modelName?, serialNumber?, purchaseDate?, operationStart?, notes? }`;
  new `listRackPhotos(db, rackId)`, `insertRackPhoto(db, rackId, storagePath)`,
  `deleteRackPhoto(db, id)` (returns the row so the action can remove the storage object),
  and `getRackPath(db, rackId)` → the `HQ/28/SL/RK001` label (join rooms→floors→sites, reuse
  the existing `buildLabel` from `@/domain/hierarchy` used by `listRacksWithPath`).
- `racks/actions.ts`: `updateRackAction` passes the new fields through (height guard unchanged);
  new `uploadRackPhotoAction(rackId, formData)` (validates content-type `image/*` and size
  ≤ 10 MB, uploads via the service client, inserts the row, revalidates) and
  `deleteRackPhotoAction(photoId)` (removes storage object + row). Both return `{ ok, error? }`.

## 4. Components

New/changed under `src/features/racks/` (pure/interactive split preserved):

- `PanelFrame.tsx` (new, reusable): white rounded panel with a **vertical edge tab label**
  (left- or right-edge, uppercase, 10px letter-spaced — like DEVICES / RACK SETTINGS) and a
  scrollable body. Props: `{ label, side: "left" | "right", children }`.
- `RackFrame.tsx` (v2, still pure) — **§4a: exact rendering spec, matched to Reuben's hi-res
  reference photos (2026-07-08; authoritative over my earlier low-res zooms):**
  - **Top cap**: a PROMINENT bar (~24px tall at our scale) slightly WIDER than the enclosure,
    square corners, thin `#b9bcc2` stroke, `#f7f7f8` fill, sitting above the enclosure with a
    thin **lip line** (a 4px full-width bar) between cap and enclosure.
  - **Enclosure (double wall)**: outer rect with thin `#b9bcc2` stroke, square corners; inside
    it, after a visible `#fafafa` margin (~12px), an **inner frame** rect (thin `#d4d7dc` stroke)
    that bounds the rails + interior. The double-line wall look is signature — keep both.
  - **Base**: below the enclosure a **pedestal bar** slightly wider than the enclosure (~30px
    tall) with the **cable brush** inset: a light tray containing dense dark teeth (3px `#2a2a2a`
    bars, 3px gaps, ~70% of pedestal width, centered); beneath the pedestal two **feet**
    (~40px × 8px `#eceef0` rects with thin stroke, near each end).
  - **RU ruler (labeling)**: OUTSIDE, left of the enclosure with a clear gap (~14px) — a thin
    `#c4c7cc` vertical line spanning the interior height, a short leftward **tick at every RU
    boundary**, and a **dark-grey `#4b5563` ~11px numeral centered on each RU** (bottom-up: 1 at
    the bottom). No numerals or ticks inside the frame.
  - **Rails**: two vertical strips flush inside the inner frame, ~26px wide, FILLED light
    grey-lavender `#e9eaef` (no outline), punched with **white square holes (~6px) positioned to
    align with the faceplates' screw holes**: hole centres `SCREW_EDGE_INSET_PX` (18px) in from
    each interior edge, **two per RU** at `RU_PX × 0.16` from each RU edge (the same corner-inset
    formula `screwHoles()` uses) — so every placed device's ear screws land exactly on rail holes.
    (Deliberate deviation from PatchDocs' 3-per-RU look: our faceplates mount with 2 corner screws
    per ear, and alignment beats hole-count parity — Reuben's call, 2026-07-08.)
  - **Interior**: white; a **dashed** `#e5e6ea` horizontal line at every RU boundary spanning
    rail inner edge to rail inner edge.
  - **Free-slot marker**: centered **⊕ ~24px diameter** — periwinkle blue `#7c8ce8`-ish
    (Tailwind `indigo-400` is close), ~2px circle stroke + plus, always visible on every free
    RU. The overlay strip additionally tints on hover.
  - **Placed devices**: faceplate spans the rails as today, PLUS a small **vertical code tag** at
    the device's left edge (rotated 90°, ~7px, grey — e.g. SW01), like their SW01/PP01 tags.
  - Geometry: new exported constants `CAP_H = 24`, `LIP_H = 4`, `PEDESTAL_H = 30`, `FEET_H = 8`,
    `RULER_W` (gutter incl. gap); `rackSvgSize` accounts for all of them; `ruTopY` keeps its
    contract with the interior origin shifted by `CAP_H + LIP_H` + inner-frame margin.
- `RackCanvas.tsx`: floating controls rendered inside the canvas host (Front/Back pill absolute
  top-left; zoom/fit/undo/redo stacked column absolute left; chip absolute top-right) — moved in
  from RackBuilder via new props `{ side, onSide, zoom controls..., undo/redo state+handlers,
  saveChip }`; free-RU strips get `hover` ⊕ affordance (visible only on hover); strips become
  HTML5 **drop targets**: `onDragOver` preventDefault + `onDrop` reads
  `e.dataTransfer.getData("application/x-device-type")` → `onDropType(typeId, u)`.
- `DevicesPalette.tsx` (new): search input (filters type list), hint text
  "Drag device to a rack unit to add it.", type cards `draggable` (set
  `application/x-device-type` = type id, `effectAllowed = "move"`; canvas drop uses
  `dropEffect = "move"` — matching, per the icon-chip lesson), click still opens the picker.
- `AddDevicePicker.tsx`: two-level — props become `{ types, templatesByType, initialTypeId?,
  onInsert(template), onClose }`. No `initialTypeId` → type-list view; selecting a type slides to
  the template list with a `← {typeName}` back button (returns to type list). Insert behavior
  unchanged.
- `RackBottomPanel.tsx` (new): collapsible bottom bar (header "DEVICES & CONNECTIONS", tab
  strip with DEVICES active — CONNECTIONS/VLANS placeholders disabled), table ID / Name / Unit /
  Type / Created with sort toggles, `onRowClick(id)` selects; selected row highlighted.
- `RackSettingsPanel.tsx` (new, extracted from RackBuilder's inline RackSettings): collapsible
  sections — **Settings** (ID read-only, name, height, inventory fields), **Photos** (thumb grid,
  dashed upload target wired to `uploadRackPhotoAction`, per-thumb delete), **Notes**
  (PatchDocs-style tinted block; textarea revealed by Edit, debounced save). Section headers
  toggle with chevrons.
- `RackDeviceSettings.tsx`: unchanged content, now rendered inside the right `PanelFrame` with a
  DEVICE SETTINGS edge tab and the device's full path (`{rackPath}/{code}`) as title.
- `RackBuilder.tsx`: recomposed to the new chrome — breadcrumb bar (`Racks` link › rack path),
  `PanelFrame`d palette + settings, canvas with floating controls, bottom panel. All existing
  state/handlers (history, autosave, picker insert, move/delete) unchanged; picker call sites
  updated for two-level props; `onDropType(typeId, u)` opens the picker scoped to that type at
  that RU.
- `racks/[id]/page.tsx`: also loads `getRackPath` + `listRackPhotos` and passes them down.

## 5. Interactions summary (target behavior)

- Drag a palette card → free RU strips highlight while dragging; drop on one → picker opens for
  that type, Insert lands at that RU.
- Click a free RU → picker opens at the type list → pick type → pick template → Insert at that RU.
- Click a bottom-panel row → device selected (canvas outline + DEVICE SETTINGS panel).
- Hover a free RU → strip tint + centered ⊕.
- Photos: upload via the dashed target (multiple allowed sequentially), thumbs render from the
  public URL, ✕ on hover deletes (confirmless — photo delete is cheap and re-uploadable).
- Notes: click Edit → textarea; blur/1s debounce saves; empty notes show "Add your first note…".

## 6. Error handling

- Photo upload: non-image or > 10 MB rejected with inline error in the Photos section; storage
  failures surface the action error there too.
- Photo delete: row+object removed; if the object is already gone, the row still deletes.
- All existing 2b guards (occupancy, codes, shrink) untouched.

## 7. Testing

- Component: PanelFrame renders edge tab text; DevicesPalette filters by search + sets drag data;
  AddDevicePicker two-level nav (type list → back arrow → templates → Insert fires);
  RackBottomPanel sorts + row-click fires selection; RackFrame v2 (cap/pedestal/brush/feet
  present, external ruler tick per boundary + numeral per RU, 3 rail holes per RU per rail,
  ⊕ marker on free RUs only, vertical code tag on placed devices); RackSettingsPanel sections
  toggle, notes edit fires save, upload target posts FormData (action mocked).
- Update existing RackCanvas/RackBuilder tests for moved toolbar + strip drop targets.
- Browser walkthrough: full chrome screenshot vs PatchDocs reference, drag-type-to-RU insert,
  type-list picker path, bottom panel select, photo upload/delete round-trip, notes persistence.
