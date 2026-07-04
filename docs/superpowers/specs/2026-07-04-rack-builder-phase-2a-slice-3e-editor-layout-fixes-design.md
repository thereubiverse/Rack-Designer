# Phase 2a · Slice 3e — Rack Device Editor: Rendering & Layout Fixes (Design)

_Date: 2026-07-04_

## Context

Live use of the editor (post-3d) surfaced rendering/layout problems and a palette-fidelity gap. Investigation confirmed: the 19″ device SVG renders at 934px but the canvas container is only ~780px, so the right ear + screw holes scroll off-screen; a default 19″ **body** width leaves no ears at all; and the palette shows only the 10 port-type chips (the mockup's "Port Types"/"Elements" sections are absent).

This slice fixes the **visual/layout** issues. Its sibling **3f** handles the interaction/model changes (bidirectional chevrons, override propagation + index-remap, per-port media replace). 3e is delivered as one stacked slice on `phase-2a-slice-3d`.

## Goal

Make the editor render the whole device legibly at any window size, with ears + screw holes visible by default, labels that never clip, a clear selected-port indicator, and a palette that matches the mockup (Port Types + Elements sections).

## The five changes

### 1. Fit-to-window scaling

The device must always fit the editor canvas, keeping true 1U proportion and keeping the interactive overlay aligned.

- `EditorCanvas` measures its available width and computes `scale = min(1, availableWidth / svgWidthPx)` (never upscale past 1).
- Both the pure `Faceplate` SVG **and** the interactive overlay are wrapped in a single container with `transform: scale(scale); transform-origin: top left`, so they scale together and stay pixel-aligned automatically. The overlay keeps computing positions in **device pixels** (unchanged from 3d); the CSS transform does the visual scaling. The scaled wrapper's outer box is sized `svgWidthPx*scale × svgHeightPx*scale` so it no longer overflows the container (with room for the controls that sit just outside the device edge).
- **Pointer input is converted from screen pixels to device pixels by dividing by `scale`** in every handler that reads client coordinates: drop position, group move deltas, spacing-handle deltas, chevron drag deltas, and per-cell hit math. (At `scale === 1` this is a no-op, so existing component tests are unaffected.)
- Measuring uses a `ResizeObserver` on the canvas container, guarded for environments that lack it (jsdom). When unavailable/unmeasured, `scale` defaults to `1` — so component tests run at 1:1 exactly as today, and the real browser scales.
- `Faceplate` stays a pure function of its inputs (unchanged): scaling is entirely a container/overlay concern.

### 2. Default body width 17.5″ (ears + screw holes by default)

- `emptyDraft().widthIn` changes from `19` to `17.5`. The frame stays the 19″ rail span; a 17.5″ body yields `(19 − 17.5)/2 = 0.75″` ears each side, so a new device renders with ears + pinned screw holes. The user can still set 19 for a true full-width (no-ear) device.

### 3. Palette restructure (mockup layout)

Rebuild the modal's palette to match `editor-window-restored.html`:
- A **Port Types** section: a vertical "Port Types" label beside a box of the 10 draggable media chips (unchanged behavior — drag to create a group).
- An **Elements** section: a vertical "Elements" label beside a box with **Text** and **Icon** chips. These are **inert** in 3e (not draggable, no handlers) — their drag-to-create/edit is Slice 4. They render for visual fidelity only.
- Uses the existing `PortGlyph` set for the media chips and the mockup's Text/Icon glyphs for the element chips.

### 4. Labels always visible (no clip or overlap)

Requirement: after adding a second row, both rows' number labels render fully; toggling a port's label position keeps it visible and clear of the adjacent row.

- This is **primarily delivered by the fit-to-window scaling (§1)** — the reported "labels not visible" was a symptom of the horizontal clipping (the whole device, labels included, now fits). The existing `maxSpacing.maxRow` clamp already reserves `2*LABEL_H` so the outer labels stay within the device height at any `rowSpacing`; verified analytically for 1U (a 2-row group at max `rowSpacing` keeps the top label ≥ 0 and the bottom label ≤ `heightPx`).
- The only residual is a label toggled to the **inner** side (e.g., a bottom-row label set to top, facing the row above) sitting close to the neighbouring glyph. Verify in the browser; if it overlaps at tight spacing, enforce a small minimum inter-row gap when an inner label is present. Exact margins are tuned during verification.
- **No `layoutPortGroup` centering change** — the 3d glyph positions and geometry tests stay as-is. Labels-visible is a fit + verification concern, not a geometry rewrite.

### 5. Blue selection box around the tile

- In the overlay, the **selected port** shows a blue outline box surrounding its whole **tile** (glyph box + its label strip), in addition to the 3d in-place blue recolor. The box rect is the cell's glyph box (`CELL_W × ROW_H` at `cell.x, cell.y`) extended by `LABEL_H` on the label's side (`top` → extend up, `bottom` → extend down). Rendered as an overlay div (`data-testid="port-select-box"`), it does not block the underlying click target (`pointer-events: none`).

## Architecture & affected units

- **`src/features/device-library/editor/EditorCanvas.tsx`** — fit-to-window scale (container transform + `scale` state via ResizeObserver, default 1); divide client-derived coordinates by `scale`; render the blue `port-select-box` for the selected port. Overlay position math otherwise unchanged (device px).
- **`src/features/device-library/editor/useDeviceDraft.ts`** — `emptyDraft().widthIn = 17.5`.
- **`src/features/device-library/editor/RackDeviceEditor.tsx`** — palette restructured into Port Types + Elements sections; Text/Icon chips inert.
- **`Faceplate.tsx` and `faceplate-geometry.ts` are NOT modified** (stay pure; the 3d label top/bottom rendering + `maxRow` clamp already keep labels in bounds — 3e only makes them visible via scaling and computes the tile box in the overlay).

## Data model

No changes. (Per-port media / override-propagation are 3f.)

## Error handling & edge cases

- `scale` clamps to `(0, 1]`; when the container is wider than the device, `scale = 1` (no upscaling). If the container width is 0/unmeasured, `scale = 1`.
- Pointer→device conversion divides by `scale`; guard against `scale === 0` (default 1).
- The default 17.5″ body still round-trips as a normal `width_in`; existing saved devices keep their stored width (only the new-device default changes).
- Labels-visible centering must not push a single-row group off-center — for one row the reserved margins are symmetric, so it stays centered.

## Visual style

Matches the mockup: "Port Types"/"Elements" vertical section labels (`writing-mode: vertical-rl`), chip styling as today, the selected-port blue box in `#2d5bff`. Device scales to fit with true proportion; ears/screw holes visible on a default device.

## Testing (TDD)

**Component (`EditorCanvas`):**
- At the default `scale === 1` (jsdom), overlay coordinates and all existing behaviors are unchanged (existing tests pass).
- A helper converts client→device coordinates by `/scale`; unit-test the conversion at a sample scale (e.g., inject scale and assert a drop at a scaled client point maps to the right device pos) — or test the pure conversion function directly.
- The selected port renders a `port-select-box`; no box when no port selected.

**Component (`useDeviceDraft`):** `emptyDraft().widthIn === 17.5`.

**Component (editor):** the palette renders a "Port Types" section and an "Elements" section with Text + Icon chips; the media chips are draggable and the Text/Icon chips are not.

**Browser verification:** open Create — the whole default device (with ears + screw holes) fits the canvas at a scaled size; drag/drop/select/chevron/spacing/move all still land correctly under scaling; both rows' labels are visible after adding a row; toggling a label stays visible; the selected port shows the blue tile box; the palette shows Port Types + Elements sections. Save + reopen to confirm nothing regressed.

## Decomposition note

3e is purely rendering/layout — no data-model change, `Faceplate` untouched. 3f then layers the interaction/model changes (bidirectional chevrons, override propagation + `portOverrides` index remap, per-port media replace) on the same overlay + ops seams.
