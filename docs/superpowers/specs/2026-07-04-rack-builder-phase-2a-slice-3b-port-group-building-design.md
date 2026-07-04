# Phase 2a · Slice 3b — Rack Device Editor: Port-Group Building (Design)

_Date: 2026-07-04_

## Context

Second of three sub-slices of the Rack Device Editor. Slice 3a (PR #3) delivered the editor shell: the modal, header fields, Front/Back + Rack-Mounted toggles, a live **read-only** `Faceplate` preview inside `EditorCanvas` (a `position:relative` overlay origin), draft-in-state editing (`useDeviceDraft`), and atomic Save that round-trips both faces.

3b makes the grid **interactive**: the user builds port groups on the active face. It builds entirely on top of 3a — no persistence changes — and keeps `Faceplate` pure/read-only (reused by the Phase 2b rack view); all interactive controls live in an **overlay** layered over the SVG.

- **3a** (done) — shell + preview + persistence.
- **3b** (this doc) — drag a port type → create a group; drag a group to move it; select; edge chevrons add a column/row; delete; Port Group Settings (ID prefix, counting direction, connector type).
- **3c** — clamped spacing handle + per-port select (name + vertical flip).

Depends on 3a; branch cut from `phase-2a-slice-3a`.

## Goal

Let the user build a face's port groups directly on the live preview: create by dragging a palette port type onto the grid, reposition by dragging a group, grow with edge chevrons, edit via the Port Group Settings panel, and delete. All mutations flow through the existing draft so 3a's Save persists them unchanged.

## Non-goals (deferred)

- Spacing handle (spreading ports apart) and per-port selection / name / vertical flip → **3c**.
- Text/Icon elements and the Tabler icon picker → **Slice 4**.
- Inline field-error messages / removing the 3a hidden-`errors` sink → fold in when convenient (tracked from 3a review).

## Architecture

### The overlay layer

`EditorCanvas` currently renders the pure `Faceplate` SVG inside a `position:relative; display:inline-block` wrapper. 3b adds an **absolutely-positioned overlay** (`position:absolute; inset:0`) the same size as the SVG, holding all interactive controls (drop target, per-group selection boxes, edge chevrons, drag affordances). `Faceplate` itself is **not modified**.

Controls are positioned from the **same geometry** the SVG uses. For each group, `layoutPortGroup(group)` (from `@/domain/faceplate-geometry`) yields `{ x, y, width, height }` in body-local SVG units; the body is translated by `earWidthPx` (from `frameDims`). So a group's selection box in overlay pixels is:

```
left = earWidthPx + group.x
top  = group.y
w    = group.width      // plus a few px padding to wrap the number labels
h    = group.height
```

Because `EditorCanvas` renders the SVG at natural size (1 SVG unit = 1 CSS px), the overlay maps 1:1. The overlay must scroll/size together with the SVG (they share the wrapper). `EditorCanvas` gains props for edit mode: the current `Face`, `frameDims` inputs (widthIn/rackUnits/rackMounted), the `selectedGroupId`, and callbacks (`onCreate`, `onSelect`, `onMove`, `onAddColumn`, `onAddRow`). When no callbacks are passed it renders exactly as in 3a (pure preview), so its 3a tests still hold.

### Pure operations module

All face mutations are **pure functions** in a new `src/features/device-library/editor/portGroupOps.ts`, unit-tested without React:

- `addPortGroup(face: Face, media: Media, pos: { x: number; y: number }, bounds: GridBounds): Face` — appends a new 1-port group at the nearest free, in-bounds position to `pos` (see Placement).
- `movePortGroup(face: Face, id: string, pos: { x: number; y: number }, bounds: GridBounds): Face` — moves the group to the nearest free, in-bounds position to `pos` (excluding itself from overlap checks).
- `addColumn(face: Face, id: string, bounds: GridBounds): Face` / `addRow(face, id, bounds): Face` — `cols+1` / `rows+1`, **no-op** if the growth would exceed the grid or overlap another group.
- `updatePortGroup(face: Face, id: string, patch: Partial<Pick<PortGroup, "idPrefix" | "countingDirection" | "connectorType">>): Face`
- `deletePortGroup(face: Face, id: string): Face`
- Helpers: `groupBounds(group): Rect` (from `layoutPortGroup`), `wouldOverlap(face, candidate, excludeId?): boolean`, `findFreePosition(face, group, desired, bounds, excludeId?): {x,y}`.

`GridBounds` = the body's usable rectangle in body-local units: `{ width: bodyWidthPx, height: heightPx }` derived from `frameDims`. (Ears are excluded — the body is the editable area; a group is clamped so its full bounds fit `[0, width] × [0, height]`.)

The React/DnD layer calls these and stores the result via `useDeviceDraft.setActiveFace(newFace)`. `selectedGroupId` is transient editor state in `RackDeviceEditor` (`useState<string | null>`), not persisted.

### Placement & nudging (overlaps not allowed)

Groups must never overlap on a face. On create and move:

1. Snap `desired` to an **8px grid**; clamp so the group's bounds fit within `GridBounds`.
2. If that position overlaps no other group (excluding self on move) → use it.
3. Otherwise **ring-search** outward on the 8px grid for the nearest free position: for radius `r = 1, 2, 3…` (in snap steps), test candidates on the ring at Chebyshev distance `r`, each clamped into bounds, in a deterministic order (sorted by true Euclidean distance to `desired`, ties broken by `(dy, dx)`); return the first that fits with no overlap. Cap the search at the grid size.
4. If the grid is full (no free spot found): a **create is cancelled** (face unchanged); a **move keeps the group at its original position** (face unchanged).

Chevron **growth** (`addColumn`/`addRow`) never nudges — a growing group is anchored; if growth would exceed the grid or overlap a neighbor it is a **no-op**.

## Interaction model

- **Create:** palette chips are HTML5-draggable (`draggable`, `dragstart` sets the media in `dataTransfer`). The overlay is the drop target (`dragover` preventDefault, `drop` reads the media and the pointer offset within the overlay). Drop → `onCreate(media, {x,y})` → `addPortGroup`. The new group is auto-selected.
- **Move:** pointer-drag (`pointerdown` on a group's selection box body, `pointermove`, `pointerup`) translates a working offset; `pointerup` commits via `onMove(id, {x,y})` → `movePortGroup`. Live visual follows the pointer; a would-overlap position shows a red outline while dragging.
- **Select / deselect:** clicking a group's overlay box selects it (`selectedGroupId`), showing the selection outline + Port Group Settings. Clicking empty overlay space deselects (settings → 3a placeholder). One group selected at a time.
- **Edge chevrons (selected group only):** a `›` circle at the right-mid edge → `onAddColumn(id)`; a `⌄` circle at the bottom-mid edge → `onAddRow(id)`. Rendered in the overlay above the SVG, never clipped.
- **Delete:** "Delete port group" in the settings panel → `deletePortGroup` + deselect.
- **Front/Back:** switching side **deselects** (selection is per-face); the overlay re-renders for the newly active face.

## Port Group Settings panel

Replaces 3a's placeholder area when a group is selected (else the placeholder shows):

- **ID prefix** (text) → `updatePortGroup(id, { idPrefix })`.
- **Counting Direction** (Top-to-bottom `ttb` / Bottom-to-top `btt` / Left-to-right `ltr` / Right-to-left `rtl`) → `{ countingDirection }`. Changing it re-numbers ports live.
- **Connector type** — options = `CONNECTORS[group.media]` → `{ connectorType }`.
- **Delete port group** button.
- Header shows the media name (e.g. "Port Group Settings — Copper").

## New-group defaults

`media` = dragged type; `connectorType = CONNECTORS[media][0]`; `idPrefix = ""`; `countingDirection = "ltr"`; `rows = 1`, `cols = 1`; `colSpacing = 0`, `rowSpacing = 0` (tight; the 3c spacing handle widens); `portOverrides = {}`; `id` = a fresh unique id (`crypto.randomUUID()`).

## Data flow / persistence

No new persistence. Group building mutates the in-memory draft's active face via `setActiveFace`; 3a's atomic Save (`saveNew`/`saveDeviceTemplateAction`) already writes `front_face`/`back_face`, and the jsonb round-trip already carries `portGroups`. Cancel still discards.

## Error handling & edge cases

- Drop/move outside the grid clamps into `GridBounds`; overlaps resolved by nudging (above).
- Chevron growth that would exceed the grid or overlap a neighbor is a no-op.
- Grid full → create cancelled / move reverts (above).
- Switching Front/Back or deleting the selected group clears `selectedGroupId`.
- A drop of an unrecognized `dataTransfer` payload (not one of the 10 media) is ignored.

## Visual style

Matches `editor-window-restored.html`: selection outline `#2d5bff` with a faint blue fill; chevron add-handles are white circles with a blue chevron; drag affordance uses a move cursor; would-overlap feedback is a red outline. Controls sit above the device and are never clipped. Reuses the existing `PortGlyph` set (rendered by `Faceplate`, unchanged).

## Testing (TDD)

**Unit (pure `portGroupOps`):**
- `addPortGroup` appends a 1-port group with the correct connector default at the snapped position; auto-nudges when the target overlaps; cancels when the grid is full.
- `movePortGroup` relocates to the nearest free spot; reverts when full; excludes self from overlap.
- `addColumn`/`addRow` increment cols/rows; no-op when growth exceeds bounds or would overlap.
- `updatePortGroup` patches only the allowed fields; `deletePortGroup` removes by id.
- `wouldOverlap` / `findFreePosition` behave deterministically (given fixtures with known bounds).

**Component (`@testing-library/react`):**
- Dropping a palette type (fire the overlay `drop` with a media payload) creates and selects a group; the preview gains a port cell.
- Clicking a group selects it (selection box present) and shows the settings panel; clicking empty space deselects.
- Chevrons increase cols/rows (preview port-cell count grows); a chevron that would exceed bounds is a no-op.
- Changing Counting Direction re-numbers (assert on rendered numbers); changing Connector type / ID prefix updates the group; Delete removes it.
- Switching Front/Back deselects.

**Browser verification:** full drag-create, drag-move (incl. nudge on overlap), chevron grow, settings edit, delete — against the running app, then Save + reload to confirm groups persist.

## Decomposition note

3b delivers a fully usable single-group-at-a-time builder. 3c layers the spacing handle and per-port editing onto the same selected-group overlay. The `portGroupOps` module and the `EditorCanvas` overlay callbacks are the seams 3c extends.
