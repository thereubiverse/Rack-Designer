# RESUME — where we are & how to continue

_Last updated: 2026-07-04 (mid Slice 3f)_

## Project
Network documentation platform (rack builder). Next.js 16 + Supabase (local via Docker +
`npx supabase start`). Repo: https://github.com/thereubiverse/Rack-Designer (remote `origin`,
HTTPS; `gh` authed). Built with the superpowers workflow (brainstorm → spec → plan →
subagent-driven execution). ALWAYS browser-verify interactive editor changes — 3d and 3f each
had bugs only visible in the browser (setState-inside-updater; stale-`activeFace` on multi-add).

## Branch stack & PR state
Everything stacks; each branch is based on the previous:

    main
     └─ phase-2a-slice-2   → PR #2  (open)
         └─ phase-2a-slice-3a → PR #3 (open)
             └─ phase-2a-slice-3b → PR #4 (open)
                 └─ phase-2a-slice-3c → PR #5 (open)
                     └─ phase-2a-slice-3d  (NOT PR'd — complete, review clean, 158 tests)
                         └─ phase-2a-slice-3e  (NOT PR'd — complete, review clean, 165 tests)
                             └─ phase-2a-slice-3f  (IN PROGRESS — bidirectional chevron done, 170 tests)

- ✅ Phase 1 + Phase 2a Slice 1 — merged to `main` (PR #1).
- ✅ Slice 2 (SVG faceplate renderer) — PR #2. Slice 3a (editor shell) — PR #3. 3b (port-group
  building) — PR #4. 3c (spacing + per-port select/name/flip) — PR #5.
- ✅ Slice 3d (editor refinements) — device-height-aware `layoutPortGroup` auto-centers rows;
  horizontal-only collision; in-place blue highlight (pure `Faceplate.highlight` prop); per-port
  `labelPos`; chevron click-or-drag; horizontal-only move; `setActiveFace` accepts `(prev)=>Face`.
- ✅ Slice 3e (rendering/layout fixes) — fit-to-window scaling (SVG+overlay in one `transform:scale`
  container, pointer input ÷ scale, `toDevicePos` helper); default body width 17.5″ (ears+holes);
  palette Port Types + Elements sections (Text/Icon inert); blue tile selection box.
- 🚧 Slice 3f (IN PROGRESS): **bidirectional chevrons DONE** (commit 6cfa80f, browser-verified) —
  `removeColumn`/`removeRow` (floor 1); chevron drag signed (round(dist/step), clamp −(initial−1));
  drag right/down adds, left/up removes, plain click adds one; scale-aware.

## Slice 3f — remaining (approved design, NOT built; no spec/plan doc yet)
1. **Override propagation + index remap.** Adding a row/column should copy the flip/labelPos/media
   state so new ports match the existing pattern; and fix `portOverrides` (keyed by `row*cols+col`)
   scrambling when `cols`/`rows` change — now critical since add/remove shifts indices.
2. **Per-port type replace.** Select a port + click a palette port type → change JUST that port's
   media via a per-port override (`portOverrides[i].media` + default connectorType); groups can mix
   port types (Faceplate already renders per-cell `cell.media`, so mostly a layout/settings change).

Write a 3f spec+plan (the brainstorm is done — decisions above are settled), then subagent-driven.

## Next steps (in order)
1. Finish Slice 3f (the 2 items above).
2. Open the PR stack: push + PR 3d (base 3c), 3e (base 3d), 3f (base 3e). Then merge bottom-up
   #2→#3→#4→#5→3d→3e→3f (each auto-retargets to `main` as its base merges).
3. Slice 4 — Text/Icon ELEMENTS: drag the (currently inert) Text/Icon palette chips onto the grid;
   render `Face.elements` (Faceplate ignores them today). See Phase 2a spec §4.7.
4. Phase 2b — place devices into racks (reuses the pure `Faceplate`/`renderFace`).

## Backlog / deferred
- `Face.elements` not rendered (Slice 4).
- `LABEL_GUTTER=22` duplicated in `EditorCanvas.tsx` + `Faceplate.tsx` — must stay in sync for the
  fit-to-window scale math; DRY by exporting it (do in 3f or later).
- `EditorCanvas` `drag.dy` computed but unused (move is horizontal-only). `portSequence` switch has
  no `default`. 3a hidden-span errors sink + `onSaveGuard`.

## Key files
`src/features/device-library/editor/`: `EditorCanvas.tsx` (overlay, fit-scaling, all pointer drags),
`portGroupOps.ts` (pure ops), `RackDeviceEditor.tsx` (modal/palette/wiring), `PortSettings.tsx`,
`PortGroupSettings.tsx`, `useDeviceDraft.ts`, `repository.ts`/`actions.ts`/`validation.ts`.
Pure renderer: `src/features/device-library/faceplate/Faceplate.tsx`, `src/domain/faceplate-geometry.ts`
(`layoutPortGroup`, `frameDims`), `src/domain/faceplate.ts` (types). Mockup:
`.superpowers/brainstorm/*/content/editor-window-restored.html`.

## To resume in a fresh session
`git checkout phase-2a-slice-3f`, ensure Docker + `npx supabase start` are up, then say:
**"Resume the rack-builder — read docs/superpowers/notes/RESUME.md, we're mid Slice 3f."**
(Claude's project memory also carries this state.)
