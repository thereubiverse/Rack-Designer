# Device Wizard — Mixed Types + Accurate Positioning Plan

> Small extension of the two-stage pipeline; execute inline with TDD.

**Goal:** Per-port mixed types (A), single-row vertical position (B), horizontal order + extent (C).

## Global Constraints
- Two-stage: model reports semantics (`portTypes` index+media, `bbox`); layout computes geometry.
- Non-destructive: absent fields → current behavior unchanged.
- Validate model output; grid-snapped; co-located tests; `npx vitest run <path>`.

## Task 1 — Contract + validation (A) — `aiDetect.ts` (+ test)
- `DetectedGroup` gains `portTypes?: { index: number; media: Media; connector?: string }[]`.
- In `coerceGroup`: bind `const count = clamp(...)`; coerce `portTypes` — array only; per entry: `coerceMedia(media)` (drop if none), `index` rounded and in `[0, count-1]` (drop otherwise), `connector` kept only if in `CONNECTORS[media]` else `undefined`. Include the filtered array (`undefined` when input isn't an array).
- Tests: valid entry kept; unknown media dropped; out-of-range index dropped; bad connector → undefined; non-array → field undefined.
- Commit: `feat(device-wizard): detect per-port mixed types (contract + validation)`

## Task 2 — Prompt + schema (A) — `visionBackend.ts`
- Schema group `items.properties`: `portTypes: { type: ARRAY, items: { type: OBJECT, properties: { index: {NUMBER}, media: {STRING}, connector: {STRING} }, required: ["index","media"] } }`.
- Prompt: "If ports within one block are different types, set the group's media to the dominant type and list the exceptions in portTypes: each as { index (0-based in the group's counting order), media, connector }."
- `tsc` clean. Commit: `feat(device-wizard): ask Gemini for per-port mixed types`

## Task 3 — Layout A+B+C — `layoutDetectedFace.ts` (+ test)
Import `CONNECTORS` from `@/domain/faceplate`; `resolveYOffset` from `../editor/portGroupOps`.

In `toPortGroup`:
- **C extent:** `const tightWidth = cols * CELL_W; const targetWidth = d.bbox.w * bounds.width; const maxSpread = cols > 1 ? Math.max(0, (bounds.width - tightWidth) / (cols - 1)) : 0; const colSpacing = cols > 1 && targetWidth > tightWidth ? Math.min((targetWidth - tightWidth) / (cols - 1), maxSpread) : 0;` — set on the group.
- **A per-port types:** after the rotation loop, `if (d.portTypes) for (const pt of d.portTypes) portOverrides[pt.index] = { ...portOverrides[pt.index], media: pt.media, connectorType: pt.connector ?? CONNECTORS[pt.media][0] };`
- **B single-row vertical:** build the group object with `yOffset: 0`, then set:
  `g.yOffset = d.rows === 1 ? resolveYOffset(g, bandCenter - bounds.height / 2, bounds, GRID_PX) : (bounds.height > RU_PX ? snap(bandCenter - bounds.height / 2) : 0);`
  (restructure so the group `g` exists before computing yOffset; keep the multi-row branch identical to current behavior.)

In `layoutDetectedFace`:
- **C order:** `const groups = [...face.groups].sort((a, b) => a.bbox.x - b.bbox.x);` and iterate `groups` (not `face.groups`). Placement via `findFreePosition` unchanged (it already accounts for colSpacing in group width).

Tests:
- A: group with `portTypes: [{index:2, media:"sfp"}]` → `portOverrides[2].media==="sfp"`, `connectorType==="SFP"`; a port with a rotation override keeps rotation when it also gets a type (merge).
- B: single-row group `bbox.y:0.7` → `yOffset > 0`; `bbox.y:0` (top) → `yOffset < 0` or 0; centred stays ~0.
- C: two groups returned right-then-left (`bbox.x` 0.6 then 0.1) come out with ascending `gridX`; a group with wide `bbox.w` (e.g. 0.9, few cols) → `colSpacing > 0`; a tight `bbox.w` → `colSpacing === 0`.
- Commit: `feat(device-wizard): per-port types + single-row vertical + horizontal order/extent in layout`

## Verify
- `npx vitest run` green; `tsc` clean. Browser: re-detect a switch; confirm mixed types, row height, and left-to-right layout match the photo. Note any mapping that needs inverting.
