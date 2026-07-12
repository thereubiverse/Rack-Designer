# Text, Shapes & Lines elements — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the placeholder Text / Shapes / Lines palette chips into working faceplate element types alongside Icon.

**Architecture:** Text and Shapes are box elements (`gridX,gridY,w,h`) that reuse the existing id-generic element ops and the EditorCanvas box overlay (currently icon-only — generalized to all box kinds). Lines are 2-point elements with their own ops, render component, and an endpoint-handle overlay. Pure ops in `elementOps.ts` (TDD); render components in `faceplate/`; settings panels in `editor/`.

**Tech Stack:** Next.js 16, React 18, TypeScript strict, Tailwind, Vitest + @testing-library/react. SVG faceplate.

## Global Constraints

- Test runner: `./node_modules/.bin/vitest run <path>` (cwd = repo root; `cd` first — Bash cwd resets between calls). Typecheck: `./node_modules/.bin/tsc --noEmit`.
- Pure ops are `Face → Face`, no React/I/O (mirror `portGroupOps`/`elementOps`).
- Device coordinates are body px (`gridX/gridY` = top-left; lines use absolute `x1,y1,x2,y2`).
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- No schema/migration: elements already serialize inside `frontFace`/`backFace`.
- Branch: `elements-text-shapes-lines` (already created).

---

## Task 1: Domain types

**Files:**
- Modify: `src/domain/faceplate.ts:44-68`
- Modify: `src/features/device-library/ai/layoutDetectedFace.ts:62-73` (toTextElement)
- Test: `src/domain/faceplate.test.ts`

**Produces:** `TextElement` (+`fontSize:number`, `color?:string`, no `highlighted`), `ShapeElement`, `LineElement`, `FaceElement` union.

- [ ] **Step 1: Update the element types.** Replace lines 44-68 of `src/domain/faceplate.ts`:

```ts
export interface TextElement {
  id: string;
  kind: "text";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  content: string;
  alignment: "left" | "center" | "right";
  fontSize: number;
  color?: string;   // defaults to faceplate ink when unset
}

export interface IconElement {
  id: string;
  kind: "icon";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  iconName: string;
  color?: string;
  opacity?: number;
}

export interface ShapeElement {
  id: string;
  kind: "shape";
  shape: "rect" | "ellipse";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  fill?: string;        // defaults to "none"
  stroke?: string;      // defaults to faceplate ink
  strokeWidth?: number; // defaults to 1.5
}

export interface LineElement {
  id: string;
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export type BoxElement = TextElement | IconElement | ShapeElement;
export type FaceElement = BoxElement | LineElement;
```

- [ ] **Step 2: Fix the one `TextElement` producer.** In `src/features/device-library/ai/layoutDetectedFace.ts`, in `toTextElement` remove `highlighted: false,` and add `fontSize: 11,` (keep everything else).

- [ ] **Step 3: Add a smoke test.** Append to `src/domain/faceplate.test.ts`:

```ts
import type { FaceElement } from "./faceplate";

it("FaceElement union accepts text, shape, and line", () => {
  const els: FaceElement[] = [
    { id: "t", kind: "text", gridX: 0, gridY: 0, w: 40, h: 24, content: "A", alignment: "center", fontSize: 11 },
    { id: "s", kind: "shape", shape: "rect", gridX: 0, gridY: 0, w: 40, h: 24 },
    { id: "l", kind: "line", x1: 0, y1: 0, x2: 40, y2: 0, stroke: "#111418", strokeWidth: 1.5 },
  ];
  expect(els).toHaveLength(3);
});
```

- [ ] **Step 4: Typecheck + test.** `cd /Users/reubensingh/development/network-doc-platform && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run src/domain/faceplate.test.ts`. Expected: PASS. (tsc surfaces any other reader of the removed `highlighted` field — there are none.)

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(elements): text/shape/line domain types"`

---

## Task 2: Element ops (create, update, line moves)

**Files:**
- Modify: `src/features/device-library/editor/elementOps.ts`
- Test: `src/features/device-library/editor/elementOps.test.ts`

**Interfaces — Produces:**
- `addTextElement(face, {gridX,gridY}): Face`
- `addShapeElement(face, shape:"rect"|"ellipse", {gridX,gridY}): Face`
- `addLineElement(face, {gridX,gridY}): Face`
- `updateElements(face, ids:string[], patch): Face` (shallow-merges patch into listed elements, any kind)
- `translateLine(face, id, dx, dy): Face`
- `moveLineEndpoint(face, id, which:"a"|"b", pos:{x,y}): Face`
- Constants `TEXT_DEFAULT_W=64, TEXT_DEFAULT_H=20, SHAPE_DEFAULT_SIZE=40, LINE_DEFAULT_LEN=60, LINE_MIN_LEN=8`
- Broadened `duplicateElements` (copies any kind, incl. lines) and `setElementsColor`/`setElementsOpacity` (any kind).

**Consumes:** `Face`, element types from Task 1.

- [ ] **Step 1: Write failing tests.** Append to `src/features/device-library/editor/elementOps.test.ts` (add missing imports at top):

```ts
import {
  addTextElement, addShapeElement, addLineElement, updateElements,
  translateLine, moveLineEndpoint, LINE_MIN_LEN,
} from "./elementOps";
import { emptyFace } from "@/domain/faceplate";

it("addTextElement appends a text element at the drop point", () => {
  const f = addTextElement(emptyFace(), { gridX: 10, gridY: 20 });
  expect(f.elements[0]).toMatchObject({ kind: "text", gridX: 10, gridY: 20, content: "Text", alignment: "center" });
});

it("addShapeElement appends the requested shape", () => {
  const f = addShapeElement(emptyFace(), "ellipse", { gridX: 5, gridY: 5 });
  expect(f.elements[0]).toMatchObject({ kind: "shape", shape: "ellipse", gridX: 5, gridY: 5 });
});

it("addLineElement appends a horizontal line centred on the drop point", () => {
  const f = addLineElement(emptyFace(), { gridX: 50, gridY: 30 });
  const l = f.elements[0] as Extract<typeof f.elements[number], { kind: "line" }>;
  expect(l.kind).toBe("line");
  expect(l.y1).toBe(30); expect(l.y2).toBe(30);
  expect(l.x2 - l.x1).toBeGreaterThan(0);
});

it("updateElements shallow-merges a patch into listed elements of any kind", () => {
  const f0 = addTextElement(emptyFace(), { gridX: 0, gridY: 0 });
  const id = f0.elements[0].id;
  const f1 = updateElements(f0, [id], { content: "Hi", alignment: "left" });
  expect(f1.elements[0]).toMatchObject({ content: "Hi", alignment: "left" });
});

it("translateLine shifts both endpoints", () => {
  const f0 = addLineElement(emptyFace(), { gridX: 50, gridY: 30 });
  const id = f0.elements[0].id;
  const f1 = translateLine(f0, id, 5, -10);
  const l = f1.elements[0] as any;
  expect(l.y1).toBe(20); expect(l.y2).toBe(20);
});

it("moveLineEndpoint moves one end, never collapsing below LINE_MIN_LEN", () => {
  const f0 = addLineElement(emptyFace(), { gridX: 50, gridY: 30 }); // x1<x2, same y
  const id = f0.elements[0].id;
  const l0 = f0.elements[0] as any;
  const f1 = moveLineEndpoint(f0, id, "b", { x: l0.x1 + 2, y: l0.y1 }); // try to collapse b onto a
  const l1 = f1.elements[0] as any;
  expect(Math.hypot(l1.x2 - l1.x1, l1.y2 - l1.y1)).toBeGreaterThanOrEqual(LINE_MIN_LEN - 0.001);
});
```

- [ ] **Step 2: Run — expect FAIL** (`… not exported`). `cd … && ./node_modules/.bin/vitest run src/features/device-library/editor/elementOps.test.ts`

- [ ] **Step 3: Implement.** In `elementOps.ts`: (a) import the new types `import type { Face, IconElement, TextElement, ShapeElement, LineElement, FaceElement } from "@/domain/faceplate";`. (b) Add constants + functions:

```ts
export const TEXT_DEFAULT_W = 64;
export const TEXT_DEFAULT_H = 20;
export const SHAPE_DEFAULT_SIZE = 40;
export const LINE_DEFAULT_LEN = 60;
export const LINE_MIN_LEN = 8;

export function addTextElement(face: Face, { gridX, gridY }: { gridX: number; gridY: number }): Face {
  const el: TextElement = { id: crypto.randomUUID(), kind: "text", gridX, gridY, w: TEXT_DEFAULT_W, h: TEXT_DEFAULT_H, content: "Text", alignment: "center", fontSize: 11 };
  return { ...face, elements: [...face.elements, el] };
}

export function addShapeElement(face: Face, shape: "rect" | "ellipse", { gridX, gridY }: { gridX: number; gridY: number }): Face {
  const el: ShapeElement = { id: crypto.randomUUID(), kind: "shape", shape, gridX, gridY, w: SHAPE_DEFAULT_SIZE, h: SHAPE_DEFAULT_SIZE };
  return { ...face, elements: [...face.elements, el] };
}

export function addLineElement(face: Face, { gridX, gridY }: { gridX: number; gridY: number }): Face {
  const half = LINE_DEFAULT_LEN / 2;
  const el: LineElement = { id: crypto.randomUUID(), kind: "line", x1: gridX - half, y1: gridY, x2: gridX + half, y2: gridY, stroke: "#111418", strokeWidth: 1.5 };
  return { ...face, elements: [...face.elements, el] };
}

/** Shallow-merge a partial into every listed element (any kind). */
export function updateElements(face: Face, ids: string[], patch: Partial<FaceElement>): Face {
  const set = new Set(ids);
  return { ...face, elements: face.elements.map((e) => (set.has(e.id) ? { ...e, ...patch } as FaceElement : e)) };
}

export function translateLine(face: Face, id: string, dx: number, dy: number): Face {
  return { ...face, elements: face.elements.map((e) => (e.id === id && e.kind === "line" ? { ...e, x1: e.x1 + dx, y1: e.y1 + dy, x2: e.x2 + dx, y2: e.y2 + dy } : e)) };
}

/** Move one endpoint ("a" = x1/y1, "b" = x2/y2), clamped so the line keeps at least LINE_MIN_LEN. */
export function moveLineEndpoint(face: Face, id: string, which: "a" | "b", pos: { x: number; y: number }): Face {
  return {
    ...face,
    elements: face.elements.map((e) => {
      if (e.id !== id || e.kind !== "line") return e;
      const fixed = which === "a" ? { x: e.x2, y: e.y2 } : { x: e.x1, y: e.y1 };
      let { x, y } = pos;
      const len = Math.hypot(x - fixed.x, y - fixed.y);
      if (len < LINE_MIN_LEN) {
        const ux = len === 0 ? 1 : (x - fixed.x) / len;
        const uy = len === 0 ? 0 : (y - fixed.y) / len;
        x = fixed.x + ux * LINE_MIN_LEN;
        y = fixed.y + uy * LINE_MIN_LEN;
      }
      return which === "a" ? { ...e, x1: x, y1: y } : { ...e, x2: x, y2: y };
    }),
  };
}
```

(c) Broaden the batch helpers so non-icon kinds are copied/recoloured. In `duplicateElements`, change `if (!set.has(e.id) || e.kind !== "icon") continue;` → `if (!set.has(e.id)) continue;` and type `copies`/param as `FaceElement[]`. In `setElementsColor`, change the guard `set.has(e.id) && e.kind === "icon"` → `set.has(e.id) && "color" in e ? { ...e, color } : e` written as: `face.elements.map((e) => (set.has(e.id) && (e.kind === "icon" || e.kind === "text" || e.kind === "shape") ? { ...e, color } : e))`. Leave `setElementsOpacity` icon-only (only icons have opacity). Leave `setElementIcon(s)` icon-only.

- [ ] **Step 4: Run — expect PASS** (new tests + the existing icon tests still green). `cd … && ./node_modules/.bin/vitest run src/features/device-library/editor/elementOps.test.ts`

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(elements): create + update + line ops"`

---

## Task 3: FaceText render + Faceplate wiring

**Files:**
- Create: `src/features/device-library/faceplate/FaceText.tsx`
- Modify: `src/features/device-library/faceplate/Faceplate.tsx:145` (element map)
- Test: `src/features/device-library/faceplate/FaceText.test.tsx`

**Consumes:** `TextElement`.

- [ ] **Step 1: Failing test.** `src/features/device-library/faceplate/FaceText.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FaceText } from "./FaceText";

const el = { id: "t1", kind: "text" as const, gridX: 10, gridY: 20, w: 60, h: 20, content: "Uplink", alignment: "center" as const, fontSize: 11 };

it("renders the text content", () => {
  const { getByTestId } = render(<svg><FaceText el={el} /></svg>);
  expect(getByTestId("face-text").textContent).toBe("Uplink");
});
```

- [ ] **Step 2: Run — expect FAIL.** `cd … && ./node_modules/.bin/vitest run src/features/device-library/faceplate/FaceText.test.tsx`

- [ ] **Step 3: Implement `FaceText.tsx`:**

```tsx
import type { TextElement } from "@/domain/faceplate";

/** Renders a placed text element inside the faceplate SVG. Anchored by `alignment`; vertically
 *  centred in its box. Colour defaults to the faceplate label ink. */
export function FaceText({ el }: { el: TextElement }) {
  const anchor = el.alignment === "left" ? "start" : el.alignment === "right" ? "end" : "middle";
  const x = el.alignment === "left" ? el.gridX : el.alignment === "right" ? el.gridX + el.w : el.gridX + el.w / 2;
  return (
    <text
      data-testid="face-text"
      x={x}
      y={el.gridY + el.h / 2}
      textAnchor={anchor}
      dominantBaseline="central"
      fontSize={el.fontSize}
      fontFamily="Inter, system-ui, sans-serif"
      fill={el.color ?? "#4b5563"}
    >
      {el.content}
    </text>
  );
}
```

- [ ] **Step 4: Wire into Faceplate.** In `src/features/device-library/faceplate/Faceplate.tsx`, add `import { FaceText } from "./FaceText";` and change the element map (line ~145) to:

```tsx
{face.elements.map((el) =>
  el.kind === "icon" ? <FaceIcon key={el.id} el={el} />
  : el.kind === "text" ? <FaceText key={el.id} el={el} />
  : null,
)}
```

- [ ] **Step 5: Run — expect PASS.** `cd … && ./node_modules/.bin/vitest run src/features/device-library/faceplate`

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(elements): render text on the faceplate"`

---

## Task 4: TextSettings panel

**Files:**
- Create: `src/features/device-library/editor/TextSettings.tsx`
- Test: `src/features/device-library/editor/TextSettings.test.tsx`

**Produces:** `<TextSettings count content alignment fontSize color onContent onAlignment onFontSize onColor onDelete />`.

- [ ] **Step 1: Failing test.** `TextSettings.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextSettings } from "./TextSettings";

it("edits content and alignment", async () => {
  const user = userEvent.setup();
  const onContent = vi.fn(); const onAlignment = vi.fn();
  render(<TextSettings count={1} content="Hi" alignment="center" fontSize={11} color={undefined}
    onContent={onContent} onAlignment={onAlignment} onFontSize={vi.fn()} onColor={vi.fn()} onDelete={vi.fn()} />);
  await user.type(screen.getByTestId("text-content"), "!");
  expect(onContent).toHaveBeenCalled();
  await user.click(screen.getByTestId("text-align-left"));
  expect(onAlignment).toHaveBeenCalledWith("left");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `TextSettings.tsx`** (mirror the layout/classes of `IconSettings.tsx`):

```tsx
"use client";

export function TextSettings({
  count, content, alignment, fontSize, color,
  onContent, onAlignment, onFontSize, onColor, onDelete,
}: {
  count: number;
  content: string;
  alignment: "left" | "center" | "right";
  fontSize: number;
  color?: string;
  onContent: (v: string) => void;
  onAlignment: (v: "left" | "center" | "right") => void;
  onFontSize: (v: number) => void;
  onColor: (v: string) => void;
  onDelete: () => void;
}) {
  const aligns: ("left" | "center" | "right")[] = ["left", "center", "right"];
  return (
    <div data-testid="text-settings" className="flex w-full flex-col text-left">
      <div className="mb-2 text-xs font-bold text-neutral-800">{count > 1 ? `${count} text elements` : "Text"}</div>
      {count === 1 && (
        <label className="flex flex-col text-[11px] font-semibold text-neutral-600">Content
          <input data-testid="text-content" value={content} onChange={(e) => onContent(e.target.value)}
            className="mt-1 h-9 rounded-lg border border-neutral-200 px-2 text-sm font-normal" />
        </label>
      )}
      <div className="mt-2 flex gap-2">
        <div className="flex flex-1 rounded-lg border border-neutral-200 p-0.5">
          {aligns.map((a) => (
            <button key={a} type="button" data-testid={`text-align-${a}`} onClick={() => onAlignment(a)}
              className={`flex-1 rounded-md py-1 text-xs font-semibold capitalize ${alignment === a ? "bg-neutral-900 text-white" : "text-neutral-500"}`}>{a}</button>
          ))}
        </div>
      </div>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Size
        <input data-testid="text-size" type="number" min={6} max={48} value={fontSize}
          onChange={(e) => onFontSize(Number(e.target.value))}
          className="ml-2 h-8 w-16 rounded-lg border border-neutral-200 px-2 text-sm font-normal [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
      </label>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Colour
        <input data-testid="text-color" type="color" value={color ?? "#4b5563"} onChange={(e) => onColor(e.target.value)}
          className="ml-2 h-8 w-10 rounded border border-neutral-200" />
      </label>
      <button type="button" data-testid="text-delete" onClick={onDelete} className="mt-3 text-left text-xs text-red-600">🗑 Delete</button>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS.** `cd … && ./node_modules/.bin/vitest run src/features/device-library/editor/TextSettings.test.tsx`

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(elements): TextSettings panel"`

---

## Task 5: Wire Text into the editor (palette chip, drop, overlay, settings)

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx` (drop routing ~L561-572; box overlay filter ~L762-763; marquee hit query ~L232)
- Modify: `src/features/device-library/editor/RackDeviceEditor.tsx` (element:text chip ~L400-436; onCreateText prop; settings branch ~L558+)

**Consumes:** `addTextElement`, `updateElements`, `deleteElement`, `TextSettings`, `FaceText`.

- [ ] **Step 1: Generalise the box overlay to text.** In `EditorCanvas.tsx`, define once near the element map: `const isBoxEl = (e: FaceElement) => e.kind === "icon" || e.kind === "text" || e.kind === "shape";` (import `FaceElement`). Replace `if (el.kind !== "icon") return null;` (L763) with `if (!isBoxEl(el)) return null;`, and in the two `face.elements.filter((x) => x.kind === "icon" && …)` lines (L781, L808-809) replace `x.kind === "icon"` with `isBoxEl(x)`. Rename the hidden marquee hit `data-testid={`icon-hit-${el.id}`}` → `data-testid={`el-hit-${el.id}`}` (L794). Update the marquee query (L232) `'[data-testid^="icon-hit-"]', "icon-hit-"` → `'[data-testid^="el-hit-"]', "el-hit-"`. (grep the test dir for `icon-hit-`/`icon-el-` first; update any that assert the old name.)

- [ ] **Step 2: Route the text drop.** In `EditorCanvas.tsx` add prop `onCreateText?: (pos: Pos) => void;` to the props type. In `onDrop` (after the `element:icon` branch, ~L567) add: `if (payload === "element:text") { props.onCreateText?.(dropPos(e)); return; }`. In the dragover preview (`props.paletteDragIcon` branch ~L540) also show the box preview when the text chip drags — add a sibling prop `paletteDragElement?: "text" | "shape" | null` and reuse the `iconDropAt` preview for it (set `setIconDropAt(dropPos(e))` when `props.paletteDragElement`).

- [ ] **Step 3: Make the Text chip draggable.** In `RackDeviceEditor.tsx`, the Elements palette has a disabled `data-testid="element-text"` span (~L401). Replace it with a draggable span mirroring `element-icon` (~L405-427): `draggable`, `onDragStart` sets `e.dataTransfer.setData("text/plain", "element:text")`, `effectAllowed="move"`, transparent drag image, and `setPaletteDrag({ id: "element:text", content: <>…Text</>, x, y, grabDX, grabDY, width, height })`; `onDragEnd={() => setPaletteDrag(null)}`; remove the `text-neutral-400` disabled styling. Pass `paletteDragElement={paletteDrag?.id === "element:text" ? "text" : paletteDrag?.id === "element:shape" ? "shape" : null}` to `<EditorCanvas>`.

- [ ] **Step 4: Handle the drop in the parent.** In `RackDeviceEditor.tsx` add to `<EditorCanvas>`: `onCreateText={(pos) => { const f = addTextElement(activeFace, resolveIconDrop(pos.x, pos.y, TEXT_DEFAULT_W, bounds)); setActiveFace(f); const id = f.elements[f.elements.length - 1].id; setSelectedElementIds([id]); setSelectedGroupIds([]); setSelectedPortIndices([]); }}`. Import `addTextElement, TEXT_DEFAULT_W`.

- [ ] **Step 5: Add the settings branch.** In the selection-settings conditional (where `selectedIcons.length > 0 ? <IconSettings/> : …`), compute `const selectedTexts = activeFace.elements.filter((e) => e.kind === "text" && selectedElementIds.includes(e.id));` and add a branch **before** the group branches:

```tsx
selectedTexts.length > 0 ? (
  <div className="mt-4 rounded-xl border border-neutral-200 p-4">
    <TextSettings
      count={selectedTexts.length}
      content={selectedTexts[0].content}
      alignment={selectedTexts[0].alignment}
      fontSize={selectedTexts[0].fontSize}
      color={selectedTexts[0].color}
      onContent={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { content: v }))}
      onAlignment={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { alignment: v }))}
      onFontSize={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { fontSize: v }))}
      onColor={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { color: v }))}
      onDelete={() => { setActiveFace((p) => selectedElementIds.reduce((f, id) => deleteElement(f, id), p)); setSelectedElementIds([]); }}
    />
  </div>
) :
```

Import `TextSettings`, `updateElements`. (`deleteElement` already imported.)

- [ ] **Step 6: Typecheck + tests.** `cd … && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run src/features/device-library`. Expected: PASS (fix any renamed-testid assertions).

- [ ] **Step 7: Browser-verify.** Start preview `rack-designer-dev` (port 3100); open a device in edit; drag the **Text** chip onto the faceplate → a "Text" element appears and is selected; the TextSettings panel edits content/align/size/colour live; drag to move, corner-handle to resize, Delete removes it. Screenshot.

- [ ] **Step 8: Commit.** `git add -A && git commit -m "feat(elements): text element end-to-end"`

---

## Task 6: FaceShape render + Faceplate wiring

**Files:**
- Create: `src/features/device-library/faceplate/FaceShape.tsx`
- Modify: `src/features/device-library/faceplate/Faceplate.tsx` (element map)
- Test: `src/features/device-library/faceplate/FaceShape.test.tsx`

- [ ] **Step 1: Failing test.** `FaceShape.test.tsx`:

```tsx
import { it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FaceShape } from "./FaceShape";

it("renders a rect for shape=rect and an ellipse for shape=ellipse", () => {
  const base = { id: "s", kind: "shape" as const, gridX: 4, gridY: 6, w: 40, h: 20 };
  const r = render(<svg><FaceShape el={{ ...base, shape: "rect" }} /></svg>);
  expect(r.container.querySelector('[data-testid="face-shape"]')?.tagName.toLowerCase()).toBe("rect");
  const e = render(<svg><FaceShape el={{ ...base, shape: "ellipse" }} /></svg>);
  expect(e.container.querySelector('[data-testid="face-shape"]')?.tagName.toLowerCase()).toBe("ellipse");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `FaceShape.tsx`:**

```tsx
import type { ShapeElement } from "@/domain/faceplate";

export function FaceShape({ el }: { el: ShapeElement }) {
  const fill = el.fill ?? "none";
  const stroke = el.stroke ?? "#111418";
  const strokeWidth = el.strokeWidth ?? 1.5;
  if (el.shape === "ellipse") {
    return (
      <ellipse data-testid="face-shape" cx={el.gridX + el.w / 2} cy={el.gridY + el.h / 2}
        rx={el.w / 2} ry={el.h / 2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
    );
  }
  return (
    <rect data-testid="face-shape" x={el.gridX} y={el.gridY} width={el.w} height={el.h}
      rx={2} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
  );
}
```

- [ ] **Step 4: Wire into Faceplate** — extend the element map chain: `: el.kind === "shape" ? <FaceShape key={el.id} el={el} />`. Add the import.

- [ ] **Step 5: Run — expect PASS.** `cd … && ./node_modules/.bin/vitest run src/features/device-library/faceplate`

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(elements): render shapes on the faceplate"`

---

## Task 7: ShapeSettings panel

**Files:**
- Create: `src/features/device-library/editor/ShapeSettings.tsx`
- Test: `src/features/device-library/editor/ShapeSettings.test.tsx`

- [ ] **Step 1: Failing test.** `ShapeSettings.test.tsx`:

```tsx
import { it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShapeSettings } from "./ShapeSettings";

it("switches shape and toggles fill", async () => {
  const user = userEvent.setup();
  const onShape = vi.fn();
  render(<ShapeSettings count={1} shape="rect" fill={undefined} stroke={undefined} strokeWidth={1.5}
    onShape={onShape} onFill={vi.fn()} onStroke={vi.fn()} onStrokeWidth={vi.fn()} onDelete={vi.fn()} />);
  await user.click(screen.getByTestId("shape-ellipse"));
  expect(onShape).toHaveBeenCalledWith("ellipse");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `ShapeSettings.tsx`** (mirror TextSettings styling):

```tsx
"use client";

export function ShapeSettings({
  count, shape, fill, stroke, strokeWidth,
  onShape, onFill, onStroke, onStrokeWidth, onDelete,
}: {
  count: number;
  shape: "rect" | "ellipse";
  fill?: string;
  stroke?: string;
  strokeWidth: number;
  onShape: (s: "rect" | "ellipse") => void;
  onFill: (v: string | undefined) => void;
  onStroke: (v: string) => void;
  onStrokeWidth: (v: number) => void;
  onDelete: () => void;
}) {
  return (
    <div data-testid="shape-settings" className="flex w-full flex-col text-left">
      <div className="mb-2 text-xs font-bold text-neutral-800">{count > 1 ? `${count} shapes` : "Shape"}</div>
      <div className="flex rounded-lg border border-neutral-200 p-0.5">
        {(["rect", "ellipse"] as const).map((s) => (
          <button key={s} type="button" data-testid={`shape-${s}`} onClick={() => onShape(s)}
            className={`flex-1 rounded-md py-1 text-xs font-semibold capitalize ${shape === s ? "bg-neutral-900 text-white" : "text-neutral-500"}`}>{s}</button>
        ))}
      </div>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">
        <span className="flex items-center gap-2"><input data-testid="shape-fill-on" type="checkbox" checked={fill != null && fill !== "none"} onChange={(e) => onFill(e.target.checked ? "#e5e7eb" : undefined)} />Fill</span>
        <input data-testid="shape-fill" type="color" value={fill && fill !== "none" ? fill : "#e5e7eb"} onChange={(e) => onFill(e.target.value)} className="ml-2 h-8 w-10 rounded border border-neutral-200" />
      </label>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Stroke
        <input data-testid="shape-stroke" type="color" value={stroke ?? "#111418"} onChange={(e) => onStroke(e.target.value)} className="ml-2 h-8 w-10 rounded border border-neutral-200" />
      </label>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Width
        <input data-testid="shape-width" type="number" min={0.5} max={8} step={0.5} value={strokeWidth} onChange={(e) => onStrokeWidth(Number(e.target.value))} className="ml-2 h-8 w-16 rounded-lg border border-neutral-200 px-2 text-sm font-normal [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
      </label>
      <button type="button" data-testid="shape-delete" onClick={onDelete} className="mt-3 text-left text-xs text-red-600">🗑 Delete</button>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS.** `cd … && ./node_modules/.bin/vitest run src/features/device-library/editor/ShapeSettings.test.tsx`

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(elements): ShapeSettings panel"`

---

## Task 8: Wire Shapes into the editor

**Files:**
- Modify: `EditorCanvas.tsx` (drop routing), `RackDeviceEditor.tsx` (chip, onCreateShape, settings branch)

**Consumes:** `addShapeElement`, `updateElements`, `deleteElement`, `ShapeSettings`. Box overlay + marquee already generalised in Task 5.

- [ ] **Step 1: Route the shape drop.** In `EditorCanvas.onDrop` add `if (payload === "element:shape") { props.onCreateShape?.(dropPos(e)); return; }` and prop `onCreateShape?: (pos: Pos) => void;`. (Preview already handled via `paletteDragElement === "shape"` from Task 5.)

- [ ] **Step 2: Make the Shapes chip draggable** in `RackDeviceEditor.tsx` — replace the disabled `element-shapes` span with a draggable one (payload `element:shape`, `setPaletteDrag({ id: "element:shape", … })`), mirroring the Text chip.

- [ ] **Step 3: Handle the drop** — add to `<EditorCanvas>`: `onCreateShape={(pos) => { const f = addShapeElement(activeFace, "rect", resolveIconDrop(pos.x, pos.y, SHAPE_DEFAULT_SIZE, bounds)); setActiveFace(f); const id = f.elements[f.elements.length - 1].id; setSelectedElementIds([id]); setSelectedGroupIds([]); setSelectedPortIndices([]); }}`. Import `addShapeElement, SHAPE_DEFAULT_SIZE`.

- [ ] **Step 4: Settings branch** — compute `const selectedShapes = activeFace.elements.filter((e) => e.kind === "shape" && selectedElementIds.includes(e.id));` and add a branch after the text branch:

```tsx
selectedShapes.length > 0 ? (
  <div className="mt-4 rounded-xl border border-neutral-200 p-4">
    <ShapeSettings count={selectedShapes.length} shape={selectedShapes[0].shape}
      fill={selectedShapes[0].fill} stroke={selectedShapes[0].stroke} strokeWidth={selectedShapes[0].strokeWidth ?? 1.5}
      onShape={(s) => setActiveFace(updateElements(activeFace, selectedElementIds, { shape: s }))}
      onFill={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { fill: v }))}
      onStroke={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { stroke: v }))}
      onStrokeWidth={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { strokeWidth: v }))}
      onDelete={() => { setActiveFace((p) => selectedElementIds.reduce((f, id) => deleteElement(f, id), p)); setSelectedElementIds([]); }} />
  </div>
) :
```

Import `ShapeSettings`.

- [ ] **Step 5: Typecheck + tests.** `cd … && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run src/features/device-library`.

- [ ] **Step 6: Browser-verify** — drag Shapes chip → rectangle appears, selectable/movable/resizable; ShapeSettings switches rect↔ellipse, fill/stroke/width live. Screenshot.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(elements): shape element end-to-end"`

---

## Task 9: FaceLine render + Faceplate wiring

**Files:**
- Create: `src/features/device-library/faceplate/FaceLine.tsx`
- Modify: `Faceplate.tsx` (element map)
- Test: `src/features/device-library/faceplate/FaceLine.test.tsx`

- [ ] **Step 1: Failing test.** `FaceLine.test.tsx`:

```tsx
import { it, expect } from "vitest";
import { render } from "@testing-library/react";
import { FaceLine } from "./FaceLine";

it("renders a line at its endpoints", () => {
  const el = { id: "l", kind: "line" as const, x1: 10, y1: 5, x2: 70, y2: 5, stroke: "#111418", strokeWidth: 2 };
  const { container } = render(<svg><FaceLine el={el} /></svg>);
  const line = container.querySelector('[data-testid="face-line"]');
  expect(line?.getAttribute("x1")).toBe("10");
  expect(line?.getAttribute("x2")).toBe("70");
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `FaceLine.tsx`:**

```tsx
import type { LineElement } from "@/domain/faceplate";

export function FaceLine({ el }: { el: LineElement }) {
  return (
    <line data-testid="face-line" x1={el.x1} y1={el.y1} x2={el.x2} y2={el.y2}
      stroke={el.stroke} strokeWidth={el.strokeWidth} strokeLinecap="round" />
  );
}
```

- [ ] **Step 4: Wire into Faceplate** — extend the chain: `: el.kind === "line" ? <FaceLine key={el.id} el={el} />`. Add the import.

- [ ] **Step 5: Run — expect PASS.** `cd … && ./node_modules/.bin/vitest run src/features/device-library/faceplate`

- [ ] **Step 6: Commit.** `git add -A && git commit -m "feat(elements): render lines on the faceplate"`

---

## Task 10: LineSettings panel

**Files:**
- Create: `src/features/device-library/editor/LineSettings.tsx`
- Test: `src/features/device-library/editor/LineSettings.test.tsx`

- [ ] **Step 1: Failing test.** `LineSettings.test.tsx`:

```tsx
import { it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LineSettings } from "./LineSettings";

it("changes thickness", async () => {
  const user = userEvent.setup();
  const onWidth = vi.fn();
  render(<LineSettings count={1} stroke="#111418" strokeWidth={1.5} onStroke={vi.fn()} onStrokeWidth={onWidth} onDelete={vi.fn()} />);
  await user.clear(screen.getByTestId("line-width"));
  await user.type(screen.getByTestId("line-width"), "3");
  expect(onWidth).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement `LineSettings.tsx`:**

```tsx
"use client";

export function LineSettings({
  count, stroke, strokeWidth, onStroke, onStrokeWidth, onDelete,
}: {
  count: number;
  stroke: string;
  strokeWidth: number;
  onStroke: (v: string) => void;
  onStrokeWidth: (v: number) => void;
  onDelete: () => void;
}) {
  return (
    <div data-testid="line-settings" className="flex w-full flex-col text-left">
      <div className="mb-2 text-xs font-bold text-neutral-800">{count > 1 ? `${count} lines` : "Line"}</div>
      <label className="flex items-center justify-between text-[11px] font-semibold text-neutral-600">Colour
        <input data-testid="line-color" type="color" value={stroke} onChange={(e) => onStroke(e.target.value)} className="ml-2 h-8 w-10 rounded border border-neutral-200" />
      </label>
      <label className="mt-2 flex items-center justify-between text-[11px] font-semibold text-neutral-600">Thickness
        <input data-testid="line-width" type="number" min={0.5} max={8} step={0.5} value={strokeWidth} onChange={(e) => onStrokeWidth(Number(e.target.value))} className="ml-2 h-8 w-16 rounded-lg border border-neutral-200 px-2 text-sm font-normal [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
      </label>
      <button type="button" data-testid="line-delete" onClick={onDelete} className="mt-3 text-left text-xs text-red-600">🗑 Delete</button>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS** (fix the test to the minimal two-`user`-call form). `cd … && ./node_modules/.bin/vitest run src/features/device-library/editor/LineSettings.test.tsx`

- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(elements): LineSettings panel"`

---

## Task 11: Wire Lines into the editor (endpoint handles)

**Files:**
- Modify: `EditorCanvas.tsx` (drop routing; new line overlay + endpoint drag), `RackDeviceEditor.tsx` (chip, onCreateLine, settings branch)

**Consumes:** `addLineElement`, `translateLine`, `moveLineEndpoint`, `updateElements`, `deleteElement`, `LineSettings`, `FaceLine`.

- [ ] **Step 1: Route the line drop.** In `EditorCanvas.onDrop` add `if (payload === "element:line") { props.onCreateLine?.(dropPos(e)); return; }` and prop `onCreateLine?: (pos: Pos) => void;`. Add props `onMoveLineEndpoint?: (id: string, which: "a"|"b", pos: {x:number;y:number}) => void;` and `onTranslateLine?: (id: string, dx: number, dy: number) => void;`.

- [ ] **Step 2: Line overlay + endpoint drag.** After the box-element map (~L820), add a `face.elements.map` for `el.kind === "line"` (skip in the box map — `isBoxEl` already excludes lines). For each line render, in `earX`-offset device→screen coords (`sx = earX + x*scale`… the overlay is inside the `scale(scale)` transform, so use device coords directly like the box overlay does: `left: earX + x`): a transparent thick `line-hit` div isn't a box, so render (a) a click/drag catcher spanning the segment, and (b) two endpoint handle dots when selected. Use a new drag state branch. Concretely, add to the `elDrag` union a line mode:

```tsx
type LineDrag = { kind: "line"; id: string; mode: "move" | "a" | "b"; startX: number; startY: number; ox1: number; oy1: number; ox2: number; oy2: number };
const [lineDrag, setLineDrag] = useState<LineDrag | null>(null);
```

Render per line (device coords; `earX` offsets x like the box overlay):

```tsx
{props.onSelectElement && face.elements.map((el) => {
  if (el.kind !== "line") return null;
  const sel = (props.selectedElementIds ?? []).includes(el.id);
  const mkHandle = (which: "a" | "b", x: number, y: number) => (
    <div data-testid={`line-handle-${which}-${el.id}`}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation();
        setLineDrag({ kind: "line", id: el.id, mode: which, startX: e.clientX, startY: e.clientY, ox1: el.x1, oy1: el.y1, ox2: el.x2, oy2: el.y2 }); }}
      style={{ position: "absolute", left: earX + x - 5, top: y - 5, width: 10, height: 10, borderRadius: "50%", background: "#2d5bff", border: "1.5px solid #fff", cursor: "grab", zIndex: 24 }} />
  );
  return (
    <div key={el.id} data-testid={`line-el-${el.id}`}>
      {/* invisible fat hit line for click/drag along the segment */}
      <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible", pointerEvents: "none", zIndex: 21 }}>
        <line data-testid={`el-hit-${el.id}`} x1={earX + el.x1} y1={el.y1} x2={earX + el.x2} y2={el.y2}
          stroke="transparent" strokeWidth={12} strokeLinecap="round" style={{ pointerEvents: "stroke", cursor: "move" }}
          onClick={(e) => { e.stopPropagation(); props.onSelectElement?.(el.id, (e as any).shiftKey); }}
          onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation();
            setLineDrag({ kind: "line", id: el.id, mode: "move", startX: e.clientX, startY: e.clientY, ox1: el.x1, oy1: el.y1, ox2: el.x2, oy2: el.y2 }); }} />
        {sel && <line x1={earX + el.x1} y1={el.y1} x2={earX + el.x2} y2={el.y2} stroke="#2d5bff" strokeWidth={1} pointerEvents="none" />}
      </svg>
      {sel && mkHandle("a", el.x1, el.y1)}
      {sel && mkHandle("b", el.x2, el.y2)}
    </div>
  );
})}
```

Add a pointer-move/up effect for `lineDrag` (mirror the box `elDrag` effect): convert `clientX/Y` deltas to device px via `scaleRef.current`; on `mode==="move"` call `props.onTranslateLine?.(id, dvx, dvy)` using absolute originals (recompute from `ox*`), on `"a"/"b"` call `props.onMoveLineEndpoint?.(id, mode, { x: (mode==="a"?ox1:ox2)+dvx, y: (mode==="a"?oy1:oy2)+dvy })`; snap endpoints to `GRID_PX` when `props.snapToGrid`. Clear on pointer-up.

- [ ] **Step 3: Line chip + parent wiring** in `RackDeviceEditor.tsx`: replace the disabled `element-lines` span with a draggable one (payload `element:line`). Add to `<EditorCanvas>`: `onCreateLine={(pos) => { const f = addLineElement(activeFace, pos); setActiveFace(f); const id = f.elements[f.elements.length - 1].id; setSelectedElementIds([id]); setSelectedGroupIds([]); setSelectedPortIndices([]); }}`, `onTranslateLine={(id, dx, dy) => setActiveFace((p) => translateLine(p, id, dx, dy))}`, `onMoveLineEndpoint={(id, which, pos) => setActiveFace((p) => moveLineEndpoint(p, id, which, pos))}`. Import `addLineElement, translateLine, moveLineEndpoint`.

- [ ] **Step 4: Settings branch** — `const selectedLines = activeFace.elements.filter((e) => e.kind === "line" && selectedElementIds.includes(e.id));` add after the shape branch:

```tsx
selectedLines.length > 0 ? (
  <div className="mt-4 rounded-xl border border-neutral-200 p-4">
    <LineSettings count={selectedLines.length} stroke={selectedLines[0].stroke} strokeWidth={selectedLines[0].strokeWidth}
      onStroke={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { stroke: v }))}
      onStrokeWidth={(v) => setActiveFace(updateElements(activeFace, selectedElementIds, { strokeWidth: v }))}
      onDelete={() => { setActiveFace((p) => selectedElementIds.reduce((f, id) => deleteElement(f, id), p)); setSelectedElementIds([]); }} />
  </div>
) :
```

Import `LineSettings`.

- [ ] **Step 5: Typecheck + tests.** `cd … && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run src/features/device-library`.

- [ ] **Step 6: Browser-verify** — drag Lines chip → a short horizontal line appears selected with two endpoint dots; drag an endpoint to reshape (diagonal), drag the body to move, LineSettings changes colour/thickness, Delete removes it; marquee also selects it. Screenshot.

- [ ] **Step 7: Commit.** `git add -A && git commit -m "feat(elements): line element with endpoint handles"`

---

## Self-review notes

- **Spec coverage:** domain (T1), ops incl. generic update + line moves (T2), render text/shape/line (T3/6/9), palette drop + drop-preview (T5/8/11), box overlay generalisation + marquee (T5), endpoint handles (T11), settings panels (T4/7/10 + branches T5/8/11), wizard-label render gap closed by T3. ✓
- **Mixed multi-select:** with different kinds selected, the first matching branch (text→shape→line) wins; a shared colour-only panel is deliberately deferred (single-kind editing covers the common case; note for follow-up).
- **Marquee rename:** T5 renames `icon-hit-`→`el-hit-`; grep tests for `icon-hit-`/`icon-el-` and update assertions in the same task.
- **Types:** `updateElements(face, ids, patch: Partial<FaceElement>)` used consistently across T5/8/11; `moveLineEndpoint(face,id,which,pos)` and `translateLine(face,id,dx,dy)` names match ops (T2) and canvas props (T11).
