# Phase 2a · Slice 3c — Rack Device Editor: Spacing Handle & Per-Port Editing (Design)

_Date: 2026-07-04_

## Context

Final sub-slice of the Rack Device Editor. Slice 3a (PR #3) delivered the shell + live preview + persistence; Slice 3b (PR #4) delivered port-group building (drag-create, select, edge chevrons, drag-to-move, delete, Port Group Settings) via a pure `portGroupOps.ts` and an interactive **overlay** on the pure, read-only `Faceplate` inside `EditorCanvas`.

3c completes the editor: the **spacing handle** (spread a group's ports apart) and **per-port editing** (select a port, name it, flip it). It also folds in the one item deferred from the 3b review: the **live drag-follow visual + red would-overlap outline** for group moves.

Depends on 3b; branch cut from `phase-2a-slice-3b`. After 3c, Phase 2a's remaining work is Slice 4 (Text/Icon elements).

## Goal

Let the user fine-tune a group's layout and label its ports directly on the live preview: drag a bottom-right handle to spread the ports/labels apart (clamped), click an individual port to select it (its label+icon turn blue), and edit that port's name and vertical flip. Group moves gain live visual feedback. All mutations flow through the 3a draft so Save persists them; `Faceplate` stays pure/read-only.

## Non-goals (deferred)

- Text/Icon elements and the Tabler icon picker → **Slice 4**.
- Per-group flip (flipping is per-port only, per spec §4.5).
- Multi-port selection / marquee (one port at a time).

## Architecture

Everything builds on the existing seams: pure transforms in `portGroupOps.ts`, interactive controls in the `EditorCanvas` overlay, state in `RackDeviceEditor` via `useDeviceDraft.setActiveFace`. `Faceplate` is **not** modified.

**Key leverage — name & flip already round-trip through `Faceplate`.** Slice 2's `layoutPortGroup` already sets each cell's `label = portOverrides[index].name ?? idPrefix+number` and `flipped = portOverrides[index].flipped ?? false`, and `Faceplate`'s `PortCell` already renders the label and mirrors the glyph when `flipped`. So editing a port's name or flip is purely a `portOverrides` mutation — the SVG re-renders itself with no `Faceplate` change. The flip mirrors only the glyph; the number/label stays upright (already how `PortCell` renders it).

### Selection model

Extend 3b's `selectedGroupId: string | null` with `selectedPortIndex: number | null` (a port **within** the selected group; null = the group itself is selected, no specific port).

- Clicking a port cell → `selectedPortIndex = index` (group stays selected).
- Clicking the group box background (not a port cell) → `selectedPortIndex = null` (group stays selected).
- Selecting a different group, deleting the group, or switching Front/Back → clears both as appropriate (`selectedPortIndex = null`).

### The blue port highlight (overlay, Faceplate stays pure)

For the selected group, the overlay renders a transparent **click target** over each port cell (positioned from `layoutPortGroup`'s `cells[i].x/y` plus the `earWidthPx` body offset) → `onSelectPort(index)`. For the **selected** port, the overlay draws a **blue copy** on top of the SVG: a blue `PortGlyph` (mirrored if the port is flipped) at the cell's glyph position and the cell's blue number/label above it — visually turning "label and icon" blue without touching the black SVG beneath. The blue copy is derived from the same laid-out cell (`media`, `flipped`, `label`), so it always matches what `Faceplate` drew.

### The spacing handle

A solid-blue circle at the **bottom-right corner** of the selected group's box (rendered whenever a group is selected — the group-level controls, chevrons + handle, stay visible even while a port within it is selected). Pointer-drag spreads the ports:

- **On grab (pointerdown):** compute the clamp limits **once** — `maxSpacing(face, group, bounds)` → `{ maxCol, maxRow }` — the largest `colSpacing`/`rowSpacing` keeping the group's grown bounds within `GridBounds` **and** clear of every other group on the face (grid edge **and** neighbours; whichever is nearer). Record the grab-time `colSpacing`/`rowSpacing` and pointer origin.
- **On drag (pointermove):** `colSpacing = clamp(0, maxCol, grabCol + (clientX - startX))`, `rowSpacing = clamp(0, maxRow, grabRow + (clientY - startY))`; commit **live** via `setSpacing` + `setActiveFace` so the ports visibly spread. Hard static stop at the clamp (never past, never below 0).
- **On release (pointerup):** end the drag (state already reflects the final spacing).
- A single-column group has `maxCol = 0` (nothing to spread horizontally); a single-row group has `maxRow = 0`.

### Per-port panel

When a port is selected, a **port panel** shows (alongside the 3b Port Group Settings): the header "Port <label>", a **name** input (`portOverrides[index].name`, empty falls back to the derived label), and a **vertical Flip** toggle (`portOverrides[index].flipped`). Editing either calls `setPortOverride` → `setActiveFace`; the preview updates. When no port is selected, the panel shows the 3b placeholder text.

### Live group-move follow (deferred 3b item)

During a group drag-move (3b's pointer-drag on the group box), the box now follows the pointer **live** via a transient offset, and shows a **red outline** whenever the current pointer position would overlap a neighbour or leave the grid (`wouldOverlapAt`). On release it still commits through `movePortGroup` (which nudges to the nearest free spot). This is visual-only during the drag; the committed result is unchanged from 3b.

## Pure operations (extend `portGroupOps.ts`)

- `setPortOverride(face, groupId, index, patch: { name?: string; flipped?: boolean }): Face` — merges `patch` into `portOverrides[index]` (creating it if absent); returns a new Face. **Name-clearing:** the port panel passes `name: value || undefined` so an empty input stores `name: undefined`. Because `layoutPortGroup` resolves the label with `override?.name ?? idPrefix+number` (nullish coalescing), `undefined` correctly falls back to the derived label, whereas an empty string would render a blank label — so the panel must convert `""` → `undefined`.
- `setSpacing(face, groupId, spacing: { colSpacing?: number; rowSpacing?: number }): Face` — sets the group's spacing (already clamped by the caller).
- `maxSpacing(face, group, bounds: GridBounds): { maxCol: number; maxRow: number }` — grab-time clamp limits. For `cols > 1`: `maxCol = min` over (grid: `(bounds.width - gridX - cols*CELL_W)/(cols-1)`) and (each other group whose current vertical span overlaps this group's and sits to its right: `(neighbor.gridX - gridX - cols*CELL_W)/(cols-1)`), floored at 0; `cols <= 1 → maxCol = 0`. Symmetric for `maxRow` using rows/ROW_H/gridY and neighbours below. Uses the group's grab-time bounds for the "overlapping span" test.
- `wouldOverlapAt(face, group, pos: Pos, bounds: GridBounds): boolean` — true if placing `group` at `pos` (its current size) overlaps any other group or exceeds `bounds`. Reuses `wouldOverlap` (excluding self) + a bounds check.

`updatePortGroup` (3b) is unchanged (still only idPrefix/countingDirection/connectorType); spacing has its own setter because its patch shape and clamping differ.

## Data flow / persistence

No new persistence. `colSpacing`/`rowSpacing` and `portOverrides` are already part of the `PortGroup` jsonb that 3a's Save round-trips. Cancel still discards.

## Error handling & edge cases

- Spacing clamps hard at `maxCol`/`maxRow` (computed once on grab) and at 0; single row/col → that axis maxes at 0.
- If a neighbour or the grid leaves no room, `maxCol`/`maxRow` floor at 0 (the handle is inert on that axis).
- Selecting a port then deleting the group / switching side clears `selectedPortIndex`.
- Clearing a port's name (empty input) stores `name: undefined`, so `Faceplate` falls back to the derived `idPrefix+number` label (see setPortOverride's name-clearing note; `layoutPortGroup` uses `??`, so `undefined` falls back but `""` would render blank).
- The blue highlight copy tracks the port's current flip/name, so it never diverges from the SVG.

## Visual style

Matches `editor-window-restored.html`: selected port label+icon in `#2d5bff`; the spacing handle is a solid `#2d5bff` circle with a white resize glyph at the box's bottom-right; the live-move red outline is a red (`#dc2626`) box border. Controls render above the device and are never clipped. Reuses `PortGlyph` for the blue copy.

## Testing (TDD)

**Unit (`portGroupOps`):**
- `maxSpacing` clamps to the grid edge; clamps tighter to a neighbour to the right/below; single-col → `maxCol = 0`, single-row → `maxRow = 0`; floors at 0 when no room.
- `setSpacing` sets col/row spacing; `setPortOverride` merges name/flip into `portOverrides[index]` (new + existing index) immutably.
- `wouldOverlapAt` true on overlap / out-of-bounds, false on a free in-bounds spot.

**Component (`@testing-library/react`):**
- Clicking a port cell selects it: the port panel appears and a blue-highlight marker (`data-testid="port-highlight"`) is rendered; clicking the group background clears the port selection.
- Typing a port name updates the rendered label in the preview; toggling Flip mirrors that port's glyph (assert the flipped transform / a `flipped` marker) while the number label is unchanged.
- Dragging the spacing handle increases `colSpacing`/`rowSpacing` and stops at the clamp (a further drag past the max does not increase it).
- Selecting another group or switching Front/Back clears `selectedPortIndex`.
- A group-move drag renders the live box + a red-outline marker (`data-testid="move-invalid"`) when the current position would overlap.

**Browser verification:** spread a group with the handle (hard-stop at grid + neighbour), select a port → blue label+icon, rename it (preview label changes), flip it (glyph mirrors, number stays), drag a group with live follow + red outline on overlap; then Save + reopen via Edit to confirm spacing + overrides persist.

## Decomposition note

3c is the last editor slice; it reuses the `EditorCanvas` overlay and `portGroupOps` seams established by 3b. After it, the editor supports the full port-group authoring flow from the Phase 2a spec §4; Slice 4 adds Text/Icon elements on the same overlay.
