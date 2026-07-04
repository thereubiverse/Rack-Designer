# Phase 2a · Slice 3d — Rack Device Editor Refinements (Design)

_Date: 2026-07-04_

## Context

After building the editor across Slices 3a–3c (PRs #3/#4/#5), live use surfaced refinements to the layout model and interactions. This slice reworks the **vertical layout** to auto-center (no free vertical positioning), treats each port's glyph+label as a **tile**, replaces the overlay blue-copy highlight with an **in-place recolor**, adds a **per-port label top/bottom** toggle, makes the **chevrons click-or-drag**, and makes **group moves horizontal-only**.

Delivered as one stacked slice on `phase-2a-slice-3c`. `Faceplate` is intentionally modified here (a pure rendering change), reversing the earlier "never touch Faceplate" stance — but it stays a **pure function of its inputs** (data-bound highlight/label hints, no interactivity), so the Phase 2b rack view still reuses it unchanged (passing no highlight).

## Goal

Make the editor's layout predictable and the selection legible: rows auto-center vertically (1U → a single row dead-center, two rows top-half/bottom-half), the selected port recolors blue in place, labels can sit above or below each port, chevrons add rows/columns by click or drag, and horizontal is the only free-dragged / fine-tuned axis (vertical is derived; only row spacing fine-tunes it).

## The five changes

### 1. Tile + derived vertical centering

- A **tile** = one port's glyph + its number label, laid out and recolored as a unit.
- **Vertical position is derived, not stored or dragged.** `layoutPortGroup` becomes device-height-aware and **auto-centers the row-stack** in the full device height: the group's total stack height `Hc` is centered so `top = (heightPx − Hc) / 2`; rows are placed top-to-bottom from there, separated by `rowSpacing`. A single-row group's row lands dead-center; a two-row group's rows sit symmetric about center (top-half / bottom-half). This generalizes to any rack-unit height (center in the full height).
- `gridX` remains free (horizontal position). `gridY` is **no longer written by moves and is ignored by vertical layout** (kept on the `PortGroup` type for jsonb compatibility; existing saved data simply re-centers — no migration).
- The only vertical fine-tune is `rowSpacing` (spreads the rows symmetrically about center, via the spacing handle).

### 2. Collision simplifies to horizontal

Because every group auto-centers vertically, every group's vertical band straddles the device center, so any two groups always overlap vertically. Therefore **overlap reduces to horizontal x-range overlap**. `wouldOverlap` / placement / nudge / `wouldOverlapAt` compare only `[gridX, gridX + width]` (width = `cols*CELL_W + (cols−1)*colSpacing`); no device height needed for collision. (Groups can't share an x-range even if their rows would visually interleave — bounding-box horizontal collision, chosen for predictability.)

### 3. In-place blue highlight (replaces the overlay copy)

- `Faceplate` gains an optional, pure `highlight?: { groupId: string; portIndex: number } | null`. It renders that port's tile (glyph + label) in blue `#2d5bff` instead of the default black. No callbacks — a data-bound rendering hint; a pure function of inputs. Phase 2b passes nothing.
- The Slice 3c `EditorCanvas` overlay blue-copy (`port-highlight`) is **removed**. The editor passes the selected group+port to `Faceplate` as `highlight`.
- Per-port click targets in the overlay stay (they drive selection); only the blue-copy visual is removed.

### 4. Per-port label position (top / bottom)

- `portOverrides[index].labelPos?: "top" | "bottom"`. **Default** (no override): the bottom row of a multi-row group → `"bottom"`; every other row (and any single-row group) → `"top"`. `layoutPortGroup` resolves each tile's `labelPos`; `Faceplate` draws the number above (`top`) or below (`bottom`) the glyph within the tile.
- A **Label position** toggle in the per-port `PortSettings` panel sets `labelPos`.

### 5. Chevron click-or-drag

- Clicking the › (right) / ⌄ (down) chevron still adds one column / row (unchanged).
- **Dragging** the chevron adds columns/rows incrementally: as the pointer crosses each `CELL_W` (right) / `ROW_H` (down) of drag distance, one column / row is added, the group staying anchored (gridX/derived-center unchanged), each addition clamped to the grid + neighbours (a blocked addition is a no-op, same as a click at the limit).

### 6. Horizontal-only move

- A group-move drag changes `gridX` only; vertical stays derived-centered. The live-follow box + red would-overlap outline remain but track horizontal movement only (vertical offset ignored). `movePortGroup` sets `gridX` (keeps the existing `gridY` field untouched/unused).

## Architecture & affected units

- **`src/domain/faceplate-geometry.ts`** — `layoutPortGroup(group, heightPx)` gains the device height and computes centered `y` per tile + each tile's `labelPos`; `LaidOutPort` gains `labelPos: "top" | "bottom"`. Tile vertical metrics (glyph box + label strip) defined here.
- **`src/features/device-library/faceplate/Faceplate.tsx`** — `PortCell` renders the label above/below per `labelPos`, colours the tile blue when it is the `highlight` target; `Faceplate`/`renderFace` accept `highlight` and pass the device height into `layoutPortGroup`. Still pure.
- **`src/features/device-library/editor/portGroupOps.ts`** — collision helpers become horizontal-only (x-range); `maxSpacing`'s `maxRow` clamps to the device height (centered stack must fit) — `maxCol` unchanged (horizontal neighbours); `movePortGroup` horizontal-only; `setPortOverride` already carries arbitrary `{name?, flipped?, labelPos?}` (extend its patch type). Add `addColumns`/`addRows` (add N, clamped) for chevron-drag, or keep single `addColumn`/`addRow` called N times by the drag handler.
- **`src/features/device-library/editor/EditorCanvas.tsx`** — remove the blue-copy; add `highlight` passthrough to `Faceplate`; chevron pointers gain drag-to-add; move drag horizontal-only; overlay group/port boxes positioned from the new centered `y`.
- **`src/features/device-library/editor/PortSettings.tsx`** — add the Label position (top/bottom) toggle.
- **`src/features/device-library/editor/RackDeviceEditor.tsx`** — pass `highlight={{ groupId: selectedGroupId, portIndex: selectedPortIndex }}` to the canvas/faceplate; wire the label toggle via `setPortOverride`.

## Data model

- `PortOverride` (the `portOverrides[index]` entry) gains `labelPos?: "top" | "bottom"`. `name?`/`flipped?` unchanged.
- `PortGroup.gridY` retained (jsonb compat) but unused for vertical layout. No migration; old rows re-center.

## Error handling & edge cases

- A single-row group centers dead-center; `rowSpacing` has no effect (maxRow = 0).
- Chevron-drag additions clamp to grid + neighbours; when blocked, further drag adds nothing.
- Clearing a port name still stores `undefined` (3c behaviour) and falls back to the derived label; the label's top/bottom position is independent of its text.
- Deleting / switching side clears the selection, so `highlight` becomes null and no port is blued.
- The centered stack must fit the device height; `maxRow` (spacing clamp) floors at 0 when there is no room.

## Visual style

Selected tile (glyph + number) recolours to `#2d5bff` in place. Labels are tabular-figure numbers sitting immediately above or below the glyph within the tile. Chevrons and the spacing handle keep their 3b/3c styling. `Faceplate` remains the single exportable SVG.

## Testing (TDD)

**Unit (`faceplate-geometry`):**
- `layoutPortGroup(group, heightPx)` centers a single row dead-center; a 2-row group symmetric about center; rows spread by `rowSpacing`; each tile's `labelPos` resolves (default bottom-row→bottom else top; override wins).
- `LaidOutPort.labelPos` present and correct.

**Unit (`portGroupOps`):**
- Horizontal-only overlap (x-range) for `wouldOverlap`/`wouldOverlapAt`; `maxSpacing.maxRow` clamps to device height (centered stack fit), single-row → 0; `movePortGroup` changes only `gridX`; `setPortOverride` merges `labelPos`.

**Component (`Faceplate`):**
- A single-row group renders vertically centered (assert the cell/tile `y` near mid-height); label renders above vs below per `labelPos`; the `highlight` target port renders blue (assert the blue colour on that tile's glyph/label) and no other port does.

**Component (editor):**
- Selecting a port blues that tile in the preview (via `highlight`), and no overlay blue-copy exists.
- The Label-position toggle flips a port's label side (assert the label moves above/below).
- Click a chevron → +1 column/row; drag a chevron down/right → multiple rows/cols added (fire pointerdown + moves + up), clamped at the limit; the group stays anchored.
- A group-move drag changes horizontal position only (assert `gridX` changed, vertical still centered).

**Browser verification:** place a group, add a 2nd row (top/bottom-half centering), select a port (blue in place), toggle its label top/bottom, drag a chevron to add several columns, drag a group horizontally (vertical stays centered), spread with the handle; Save + reopen to confirm `labelPos`/spacing/positions persist.

## Decomposition note

One slice, but the plan should sequence it so the geometry change (device-height-aware `layoutPortGroup` + `labelPos`) lands first with its Faceplate rendering, then the ops simplification, then the editor wiring (highlight passthrough, label toggle, chevron-drag, horizontal-only move), each independently testable.
