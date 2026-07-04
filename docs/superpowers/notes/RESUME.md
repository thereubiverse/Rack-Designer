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
  `faceplate-geometry.ts`, 10 own-original width-normalized port glyphs, reusable
  `Faceplate`/`renderFace`, `/device-library/preview` route) — done on branch
  `phase-2a-slice-2`, 57 tests pass, whole-branch review clean, **PR #2 open**
  (not yet merged): https://github.com/thereubiverse/Rack-Designer/pull/2

## Next steps (in order)
1. **Merge PR #2** — on GitHub, or `gh pr merge 2 --squash --delete-branch`, then sync main.
2. **Slice 3 — the visual Rack Device Editor** (fully designed in mockups): port-group
   build (drag → group, edge chevrons add col/row), the clamped bottom-right spacing
   handle, per-group settings (ID prefix, counting direction, connector type),
   per-port select (label+icon turn blue) + vertical flip, Width(in) field, Rack Mounted
   toggle, responsive reflow. Builds interactivity on top of Slice 2's read-only
   `Faceplate`/`renderFace`. See the Phase 2a spec §4–5 for exact mechanics.
3. **Slice 4 — Text/Icon elements** (Tabler icon picker) — also renders `Face.elements`,
   which Slice 2 deferred — + finish, then **Phase 2b** (place devices into racks).

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
