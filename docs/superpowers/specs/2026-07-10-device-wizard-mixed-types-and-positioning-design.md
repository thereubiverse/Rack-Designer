# Device Wizard — mixed port types + accurate positioning

**Date:** 2026-07-10
**Status:** Design approved, pending plan

## Goal

Make the wizard's applied faceplate as close to the real device as possible, on
three axes:
- **A. Mixed port types within a block** (per-port types).
- **B. Vertical position of single-row groups** (top/middle/bottom of their RU).
- **C. Horizontal position + extent** of groups (left-to-right order, real width).

All best-effort (rides on the model's approximate `bbox`), grid-snapped, and
editable — building on the existing two-stage pipeline and the per-row
orientation work.

## Part A — mixed per-port types

The app stores per-port type via `portOverrides[i].media` + `connectorType`.

- **Contract** (`aiDetect.ts`): `DetectedGroup` gains
  `portTypes?: { index: number; media: Media; connector?: string }[]` — a sparse
  list of ports that differ from the group's base `media`.
- **Prompt** (`visionBackend.ts`): when a block mixes types, report the dominant
  type as the group's `media`, and list each differing port's 0-based index (in
  the group's counting order) + its media (and connector if legible).
- **Validation** (`validateDetectedFace`): coerce `media` against `MEDIA` (drop
  if unknown) and `connector` against `CONNECTORS[media]` (fallback to that
  media's first connector), clamp `index` to `[0, count-1]`, drop invalid
  entries; drop the field entirely if not an array.
- **Layout** (`layoutDetectedFace`): for each entry, set
  `portOverrides[index] = { media, connectorType: connector ?? CONNECTORS[media][0] }`,
  merged into the same `portOverrides` map the orientation feature writes (a port
  can carry both a rotation and a media override).

## Part B — single-row vertical position

No contract change (uses `bbox.y`).

- **Layout**: for **single-row** groups, compute `yOffset` from the detected
  `bbox` vertical centre using the app's `resolveYOffset` (snaps the glyph to the
  grid and clamps it inside the device), so the row sits high/low within its RU
  to match the panel. Multi-row groups keep their current centred/banded
  behavior.

## Part C — horizontal order + extent

No contract change (uses `bbox.x` / `bbox.w`).

- **Order**: place groups **left-to-right by `bbox.x`** (not the model's return
  order), so overlap-resolution preserves real relative positions and only nudges
  rightward into free space.
- **Position**: keep `gridX` from `bbox.x`, snapped to the editor's 12px grid.
- **Extent**: derive `colSpacing` from `bbox.w` — if the detected block is wider
  than the tight port packing (`cols * CELL_W`), spread the ports so the group
  spans the real width, clamped so the spread group still fits the device width
  (`≥ 0`). A tighter-than-minimum block just packs normally.

## Testing

- Validation: `portTypes` coercion (bad media dropped, bad connector → default,
  index clamp), non-array dropped.
- Layout A: a group with `portTypes` sets the right per-port `media`/
  `connectorType`, and coexists with rotation overrides on other ports.
- Layout B: a single-row group with a high `bbox.y` gets a downward `yOffset`;
  a centred one gets ~0.
- Layout C: groups returned out of order are placed left-to-right; a group with
  a wide `bbox.w` gets `colSpacing > 0`; a tight one gets `0`.

## Out of scope

- Vertical position of multi-row groups (keep current behavior).
- Sub-grid horizontal precision (grid-snapped by design).
- Detecting exact inter-port gaps beyond a uniform `colSpacing` per group.
