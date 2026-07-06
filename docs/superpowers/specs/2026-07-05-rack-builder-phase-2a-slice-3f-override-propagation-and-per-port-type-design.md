# Phase 2a — Slice 3f — Override Propagation + Per-Port Type Replace — Design Spec

**Date:** 2026-07-05
**Status:** Approved (design; brainstorm settled in RESUME), pending implementation plan
**Author:** Reuben Singh (with Claude)
**Parent:** [2026-07-02-rack-builder-phase-2a-device-library-design.md](2026-07-02-rack-builder-phase-2a-device-library-design.md)
**Predecessor slice:** 3e (layout fixes). Bidirectional chevrons already landed in 3f (commit `6cfa80f`).

---

## 1. Context

Slice 3f's first half (bidirectional chevrons — drag right/down adds rows/cols,
left/up removes to a floor of 1, plain click adds one) is done and browser-verified.
Two settled items remain, both concerning **per-port overrides** (`PortGroup.portOverrides`).

Today `portOverrides` is a `Record<number, {...}>` keyed by the **row-major index**
`index = row * cols + col`. That key is only stable while `cols` and `rows` are fixed.
Now that chevrons add and remove columns/rows at will, two problems surface:

1. **Index scrambling.** When `cols` changes, the row-major index of an existing cell
   changes, so its override silently migrates to a *different* cell. Adding/removing a
   **column** re-maps every row's indices; the overrides no longer track their ports.
2. **No propagation.** A newly added row/column starts with no overrides, so if the user
   had flipped a column or moved its labels, the new ports don't match the pattern —
   they revert to defaults, forcing manual re-editing.

Separately, the editor can only set a port group's media **once, at creation**, for the
whole group. Real devices mix connector types within one physical block (e.g. a console
USB-C beside copper). We need **per-port type replace**.

## 2. Scope

### In scope
- **Override index remap** across column/row add & remove so existing per-port overrides
  stay attached to their real ports.
- **Override propagation:** a newly added column/row **copies `flipped`, `labelPos`, and
  `media`/`connectorType`** from the adjacent existing column/row so new ports match the
  established pattern. **`name` is NOT copied** (names are per-port identifiers; copying
  would duplicate labels).
- **Per-port type replace:** with a single port selected, **clicking a Port Type palette
  chip** changes just that port's `media` via a per-port override, resetting that port's
  `connectorType` to the new media's default (`CONNECTORS[media][0]`). Groups may mix
  media; `Faceplate` already renders per-cell `cell.media`.

### Out of scope
- Changing the `portOverrides` keying away from a numeric row-major index (we remap keys
  in place; no data-model re-key). Persisted jsonb shape is unchanged except `media`/
  `connectorType` become optional fields inside an override entry.
- Text/Icon elements (Slice 4). Per-port connector-type *picker* UI (the group-level
  connector select stays; per-port media uses the media default connector only).

## 3. Data model change

`PortGroup.portOverrides` entry gains two optional fields:

```ts
portOverrides: Record<
  number,
  { name?: string; flipped?: boolean; labelPos?: "top" | "bottom"; media?: Media; connectorType?: string }
>;
```

Backward compatible — existing saved faces (no `media`/`connectorType` in overrides)
render exactly as before (`override?.media ?? group.media`).

## 4. Behaviour — index remap + propagation

Overrides remain keyed by row-major `index = row * cols + col`. Grow/shrink ops now
transform the whole `portOverrides` map deterministically:

- **Add column** (`cols: c → c+1`):
  - Re-key every existing override: old `(row, col)` at `row*c + col` → new key
    `row*(c+1) + col`.
  - **Propagate:** for each `row`, the new cell `(row, c)` copies the **copyable fields**
    (`flipped`, `labelPos`, `media`, `connectorType`) of the source cell `(row, c-1)`
    if that source has an override; `name` is never copied. If the source has no
    override, the new cell gets none.
- **Remove column** (`cols: c → c-1`, floor 1):
  - Drop overrides whose `col === c-1` (the removed rightmost column).
  - Re-key survivors `(row, col)` from `row*c + col` → `row*(c-1) + col`.
- **Add row** (`rows: r → r+1`, cols `c` unchanged):
  - Existing keys are unchanged (row-major appends the new row's indices at the end).
  - **Propagate:** for each `col`, the new cell `(r, col)` at index `r*c + col` copies
    the copyable fields of the source cell `(r-1, col)` at `(r-1)*c + col` if present.
- **Remove row** (`rows: r → r-1`, floor 1):
  - Drop overrides whose `row === r-1` (indices `(r-1)*c .. (r-1)*c + c-1`). Others keep
    their keys.

**Copyable fields** = `{ flipped?, labelPos?, media?, connectorType? }`. **Never copied:**
`name`. An override that ends up empty (`{}`) is dropped so we don't persist noise.

These transforms live in the existing pure ops (`addColumn`/`removeColumn`/`addRow`/
`removeRow` in `portGroupOps.ts`), keeping them testable without React.

## 5. Behaviour — per-port type replace

- New pure op `setPortMedia(face, groupId, index, media)`:
  sets `portOverrides[index].media = media` and
  `portOverrides[index].connectorType = CONNECTORS[media][0]`, preserving any existing
  `name`/`flipped`/`labelPos` on that override.
- `layoutPortGroup` resolves per-cell media/connector:
  `media: override?.media ?? group.media`,
  `connectorType: override?.connectorType ?? group.connectorType`.
- **Wiring:** Port Type palette chips gain an `onClick`. When a **port is selected**
  (`selectedGroupId` set and `selectedPortIndex !== null`), clicking a chip calls
  `setPortMedia` for that port. When **no port is selected**, clicking does nothing
  (drag-to-create remains the way to add a new group — unchanged). Dragging chips is
  unchanged.
- `PortSettings` shows the port's current media label so the user can confirm the replace
  took effect (small read-only line; no new control).

## 6. Rendering rules

- A group with mixed per-port media renders each cell with its own glyph
  (`PORT_GLYPHS[cell.media]`) — already supported by `Faceplate`/`PortCell`.
- Numbering, labels, flip, spacing, centering, selection box, and chevrons are unaffected
  by mixed media (layout is media-agnostic; all glyphs are width-normalized to `GLYPH_W`).

## 7. Testing (TDD)

**Unit — `portGroupOps` (pure, no React):**
- Add column re-keys existing overrides to the new `cols` (e.g. a 2×1 group with an
  override on `(0,1)` keeps that override on `(0,1)` after growing to 3 cols).
- Add column propagates copyable fields from `(row, c-1)` into `(row, c)`; does NOT copy
  `name`.
- Remove column drops the rightmost column's overrides and re-keys survivors.
- Add row propagates from `(r-1, col)` into `(r, col)`; existing keys stable.
- Remove row drops the last row's overrides; other rows' keys stable.
- Empty overrides are pruned.
- `setPortMedia` sets `media` + default `connectorType`, preserves `name`/`flipped`.

**Unit — `layoutPortGroup`:**
- Per-cell `media`/`connectorType` fall back to group defaults when no override, and use
  the override when present.

**Component:**
- Selecting a port + clicking a palette chip replaces that port's media (the selected
  cell's glyph changes; others unchanged).
- Clicking a chip with no port selected does nothing (no new group, no change).
- After adding a column to a group with a flipped column, the new column's ports are
  flipped (propagation visible in rendered cells).

**Browser-verify (mandatory — per RESUME, editor bugs only show in the browser):**
- Flip a column, chevron-add a column → new column is flipped, existing overrides intact.
- Select a port, click a different port type in the palette → only that glyph changes.
- Remove a column that had overrides → remaining ports keep their correct overrides.

## 8. Edge cases

- Remove to the floor (cols/rows = 1) never removes the last column/row; overrides on the
  surviving column/row are untouched.
- Selecting a port then replacing media keeps the port selected/highlighted.
- A port whose media override equals the group media is allowed (harmless redundant
  override); pruning applies only to fully-empty override entries.
```
