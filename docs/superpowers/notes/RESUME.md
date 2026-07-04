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
- ✅ **Phase 2a · Slice 3c** — spacing handle + per-port editing + live-move outline: `portGroupOps`
  (setPortOverride/setSpacing/maxSpacing/wouldOverlapAt), `EditorCanvas` per-port targets + BLUE
  overlay copy (Faceplate stays pure), clamped live spacing spread, `PortSettings` (name/flip),
  live group-move red would-overlap outline — branch `phase-2a-slice-3c` (stacked on 3b), 139 tests,
  browser-verified + DB round-trip, review clean, **PR #5 open** (base = phase-2a-slice-3b):
  https://github.com/thereubiverse/Rack-Designer/pull/5

## Slice 3 (Rack Device Editor) — COMPLETE
- **3a** shell + preview + persistence (PR #3) · **3b** port-group building (PR #4) · **3c** spacing
  handle + per-port select/name/flip + live-move outline (PR #5). All browser-verified.
- Architecture: overlay interactive controls onto the pure read-only `Faceplate` via `EditorCanvas`;
  `Faceplate` stays pure (reused by Phase 2b). Overlaps disallowed → nudge. Name/flip ride `portOverrides`.

## Next steps (in order)
1. **Merge the stack bottom-up:** PR #2 → (#3 auto-retargets to main) → #3 → (#4) → #4 → (#5) → #5 → sync main.
2. **Slice 4 — Text/Icon elements:** drag Text/Icon onto the grid (per-face `Face.elements`, deferred
   from Slice 2/3). Text: content, alignment, Highlighted (inverted label), resize expands the BOX not
   the font. Icon: Tabler picker (~5000, searchable), resize scales the glyph. Both repositionable/
   deletable on the same `EditorCanvas` overlay. `Faceplate` must render `Face.elements` (currently
   ignored). Brainstorm → spec → plan → subagent. See Phase 2a spec §4.7.
3. **Phase 2b** — place devices into racks (reuses the pure `Faceplate`/`renderFace`).

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
