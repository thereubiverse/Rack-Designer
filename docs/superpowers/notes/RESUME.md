# RESUME — where we are & how to continue

_Last updated: 2026-07-02_

## Project
Network documentation platform (rack builder). Next.js 16 + Supabase (local via Docker +
`npx supabase start`). Repo: https://github.com/thereubiverse/Rack-Designer (remote
`origin`, HTTPS; `gh` authed). Built with the superpowers workflow.

## Current state
- ✅ **Phase 1** — location hierarchy, naming engine, repository, synced rack grid — merged to `main`.
- ✅ **Phase 2 design** — master spec + Phase 2a spec approved.
- ✅ **Phase 2a · Slice 1** — Device Library data model + template management — **PR #1
  squash-merged to `main`** (2026-07-03).
- ✅ **Phase 2a · Slice 2** — SVG faceplate renderer + rack-mount geometry (pure
  `faceplate-geometry.ts`, 10 port glyphs, reusable `Faceplate`/`renderFace`,
  `/device-library/preview`) — 57 tests, review clean, **PR #2 open**:
  https://github.com/thereubiverse/Rack-Designer/pull/2
- ✅ **Phase 2a · Slice 3a** — Rack Device Editor SHELL: modal, header fields, Front/Back +
  Rack-Mounted toggles, live read-only `Faceplate` preview (`EditorCanvas`), draft-in-state
  atomic Save, Face-typed persistence, structured actions, `EditorLauncher`, table Edit action
  (removed `CreateDeviceForm`) — branch `phase-2a-slice-3a` (stacked on slice-2), 83 tests,
  browser-verified, review clean, **PR #3 open** (base = phase-2a-slice-2):
  https://github.com/thereubiverse/Rack-Designer/pull/3
- ✅ **Phase 2a · Slice 3b** — port-group building: `portGroupOps.ts` (pure add/move/grow/update/
  delete + nudge-to-nearest-free 8px ring-search, overlaps disallowed), `EditorCanvas` overlay
  (select / drop-to-create / edge chevrons / drag-to-move), `PortGroupSettings`, wired into the
  modal — branch `phase-2a-slice-3b` (stacked on 3a), 118 tests, browser-verified, review clean,
  **PR #4 open** (base = phase-2a-slice-3a): https://github.com/thereubiverse/Rack-Designer/pull/4

## Slice 3 decomposition (three sub-slices)
- **3a** — shell + live preview + persistence (DONE, PR #3).
- **3b** — port-group building: drag→group, select, edge chevrons, drag-to-move, delete, settings (DONE, PR #4).
- **3c** — clamped spacing handle + per-port select (name + vertical flip). ALSO fold in 3b's
  deferred live drag-follow visual + red would-overlap outline (build with the spacing-handle drag).
- Architecture locked: overlay interactive controls onto the pure read-only `Faceplate` via the
  `EditorCanvas` (position:relative overlay origin). `Faceplate` stays pure for Phase 2b reuse.

## Next steps (in order)
1. **Merge in order:** PR #2 → (#3 auto-retargets to main) → #3 → (#4 auto-retargets) → #4 → sync main.
2. **Slice 3c** — the clamped bottom-right spacing handle (spread ports; hard-static stop at the grid
   edge, limit computed once on grab) + per-port select (label+icon turn blue, name field, vertical
   flip: glyph mirrors, number stays). Brainstorm → spec → plan → subagent. Extends the same
   `EditorCanvas` overlay + `portGroupOps` seams. See Phase 2a spec §4.5–4.6.
3. **Slice 4 — Text/Icon elements** (Tabler icon picker) — also renders `Face.elements`,
   which Slice 2 deferred — then **Phase 2b** (place devices into racks).

## Where everything lives
- **Specs:** `docs/superpowers/specs/` — the Phase 2a spec has ALL editor mechanics + geometry.
- **Plans:** `docs/superpowers/plans/`.
- **Backlog:** `docs/superpowers/notes/phase-*-deferred.md`.
- **SDD progress ledger:** `.superpowers/sdd/progress.md`.
- **Editor mockups:** `.superpowers/brainstorm/` (final editor = `editor-window-restored.html`; custom-device test = `custom-device-test.html`).

## To resume in a fresh session
Open the project and say: **"Resume the rack-builder — read docs/superpowers/notes/RESUME.md
and the Phase 2a spec, then let's continue."** (Claude's memory also carries the current
state.) Ensure Docker + `npx supabase start` are running for DB work.
