# Text, Shapes & Lines elements — design

**Status:** approved (2026-07-12)
**Goal:** Build out the three placeholder palette chips (Text, Shapes, Lines) in the rack-device
faceplate editor into working element types, alongside the existing Icon element.

## Context

The editor already has a rich, mostly **id-generic** element system for Icons:

- `src/domain/faceplate.ts` — `FaceElement = TextElement | IconElement` (a `TextElement` interface
  already exists but is unused/unwired), `Face.elements: FaceElement[]`.
- `src/features/device-library/editor/elementOps.ts` — `addIconElement`, and **kind-agnostic**
  `moveElement` / `resizeElement` / `deleteElement` / `duplicateElements` / `resolveElementsDrag` /
  `placeElements` / `resizeElements`, plus icon-only `setElementIcon(s)` / `setElementsColor` /
  `setElementsOpacity` and `resolveIconResize/Drop/GroupResize`.
- `src/features/device-library/faceplate/Faceplate.tsx` — maps `face.elements`, rendering only
  `kind==="icon"` via `FaceIcon`.
- `FaceIcon` emits a transparent `data-testid="icon-hit-<id>"` target; `EditorCanvas` marquee hits
  `[data-testid^="icon-hit-"]`, and selection/move/resize run off `selectedElementIds` + an internal
  `elDrag` state using box rects (`iconRect`). Drop routing in `EditorCanvas.onDrop` reads a
  `text/plain` payload: `element:icon` → `onDropIcon` (opens icon picker); a media value → new group.
- `RackDeviceEditor` branches the settings panel by selection type
  (`selectedIcons.length ? <IconSettings/> : multiGroup ? … : selectedGroup ? … : placeholder`).

Because move/resize/marquee/duplicate/drag are already id-based, **Text and Shapes are mostly
wiring** into the box model. **Lines are the real new work** (two endpoints, not a box).

## Decisions (locked)

- **Lines** = true 2-point lines with two draggable endpoint handles, plus color + thickness.
- **Text editing** happens in the settings panel (a content field), not inline double-click.
- **Shapes** = rectangle + ellipse only, to start.

## Domain model (`src/domain/faceplate.ts`)

- `TextElement` — keep; add `color?: string` and `fontSize: number`; **remove the `highlighted`
  field** (set only by `toTextElement`, read nowhere; selection already tracks highlight — update
  that one call site). Fields: `id, kind:"text", gridX, gridY, w, h, content,
  alignment:"left"|"center"|"right", fontSize, color?`.

  > **Latent gap this closes:** the Device Wizard's `layoutDetectedFace.toTextElement` already
  > produces `TextElement`s from detected labels, but `Faceplate` only renders `kind==="icon"`, so
  > those labels are currently **invisible**. Rendering Text makes wizard-detected labels appear —
  > add a default `fontSize` in `toTextElement` too.
- `ShapeElement` — new: `id, kind:"shape", shape:"rect"|"ellipse", gridX, gridY, w, h,
  fill?:string, stroke?:string, strokeWidth?:number`.
- `LineElement` — new: `id, kind:"line", x1, y1, x2, y2, stroke:string, strokeWidth:number`
  (device coordinates for both endpoints).
- `FaceElement = TextElement | IconElement | ShapeElement | LineElement`.

Box elements (text, icon, shape) share `{ gridX, gridY, w, h }`; lines are the exception.

## Ops (`elementOps.ts`)

- Creators: `addTextElement(face, {gridX,gridY})`, `addShapeElement(face, shape, {gridX,gridY})`,
  `addLineElement(face, {gridX,gridY})` — each with sensible defaults (text default "Text" content,
  shape default rect, line a short horizontal segment centred on the drop point).
- Box elements reuse the existing generic `moveElement` / `resizeElement` / `resolveElementsDrag` /
  `resizeElements` / `deleteElement` / `duplicateElements` / `placeElements` **unchanged**.
- Lines: `translateLine(face, id, dx, dy)` (both endpoints) and
  `moveLineEndpoint(face, id, which:"a"|"b", pos)`; line-aware branches added to
  `duplicateElements` and the move path so a selected line moves/duplicates correctly.
- Replace the per-property icon setters with a generic `updateElement(face, id, patch)` /
  `updateElements(face, ids, patch)` that shallow-merges a partial into matching elements; keep
  thin wrappers where call sites read clearly (e.g. `setElementsColor`). Color now applies to
  text/shape/line/icon.
- New constants: `TEXT_DEFAULT_SIZE`, `SHAPE_DEFAULT_SIZE`, `LINE_DEFAULT_LEN`, `LINE_MIN_LEN`,
  endpoint hit radius.

## Rendering (`src/features/device-library/faceplate/`)

- `FaceText` — SVG `<text>` (or `<foreignObject>` for wrapping) honouring `alignment`, `fontSize`,
  `color` (defaults to faceplate ink). Emits `data-testid="text-hit-<id>"` covering its box.
- `FaceShape` — `<rect>` or `<ellipse>` with `fill`/`stroke`/`strokeWidth`. Emits
  `data-testid="shape-hit-<id>"`.
- `FaceLine` — `<line>` with `stroke`/`strokeWidth`, plus a wider transparent `<line>` as the
  `data-testid="line-hit-<id>"` hit target (so thin lines are still clickable).
- Wire all three into `Faceplate`'s `face.elements.map(...)` alongside `FaceIcon`.
- Update the marquee hit query in `EditorCanvas` from `icon-hit-` to match all element hit targets
  (`[data-testid*="-hit-"]` scoped to elements, or an explicit list).

## Editor wiring (`EditorCanvas`, `RackDeviceEditor`)

- **Palette chips**: Text / Shapes / Lines become `draggable` like Icon (drag ghost via the existing
  `paletteDrag` clone). New payloads: `element:text`, `element:shape`, `element:line`.
- **Drop**: `EditorCanvas.onDrop` places directly (no picker) — `element:text` → `onCreateText(pos)`,
  `element:shape` → `onCreateShape(pos)` (defaults rect), `element:line` → `onCreateLine(pos)`. Show
  a drop preview like the icon one.
- **Selection/move/resize**: text + shape reuse the existing box selection, resize handles, and
  multi-move. **Lines** add: a thin selection affordance and **two endpoint handles** in the overlay;
  dragging a handle calls `moveLineEndpoint`, dragging the line body translates it. Endpoints snap to
  grid when snap-to-grid is on.
- **Settings panels** (new components, branched by selection type in `RackDeviceEditor`):
  - `TextSettings` — content (textarea), alignment (L/C/R), font size, color.
  - `ShapeSettings` — shape (rect/ellipse), fill, stroke, stroke width.
  - `LineSettings` — color, thickness.
  - Mixed multi-select (different kinds) → a shared minimal panel (color + delete).

## Data flow

Palette drag → drop payload → `onCreate{Text,Shape,Line}` → `elementOps` add → `setActiveFace` →
`Faceplate` re-render. Selection lives in `selectedElementIds` (unchanged). Edits from the settings
panels call `updateElements` / `moveLineEndpoint` → `setActiveFace`. All persisted via the existing
face save path; no schema/migration change (elements already serialize in `frontFace`/`backFace`).

## Error handling / edge cases

- Clamp box elements to device bounds on drop/move/resize (reuse the icon clamp helpers); clamp line
  endpoints to bounds.
- Enforce `LINE_MIN_LEN` so a line can't collapse to a point.
- Empty text content renders nothing but keeps a selectable box so it isn't lost.
- Deleting via the Delete key + batch delete already works (id-generic).

## Testing

- `elementOps` pure tests (TDD): add each kind; move/resize box elements; `moveLineEndpoint` +
  `translateLine`; `updateElements` across kinds; duplicate (box + line); bounds clamping; min-length.
- Faceplate render tests: each kind renders its shape + a `*-hit-<id>` target.
- Settings-panel component tests: `TextSettings` / `ShapeSettings` / `LineSettings` fire the right
  callbacks.
- Editor integration (jsdom where feasible; browser walkthrough for drag/endpoint drag).

## Phasing (one spec, staged build)

1. **Domain + ops + generic `updateElement`** (foundation; box reuse verified).
2. **Text** end-to-end (render, palette drop, TextSettings).
3. **Shapes** end-to-end (render, palette drop, ShapeSettings).
4. **Lines** end-to-end (render, palette drop, endpoint handles, LineSettings).

Each phase leaves the suite green and is browser-verifiable before the next.

## Out of scope (YAGNI)

Rotation of text/shapes; more shapes (triangle, rounded-rect); multi-segment/elbow lines; arrowheads;
rich text; inline text editing.
