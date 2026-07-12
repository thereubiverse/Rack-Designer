# Phase 2b: Rack Builder — device placement — design

**Date:** 2026-07-08 · **Status:** approved by Reuben (design conversation) · **Branch:** continues
the `phase-2a-device-types` stack.
**References:** master spec `2026-07-02-rack-builder-design.md` §4 (Device instance model);
`docs/reference/patchdocs-notes.md` → "Observed live in the app" (rack-editor walkthrough).

## 1. Context & scope

Phase 2b turns the Device Library into a working rack builder: racks (Phase 1 data) get a full
**builder page** where device *templates* are placed, moved, and managed — the PatchDocs rack
editor's placement layer, adapted to our light shell.

**In scope**
- Racks section in the light shell: `/racks` list + `/racks/[id]` builder page.
- Promote the light shell app-wide (root layout); retire the dark Phase-1 home page.
- Place templates via drag-a-type or click-a-free-RU → Add-device picker (templates of that type,
  faceplate previews, Standard/Custom badge, Insert).
- Auto-ID from device-type codes (SW01, SW02…), overridable; move between RUs (grip handle);
  delete (confirm); Front/Back face switcher; zoom/fit.
- Device settings sidebar: ID, name, status (planned|installed|verified), inventory fields.
- Rack settings sidebar (nothing selected): code, name, height_u (shrink blocked while devices
  would no longer fit).
- Undo/redo (toolbar + ⌘Z/⇧⌘Z) over placement operations.
- Autosave (debounced per-operation server actions + Saved chip).

**Out of scope (later phases)**
- Connections/patching, port states/colours, VLANs, outbound connections, building connections (2c).
- Rack trays / tray devices; front/back RU sharing (one device per RU span in 2b — see §4).
- Deployed-template edit impact warnings & rebuilds (needed only once connections exist; in 2b
  template edits propagate live to rack renders, documented behavior).
- Rack-level inventory/photos/notes; planned-vs-as-built views (status field stored now, views later);
  Clients/Sites navigation (racks list shows the Phase-1 derived path meanwhile);
  concurrency guards (last-write autosave for now).

## 2. Data model (migration `0004_rack_devices.sql`)

```
rack_devices
  id                 uuid pk
  rack_id            uuid not null references racks(id) on delete cascade
  device_template_id uuid not null references device_templates(id) on delete restrict
  code               text not null            -- SW01… uppercase, no spaces, ≤10 chars
  name               text                     -- optional human label
  start_u            int  not null check (start_u >= 1)
  side               text not null default 'front' check (side in ('front','back'))
                                              -- stored for the future; always 'front' in 2b
  status             text not null default 'installed'
                     check (status in ('planned','installed','verified'))
  manufacturer / model_name / serial_number   text null
  purchase_date / operation_start             date null
  created_at / updated_at                     timestamptz
  unique (rack_id, code)
```

- RU occupancy (`start_u + template.rack_units - 1 <= racks.height_u`, no overlaps) is enforced in
  pure ops client-side AND re-validated inside the server action against fresh DB state — not as a
  DB constraint (spans are template-derived).
- **Template deletion**: the FK `on delete restrict` now blocks deleting a template placed in any
  rack; `deleteDeviceTemplateAction` surfaces "This device is placed in a rack" (friendly-error
  mapping, same pattern as device types).
- **Template edits propagate live** to every placement (render-time lookup). Fine while nothing
  hangs off placements; the PatchDocs impact/rebuild flow arrives with connections (2c).

## 3. Pure core (TDD)

`src/features/racks/rackOps.ts` — placement math, mirrors `portGroupOps` style:
- `spanOf(placement, template)` → `{ top: start_u + ru - 1, bottom: start_u }`
- `canPlace(placements, templatesById, startU, heightU, rackHeight, ignoreId?)` → boolean
  (fits rack, no overlap)
- `findFreeSlot(placements, templatesById, heightU, rackHeight, preferredU?)` → `number | null`
- `nextCode(placements, typeCode)` → first free `SW01`-style code (2-digit, grows to 3 when >99)
- `resolveMove(placements, templatesById, id, targetU, rackHeight)` → clamped/blocked target
- `validateDeviceCode(code)` → uppercase, no spaces, 1–10 chars, per the naming scheme
- `minRackHeight(placements, templatesById)` → highest occupied U (blocks invalid shrink)

`src/features/racks/history.ts` — tiny generic undo stack:
`createHistory<T>(present)` + `push/undo/redo/canUndo/canRedo`. Applies to the placements array;
each undo/redo re-syncs to the server like any other edit.

## 4. Rendering

- `src/features/racks/RackFrame.tsx` — **pure** SVG rack: rails with RU numbering, mounting holes,
  ears, open slots, sized from `height_u`. Composes the existing pure `Faceplate` (per placement,
  at its RU, showing the front or back face per the switcher). Server-renderable like `Faceplate`.
- `src/features/racks/RackCanvas.tsx` — interactive overlay (EditorCanvas pattern): fit-to-window
  scaling, click-empty-RU detection, device selection (blue frame + right-edge grip handle),
  grip-drag between RUs with live collision feedback, Delete/Backspace, zoom in/out/fit toolbar,
  undo/redo buttons.
- One device per RU span: the Front/Back switcher flips which face every placement renders;
  it does not create separate mounting sides in 2b.

## 5. Pages & flows

- **Shell**: `DeviceLibraryShell` generalizes to `AppShell` (title prop) in the root layout; the
  sidebar gains a **Racks** item (Tabler `server-2` icon, placed above Device Library — a temporary
  top-level home until the Clients/Sites hierarchy exists); `/` redirects to `/racks`; the dark
  Phase-1 home page is removed.
- **`/racks`**: card table (same language as RackDeviceTable): code, name, derived path
  (`listRacksWithPath`), height, device count; search/sort/pagination; Create (existing create
  flow restyled into a modal); row click → builder.
- **`/racks/[id]`** (builder):
  - Left palette: rack device **types** (from `device_types` category='rack', standard + custom).
  - Drag a type onto the rack or click a free RU → **Add device picker** modal: templates of that
    type (name, brand, RU, front/back previews via pure renderers; the Standard/Custom badge is
    deferred until seeded standard templates exist — today every template is custom), Insert places
    at the drop RU (or `findFreeSlot`), `+ Create Custom Device` deep-links to the Device Library.
  - Insert assigns `code = nextCode(...)`; sidebar shows the placement's settings for rename
    (validated), status, inventory.
  - Right sidebar: rack settings when nothing selected; device settings when selected.
  - Autosave: every committed op (insert/move/delete/field edit) fires its debounced server action;
    chip shows "Saving…/Saved". Undo/redo replays ops and re-syncs the same way.

Server layer follows the existing pattern: `src/features/racks/repository.ts` (thin Supabase
wrappers: list/insert/update/delete rack_devices + rack field updates) and `actions.ts`
(occupancy re-validation, friendly errors, revalidatePath).

## 6. Error handling

- Overlap/out-of-bounds placements blocked in the UI (no drop indicator on occupied slots) and
  rejected server-side with "Those rack units are already occupied" if a race slips through.
- Duplicate code on rename → "That ID is already used in this rack" (unique constraint mapping).
- Rack shrink below `minRackHeight` → blocked with an inline message.
- Template deleted elsewhere while picker open → insert action surfaces the FK/not-found error.

## 7. Testing

- TDD: `rackOps` (occupancy, spans, nextCode incl. gap reuse SW01/SW03→SW02, code validation,
  move clamping, min height) and `history` (push/undo/redo/branch truncation).
- Component: picker (lists templates of the type, insert callback), RackCanvas (select, grip-move
  callback, click-empty-RU callback, delete confirm), sidebar (field edits fire actions), racks
  list page table.
- Browser walkthrough: create rack → place standard + custom templates → move/rename/undo/redo →
  autosave persistence across reload → shrink-block → template delete blocked when placed.
