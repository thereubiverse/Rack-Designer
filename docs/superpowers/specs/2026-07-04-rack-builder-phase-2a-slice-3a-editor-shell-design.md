# Phase 2a · Slice 3a — Rack Device Editor: Shell, Live Preview & Persistence (Design)

_Date: 2026-07-04_

## Context

Phase 2a builds the Device Library. Slice 1 (merged) delivered the data model and template CRUD list. Slice 2 (PR #2) delivered the reusable, read-only SVG faceplate renderer — `Faceplate` / `renderFace(face, { widthIn, rackUnits, rackMounted })` — plus the pure geometry module and the 10 port-type glyphs.

The **Rack Device Editor** (spec §4 of the Phase 2a device-library design) is large and interactive. It is decomposed into three sub-slices, each its own spec → plan → branch → PR:

- **3a (this doc)** — editor modal shell, header fields, Front/Back + Rack-Mounted toggles, a **live read-only preview** driven by editable state, and atomic **persistence** of both faces. No group-building or interactivity.
- **3b** — port-group building: drag a port type → create a group, selection, edge chevrons add column/row, delete group, and Port Group Settings (ID prefix, counting direction, connector type).
- **3c** — the clamped spacing handle and per-port selection (name + vertical flip).

Text/Icon **elements** remain in Slice 4.

This slice depends on Slice 2 being present (it renders `Faceplate`); the branch is cut from `phase-2a-slice-2` and should be rebased onto `main` once PR #2 merges.

## Goal

Replace Slice 1's placeholder inline `CreateDeviceForm` with the real Rack Device Editor **modal**, opened from the Device Library's **Create** button and from each Rack Devices row's **Edit** action. Provide the editing shell and a live faceplate preview, and persist the whole template — including empty `front_face` / `back_face` — atomically.

## Non-goals (deferred to 3b / 3c / 4)

- Dragging port types onto the grid; creating/selecting/deleting port groups; edge chevrons; Port Group Settings.
- The spacing handle and per-port selection / flip.
- Text/Icon elements and the Tabler icon picker.
- Full typeahead comboboxes (see Header fields below).
- Responsive reflow polish (basic responsiveness only; full reflow can land with 3b).

## Architecture

The editor is a **client-component modal** over the Device Library page. Interactivity added in 3b/3c will be an **overlay** on top of Slice 2's pure `Faceplate` SVG (which stays read-only, as the Phase 2b rack view reuses it unchanged) — never by making `Faceplate` itself interactive. 3a establishes that overlay container (`EditorCanvas`) even though it renders nothing interactive yet.

New feature module: `src/features/device-library/editor/`.

- **`RackDeviceEditor.tsx`** — the modal. Holds draft state (via `useDeviceDraft`), renders:
  - header fields (Name, Brand, Device type, Rack units, Width);
  - a **static** Port Types / Elements palette (chips are shown for visual fidelity but are **not** draggable in 3a);
  - the Front/Back toggle and the Rack Mounted toggle;
  - the `EditorCanvas` live preview;
  - a Port Group Settings **placeholder** panel ("Select a port to edit …");
  - a footer with Cancel and Save (label "Create" for new, "Save" for edit).
- **`EditorCanvas.tsx`** — a positioned container that renders `<Faceplate face={activeFace} widthIn rackUnits rackMounted side={activeSide === "front" ? "FRONT" : "BACK"} />`. Owns the coordinate origin the 3b/3c overlay will use. In 3a it renders only the preview.
- **`useDeviceDraft.ts`** — hook holding the draft and typed update helpers (`setField`, `setActiveSide`, and — for later slices — `setActiveFace`). Also exposes derived validation state.

The existing `CreateDeviceForm.tsx` is **removed**; the Device Library page mounts the editor modal instead.

## Header fields (spec §4.1)

- **Name** * — text, required.
- **Brand** — optional / clearable **select** populated from the org brand list, with an inline **"+ Add brand"** action (create-your-own) that calls the existing `createBrandAction` and selects the new brand. Full typeahead combobox is deferred.
- **Device type** * — required **select** from Device Types (existing list). (Managing the type list stays on the Device Types tab.)
- **Rack units** — select (1 RU, 2 RU, … up to a sensible cap, e.g. 10).
- **Width (in)** — numeric input; the device **body** width in inches, drives the preview grid width.

Rationale for selects over typeahead: keeps 3a focused; the brand/type lists are short for a single org. Typeahead is a later polish if needed.

## State model (draft)

```ts
interface DeviceDraft {
  name: string;
  brandId: string | null;
  deviceTypeId: string | "";
  rackUnits: number;   // >= 1
  widthIn: number;     // > 0
  rackMounted: boolean;
  activeSide: "front" | "back";
  frontFace: Face;     // Slice 2 domain type; emptyFace() for a new device
  backFace: Face;
}
```

- Device-level fields (`widthIn`, `rackUnits`, `rackMounted`) are shared across both faces — they map to single columns on `device_templates`. The Front/Back toggle only switches which face the preview shows/edits.
- New device → `frontFace = backFace = emptyFace()`. Editing → loaded from the row's `front_face` / `back_face` (null coerced to `emptyFace()`).
- The preview renders the face for `activeSide`.

## Data flow / persistence

Extends the Slice 1 repository (`src/features/device-library/repository.ts`); reuses `getDefaultOrganization`, the existing `createBrand` / `listBrands` / `listDeviceTypes`.

- **`getDeviceTemplate(db, id)`** *(new)* — selects the full row including `front_face` / `back_face`; returns them typed as `Face` (null → `emptyFace()` at the call site / mapping).
- **`updateDeviceTemplate(db, id, input)`** *(new)* — writes `name`, `brand_id`, `device_type_id`, `rack_units`, `width_in`, `rack_mounted`, `front_face`, `back_face`, `updated_at = now()`.
- **`createDeviceTemplate`** *(extended)* — accepts optional `frontFace` / `backFace` (default `emptyFace()`); writes them into the insert.
- **Server actions** (`actions.ts`):
  - `saveNewDeviceTemplateAction(input)` — validates, calls `createDeviceTemplate`, returns `{ ok, id?, error? }`.
  - `saveDeviceTemplateAction(id, input)` — validates, calls `updateDeviceTemplate`.
  - Both take a **structured input object** (the draft: fields + `frontFace` / `backFace`), not raw `FormData`, since faces are nested JSON. Validation reuses the existing `isValidWidthIn` / `isValidRackUnits` domain helpers (already used by the Slice 1 action).
  - `createBrandAction(name)` *(new)* — thin server action wrapping the existing `createBrand` repository fn, for the header's "+ Add brand"; returns the new `BrandRow`.
  - The Slice 1 `FormData`-based `createDeviceTemplateAction` is **removed** together with `CreateDeviceForm` (superseded by the structured actions). `deleteDeviceTemplateAction` stays.
- On success the modal closes and calls `router.refresh()` to re-fetch the Rack Devices table.

Faces are stored as `jsonb` exactly matching the Slice 2 `Face` shape (`{ portGroups: [], elements: [] }` for empty). Round-trip must be loss-free.

## Error handling & edge cases (spec §10)

- Validation (client, before Save; Save disabled until valid): Name non-empty; Device type selected; `widthIn > 0`; `rackUnits >= 1` (integer). Invalid fields show inline messages.
- Server errors (e.g., unique-name conflict, RLS) surface as an inline banner in the modal; the modal stays open with the draft intact.
- Cancel discards the draft with no writes. Closing via backdrop/Escape behaves like Cancel.
- A template with empty faces is valid (front-only/back-only or fully-empty devices are allowed).
- Editing a template whose `front_face` / `back_face` is null renders an empty preview without error.

## Visual style (spec §8)

Clean light theme, Inter typeface, blue primary `#2563eb`, black-pill Front/Back toggle, subtle borders and rounded cards — matching `editor-window-restored.html`. The palette chips reuse the Slice 2 `PortGlyph` set for fidelity. Modal is centered over a dimmed backdrop.

## Testing (TDD)

**Component (`@testing-library/react`):**
- Modal renders all header fields and a `Faceplate` preview (`data-testid="faceplate-svg"` present).
- Front/Back toggle swaps the previewed face (e.g. distinct front vs back content renders).
- Changing Width / Rack units / Rack Mounted updates the preview dimensions (assert on the rendered `Faceplate` width/height / screw-hole presence).
- Validation blocks Save when Name empty, no Device type, `widthIn <= 0`, or `rackUnits < 1`; Save enabled when valid.
- Edit mode pre-fills fields and faces from a supplied template.
- "+ Add brand" adds and selects a brand (mock the action).

**Integration (against Supabase, following Slice 1's `repository.integration.test.ts`):**
- `createDeviceTemplate` with non-empty `frontFace` round-trips via `getDeviceTemplate` (faces loss-free).
- `updateDeviceTemplate` persists changed device fields and both faces; re-fetch reflects them.
- Test rows are scoped/cleaned up per the Slice 1 pattern.

## Decomposition note

3a is intentionally the "static shell + data" layer so 3b/3c can focus purely on interaction against a working editor and persistence path. The `EditorCanvas` overlay origin and the `useDeviceDraft` `setActiveFace` helper are the seams 3b/3c build on.
