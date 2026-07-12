# RESUME — where we are & how to continue

_Last updated: 2026-07-07 (vertical port/label placement feature set; 262 tests green)_

## Vertical port/label placement (2026-07-07) — single/2-row/3+ snap positions + left handle
Editor feature built iteratively (all in `EditorCanvas.tsx`, `portGroupOps.ts`, `RackDeviceEditor.tsx`,
`PortSettings.tsx`). Pure ops all TDD'd in `portGroupOps.test.ts`.
- **Left up/down handle** (blue filled triangles, `chevronStyle` circle, left edge of the box) controls
  the vertical port/label POSITION. `vertDrag` state, live-commits on drag:
  - single-row (rows===1): 6 positions (`singleRowPositions`/`rankForRowState`/`resolveRowRank`) — glyph
    slides in a 1RU slot from top-pad-edge(label below) → high → centre-top(default) → centre-bottom →
    low → bottom-pad-edge(label above). Commits `onVerticalMove(id, yOffset, labelPos)`.
  - 2-row: 2 positions (`twoRowPositions`/`rankForTwoRowState`) — rows together (labels outside) ↔ spread
    to pad edges (`TWO_ROW_SPREAD`=24, labels swapped inside via `setRowLabels`). Commits `onRowSnap`.
  - 3+ rows: all labels default BOTTOM (`layoutPortGroup` + `addRow` resets on 2→3); the handle only flips
    all labels above/below (`labelSidePositions`/`rankForLabelSide`), glyphs stay put.
- **Standalone Label toggle is HIDDEN for ALL groups** (`hideLabel` on PortSettings/BatchSettings) — the
  left handle owns the label side, so it can never go out of bounds.
- **Spacing handle** = spacing only now (`spaceDrag`): columns always; rows only when `maxRow>0` (2RU+);
  smooth, or grid-stepped when snap-to-grid on. Hidden when nothing to space (lone port). Removed the
  earlier snap-on-spacing-handle behavior.
- **1RU selection box** for single-row groups. On 1RU the box fills the device (fixed slot, glyph slides).
  On **2RU+** the box FOLLOWS the port during a whole-group drag but STAYS 1RU tall: `resolveSingleRowBoxOffset`
  snaps the BOX top to 25%-of-1RU (`vSnapStep`=RU_PX/4=21) when snap-on and clamps it to `[0, H−RU_PX]` so
  the box never shrinks/clips. Ghost/drop-preview box is 1RU too. `RU_PX` const in faceplate-geometry.
- **Bugs fixed this session:** marquee glyph-bounds hit-test (was padded box); in-box control clicks
  (chevrons/spacing/vert-handle) now stopPropagation so they don't bubble to the wrapper's clearSelection
  and deselect; `addRow` 1→2 resets the single-row snap state (was placing the new row off-centre + label
  overlap). NO spec doc written for this feature set.

## Prior state
_Marquee select bugfix (2026-07-06); 237 tests green — committed as b6964fa/pushed._

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
- ✅ Slice 3f (functionally COMPLETE on branch `phase-2a-slice-3f`, NOT PR'd; 188 tests green,
  typecheck clean, all browser-verified). A long interactive-polish session landed everything below.
- ✅ **3f follow-ups (2026-07-06, commit `9ad9560`, 203 tests, NOT pushed):** three editor
  improvements on the same branch —
  1. **Type propagation on grow** — `shapeOf` now copies a port's TYPE (media + connector), so a
     chevron duplicates the current port instead of the group's original type (was a bug).
  2. **Flip toggle = rotation** — the port-settings "Flip" now rotates 180° (like the Rotate
     button) instead of mirror-flipping, with a sliding white knob like Rack Mounted.
  3. **Multi-select** — shift+click ports (within one group) or whole group boxes to batch-edit
     rotation + label position; batch panel (Flip + Label); "Delete groups" button + Delete/Backspace
     key. New pure ops `patchPorts`/`rotatePorts`/`deletePortGroups`; `Faceplate.highlight` accepts
     an array; selection state is now `selectedGroupIds[]` + `selectedPortIndices[]`.
     Spec: `docs/superpowers/specs/2026-07-06-rack-builder-editor-multi-select-design.md`.
- ✅ **Snap-to-grid + vertical placement + palette drag ghost (2026-07-06, commit `40608ad`, 213 tests,
  NOT pushed):**
  1. **Snap-to-grid** — the toggle now governs group dragging: 0.25in (12px) grid, snapped from the port
     icon; free (1px) when off. New-group drop + drop-preview respect it too. Grid constant `GRID_PX` in
     faceplate-geometry.
  2. **Vertical group placement** — new optional `PortGroup.yOffset` (backward-compatible, centered when
     unset); groups drag up/down on **2RU+** devices (1RU auto-centered). `layoutPortGroup` clamps it;
     collision is now **2D (AABB)** so groups can share an X column when vertically separated. New pure
     `resolveYOffset`; `movePortGroup(target,{snap,allowVertical})`.
  3. **Selection box** thinned to **1px** (matches chevron circles).
  4. **Palette drag ghost** — dragging a port type shows a full-size, 80%-opacity chip clone anchored to
     the grab point (native drag image + "+" badge suppressed); over empty device space a **50%-opacity
     drop-preview box** shows where the new group lands (shared `clampedBox`); over a port → port highlight.
  NO spec doc written for this one yet.
- ✅ **Editor interaction features (2026-07-06, commit `c120a26`, PUSHED):**
  - **Front/Back label** now sits on the right ear, centered between the screws (dominant-baseline central);
    ears off → just inside the body's right edge. Gutter removed; render scales to fill so the device's
    right edge lines up with the toolbar toggles (EditorCanvas scale no longer clamped to 1).
  - **Smart guides** (`alignmentGuides.ts`, pure+tested) while dragging a group: edge/center alignment
    (H + vertical on 2RU+), equal spacing, centered-between, device center, equal-distance-to-edge. Dashed
    blue lines + px spacing brackets, clamped to body. Core `guidesForMovingRect` reused by multi-move.
  - **Marquee select**: drag blank/padding → selects every group the box touches; **selects LIVE during the
    drag** (doesn't depend on release), intersects the real on-screen group rects, solid line, body-clamped.
    Groups only grab presses on their **glyph** (`onGlyph` gate) so the padding around them is marquee-able.
  - **Multi-group move**: drag a multi-selection → moves the set together (snap, guides on bounding box,
    external-overlap block, body clamp). Pure `moveGroups`.
  - **Alt/Option+drag = duplicate**: clones the set, drags the copies, originals stay; copies discarded on
    no-move/overlapping drop. Pure `duplicateGroups`. Alt no longer suppresses guides. `Faceplate.movePreview`
    accepts an array. NO spec doc for this batch.
- ✅ **Editor visual polish (2026-07-06, commit `49904c5`, PUSHED):** hover states on all clickable editor
  controls (white → `#f5f5f5` = middle-section bg; blue Create/Add desaturate); middle section bg `#f5f5f5`;
  faceplate palette — white body `#ffffff`, ears+outline+seams `#d4d4d4`, screw holes `#a3a3a3`; frame
  outline refactor (fills unstroked + single inset outer outline + explicit seam lines so ear corners aren't
  viewBox-clipped).

- ⚠️ **Marquee select bugfix (2026-07-06, NOT committed; 237 tests):** two browser-only bugs found via
  systematic-debugging + browser-verify —
  1. **Selected too early** — `marqueeSelect` (EditorCanvas.tsx) hit-tested the full PADDED `group-box`
     rect (SEL_PAD=6 all round + LABEL_H=12 label strips) plus an extra SLACK=8, so it grabbed a group
     ~14px (H) / ~26px (V) before the box touched the visible ports. Fix: inset the box's on-screen rect
     back to the glyph bounds (`SEL_PAD*scale`, `(LABEL_H+SEL_PAD)*scale`) and drop SLACK; unmeasurable
     rects (jsdom) fall back to include-all.
  2. **Didn't stay selected** — the canvas wrapper (RackDeviceEditor.tsx:287) has `onClick=clearSelection`;
     the marquee's trailing click bubbled from `editor-overlay` (which, unlike group boxes, didn't
     stopPropagation) and wiped the fresh selection. Fix: `marqueeMovedRef` set in the marquee `onUp`
     (when moved), reset on each marquee pointerDown (kills stale-true when a drag releases over a glyph);
     overlay `onClick` swallows the trailing click when the flag is set. Plain clicks still bubble → deselect.
  Tests added to EditorCanvas.test.tsx (glyph-boundary select; trailing-click-doesn't-bubble; plain-click-
  does-bubble; blank-click-still-deselects-after-marquee-over-glyph). NO spec doc.

## Slice 3f — everything done this session (all uncommitted work is committed on the branch)
UI/layout polish (mostly `RackDeviceEditor.tsx` / `EditorCanvas.tsx`):
- Aligned editor to the approved mockup (`editor-window-restored.html`): modal `max-w-[1000px]`,
  Port Types 5×2 grid, unified settings box (group left + dashed port panel right).
- Screw holes: 4 CORNER holes only (`screwHoles` no longer per-U), pinned a constant `SCREW_EDGE_INSET_PX=18`
  from the outer edge regardless of width.
- Width capped at `MAX_BODY_WIDTH_IN=17.5` (domain `isValidWidthIn`, frameDims clamp, input `max` + ±0.1 steppers).
- Device fills canvas width (CANVAS_PAD split X=0/Y=16); scale off a CONSTANT ref width so toggling Rack
  Mounted doesn't move the device (stays centered, no vertical shift). Modal top-anchored (`items-start py-[6vh]`)
  so it grows DOWN, not from center.
- Custom dropdowns: `BrandPicker.tsx` (add/delete brands in-menu; "Generic" default protected via `PROTECTED_BRAND_NAME`)
  and generic `Select.tsx` (Device type + Rack units). Brand delete stack: `deleteBrand` repo + `deleteBrandAction`.
  Device type list puts "Other" last.
- Palette: Elements = Text/Icon/Shapes/Lines (2×2, inert, 18px icons matching Port Types). Snap-to-grid ICON
  toggle (grey off / blue on, functional state only) + Rotate icon in a column between Elements and the
  Front/Back + Rack Mounted toggles; row `justify-between` for even spacing; toggles trimmed to `h-9`;
  Rack Mounted got a sliding white knob; Front/Back got a sliding black indicator.
- Selection controls (chevrons + spacing handle) only show on hover of the group box (Tailwind `group`/`group-hover`,
  `opacity-0`+`pointer-events-none`); chevrons use SVG glyphs centered; cursors ew/ns/nwse-resize.
- Blue selection box CLAMPED to the device BODY (never touches ears) via a separate `selection-box` div +
  clamped chevron/handle positions; move-drag clamps liveX. **Placement reserves `SEL_PAD`** (moved to
  portGroupOps, imported by EditorCanvas) so the box keeps full padding — single-col ports stay CENTERED,
  ports never touch the edge (findFreePosition + maxSpacing now inset by SEL_PAD).
- Ports+labels move WITH the box during a move (pure Faceplate `movePreview` hint, like `highlight`).
- Spacing handle FOLLOWS the cursor: col spacing ÷(cols-1), row spacing ×2/(rows-1) (centered growth).
- `no-select-ui` class (globals.css) disables text selection in the editor except inputs.

Model/behavior (the two original 3f items — NOW DONE):
- Override propagation + index remap: `growOverrides`/`shrinkOverrides` in portGroupOps remap `portOverrides`
  (row-major `row*cols+col`) on add/remove col/row, and NEW ports inherit orientation (flip+rotation) + label
  of the adjacent col/row (NOT name). Port rotation (`portOverrides[i].rotation`, 180° per click via the Rotate
  button) added + rendered by Faceplate.
- Per-port TYPE replace: `setPortMedia` (`portOverrides[i].media` + default connectorType). Select a port then
  click a palette type, OR drag a type onto a port (blue hover highlight via Faceplate `highlight`, hit-test
  `portAt` in EditorCanvas). PortSettings shows a "Connector (Type)" picker when a port's type is overridden.
- 3+ row groups: all labels default to BOTTOM + `addRow` seeds `LABEL_H` row spacing so labels don't overlap
  (2-row keeps top/bottom split).

Spec/plan for 3f: `docs/superpowers/{specs,plans}/2026-07-05-...-slice-3f-override-propagation-and-per-port-type*`.

## Next steps (in order)
1. Slice 3f is done — do a whole-branch review, then open the PR stack: push + PR 3d (base 3c), 3e (base 3d),
   3f (base 3e). Then merge bottom-up
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
