# Device Wizard — per-row port orientation detection

**Date:** 2026-07-10
**Status:** Design approved, pending plan

## Problem

The Device Wizard lays out every detected port in the same orientation, but real
switches usually **mirror their two RJ45 rows** (top row tabs one way, bottom row
the other). The applied faceplate therefore doesn't match the real hardware for
common two-row devices.

## Goal

Have the vision detection also report **per-row port orientation** (connector tab
up vs down) and apply it as port `rotation`, so a two-row switch comes out
mirrored like the real device. Best-effort and fully editable afterward.

## Settled decisions (from brainstorming)

- **Granularity: per row.** The model reports one orientation per row; layout
  applies it to every port in that row.
- **Axis: up/down only** → maps to `rotation` `180` / `0` (matches the editor's
  existing "Flip" = 180° rotation). Sideways/vertically-mounted ports (90°/270°)
  are out of scope — rare and unreliable to read; addable later.
- **Non-destructive default:** when the model reports nothing, rows default to
  the normal orientation, so existing behavior is unchanged.
- **Best-effort:** tab direction is subtle in a photo; the model won't always get
  it right. It's editable via the editor's Flip control like the rest of the
  detected layout.

## Changes

- **Contract** (`aiDetect.ts`): `DetectedGroup` gains
  `rowOrientations?: ("up" | "down")[]` — one entry per row.
- **Validation** (`validateDetectedFace`): coerce each entry to `"up"`/`"down"`,
  clamp the array length to the group's `rows`, default missing/blank to
  `"down"` (normal). Drop the field if not a usable array.
- **Prompt** (`visionBackend.ts`): add a line asking the model to report, per
  row, whether the connector tabs/clips point up or down, noting the two rows of
  a switch are often mirrored.
- **Layout** (`layoutDetectedFace.ts`): when building each `PortGroup`, set
  per-port `rotation` in `portOverrides` — every port at row `r` gets
  `rotation = rowOrientations[r] === "up" ? 180 : 0`. Confirm during
  implementation which physical direction the glyph's default `0°` is and map
  `"up"`/`"down"` so they render correctly; if none reported, leave rotation
  unset (current behavior).

## Testing

- Validation: coercion of good/bad entries, length clamp to `rows`, default when
  absent, field dropped when not an array.
- Layout: a 2-row group with `rowOrientations: ["down","up"]` yields row-0 ports
  at `rotation 0` and row-1 ports at `rotation 180` (mirrored); a group with no
  `rowOrientations` leaves rotation unset (unchanged behavior).

## Out of scope

- 90°/270° (sideways/vertical) port orientation.
- Per-port (within a row) orientation differences.
- Changing how orientation renders (reuses existing `rotation` glyph rendering).
