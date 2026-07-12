# Phase 2a · Slice 3d — Rack Device Editor Refinements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the editor's vertical model to auto-center rows (tiles), recolor the selected port blue in place, add a per-port label top/bottom toggle, make chevrons click-or-drag, and make group moves horizontal-only.

**Architecture:** `layoutPortGroup` becomes device-height-aware (centers the row stack; `heightPx` optional so legacy callers are unchanged). `Faceplate` renders labels above/below per tile and recolors the highlighted port (a pure `highlight` prop). Collision simplifies to horizontal x-range (every group straddles the device center). The editor drops the overlay blue-copy, passes `highlight` to Faceplate, adds chevron-drag, and moves horizontally only.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, SVG, Pointer Events, Vitest 2 + @testing-library/react (jsdom).

## Global Constraints

- **Next.js 16 + React 19 + TypeScript 5**; path alias `@/` → `src/`.
- **Vertical position is derived (auto-centered), not stored/dragged.** `layoutPortGroup(group, heightPx?)`: when `heightPx` is given, the glyph-box stack (`height = rows*ROW_H + (rows-1)*rowSpacing`) is centered so `top = (heightPx − height)/2`; when omitted, legacy origin `group.gridY` (keeps existing tests valid). `gridX` stays free; `gridY` is retained on the type but unused vertically (no migration).
- **Collision is horizontal only** (x-range): `[gridX, gridX + width]`, `width = cols*CELL_W + (cols−1)*colSpacing`. Every group centers vertically, so any two always overlap vertically.
- **`Faceplate` stays a pure function of its inputs.** It gains a pure `highlight?: { groupId: string; portIndex: number } | null` rendering hint (recolor only, no callbacks). Phase 2b passes nothing.
- **Per-port label position:** `portOverrides[i].labelPos?: "top" | "bottom"`; default = bottom row of a multi-row group → `"bottom"`, else `"top"`. Toggle in `PortSettings`.
- **Only `rowSpacing` fine-tunes vertically;** `maxSpacing.maxRow` clamps so the centered stack + label margins fit the device height; single-row → `maxRow = 0`.
- **Chevron:** click adds one; drag adds one per `CELL_W` (right) / `ROW_H` (down) of drag distance, group anchored, clamped.
- **Move is horizontal-only:** `movePortGroup` changes `gridX` only.
- Geometry constants: `CELL_W = ROW_H = 24`, `GLYPH_W = 20`, `LABEL_H = 12` (new). Blue highlight colour `#2d5bff`.
- Tests: Vitest, one behaviour per `it`. `npm test`. Do **not** run `npm run lint` (pre-existing repo-wide failure).
- Work on branch `phase-2a-slice-3d` (already cut from `phase-2a-slice-3c`).
- TDD, DRY, YAGNI, frequent commits.

---

## File Structure

- **Modify** `src/domain/faceplate.ts` — add `labelPos?` to the `portOverrides` entry type.
- **Modify** `src/domain/faceplate-geometry.ts` (+ `.test.ts`) — `LABEL_H`; `LaidOutPort.labelPos`; `LaidOutGroup.top`; `layoutPortGroup(group, heightPx?)` centering + labelPos (Task 1).
- **Modify** `src/features/device-library/faceplate/Faceplate.tsx` (+ `.test.tsx`) — pass `heightPx`, render label per `labelPos`, in-place `highlight` recolor (Task 2).
- **Modify** `src/features/device-library/editor/portGroupOps.ts` (+ `.test.ts`) — horizontal-only collision, `maxRow` device clamp, horizontal-only `movePortGroup`, `setPortOverride` labelPos (Task 3).
- **Modify** `src/features/device-library/editor/EditorCanvas.tsx` (+ `.test.tsx`) — remove blue-copy, `highlight` passthrough, centered overlay positioning, horizontal-only move (Task 4); chevron click-drag (Task 5).
- **Modify** `src/features/device-library/editor/PortSettings.tsx` (+ `.test.tsx`) — label position toggle (Task 6).
- **Modify** `src/features/device-library/editor/RackDeviceEditor.tsx` (+ its test) — wire `highlight` + label toggle; verification (Task 7).

---

## Task 1: Geometry — centered layout, tile labelPos, top

**Files:**
- Modify: `src/domain/faceplate.ts`
- Modify: `src/domain/faceplate-geometry.ts`
- Test: `src/domain/faceplate-geometry.test.ts`

**Interfaces:**
- Produces:
  - `src/domain/faceplate.ts`: `portOverrides: Record<number, { name?: string; flipped?: boolean; labelPos?: "top" | "bottom" }>`.
  - `LABEL_H = 12`.
  - `LaidOutPort` gains `labelPos: "top" | "bottom"`; `LaidOutGroup` gains `top: number`.
  - `layoutPortGroup(group: PortGroup, heightPx?: number): LaidOutGroup` — centers vertically when `heightPx` given (else legacy `gridY`); resolves each cell's `labelPos`.

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/faceplate-geometry.test.ts`:

```ts
describe("layoutPortGroup — vertical centering & labelPos", () => {
  function g(over: Partial<PortGroup> = {}): PortGroup {
    return {
      id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
      countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
      colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
    };
  }
  it("centers a single row dead-center in the device height", () => {
    // heightPx 84 (1U), height = ROW_H 24 → top = (84-24)/2 = 30
    const laid = layoutPortGroup(g(), 84);
    expect(laid.top).toBeCloseTo(30, 5);
    expect(laid.cells[0].y).toBeCloseTo(30, 5);
  });
  it("centers a two-row group symmetric about center", () => {
    // 2 rows, rowSpacing 0 → height 48, top = (84-48)/2 = 18; row1 y = 18, row2 y = 18+24 = 42
    const laid = layoutPortGroup(g({ rows: 2, cols: 1 }), 84);
    expect(laid.cells[0].y).toBeCloseTo(18, 5);
    expect(laid.cells[1].y).toBeCloseTo(42, 5);
  });
  it("defaults labelPos: single row → top; bottom row of a multi-row group → bottom", () => {
    expect(layoutPortGroup(g(), 84).cells[0].labelPos).toBe("top");
    const two = layoutPortGroup(g({ rows: 2, cols: 1 }), 84);
    expect(two.cells[0].labelPos).toBe("top");   // row 0
    expect(two.cells[1].labelPos).toBe("bottom"); // last row
  });
  it("a per-port labelPos override wins", () => {
    const laid = layoutPortGroup(g({ portOverrides: { 0: { labelPos: "bottom" } } }), 84);
    expect(laid.cells[0].labelPos).toBe("bottom");
  });
  it("without heightPx, uses the legacy gridY origin (back-compat)", () => {
    const laid = layoutPortGroup(g({ gridY: 10 }));
    expect(laid.cells[0].y).toBe(10);
    expect(laid.top).toBe(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/domain/faceplate-geometry.test.ts`
Expected: FAIL — `labelPos`/`top` undefined, `heightPx` arg ignored.

- [ ] **Step 3: Implement**

In `src/domain/faceplate.ts`, extend the override type:

```ts
  portOverrides: Record<number, { name?: string; flipped?: boolean; labelPos?: "top" | "bottom" }>;
```

In `src/domain/faceplate-geometry.ts`, add the constant near the others:

```ts
export const LABEL_H = 12; // vertical strip for a port's number label
```

Add fields to the interfaces:

```ts
export interface LaidOutPort {
  index: number;
  row: number;
  col: number;
  x: number;
  y: number;
  number: number;
  label: string;
  labelPos: "top" | "bottom";
  flipped: boolean;
  media: Media;
  connectorType: string;
}

export interface LaidOutGroup {
  id: string;
  cells: LaidOutPort[];
  width: number;
  height: number;
  top: number;
}
```

Replace `layoutPortGroup`:

```ts
export function layoutPortGroup(group: PortGroup, heightPx?: number): LaidOutGroup {
  const seq = portSequence(group.rows, group.cols, group.countingDirection);
  const height = group.rows * ROW_H + Math.max(0, group.rows - 1) * group.rowSpacing;
  // Vertical origin: centered in the device when heightPx is provided, else legacy gridY.
  const top = heightPx !== undefined ? (heightPx - height) / 2 : group.gridY;
  const cells: LaidOutPort[] = [];
  for (let index = 0; index < group.rows * group.cols; index++) {
    const row = Math.floor(index / group.cols);
    const col = index % group.cols;
    const override = group.portOverrides[index];
    const number = seq[index];
    const label = override?.name ?? `${group.idPrefix}${pad2(number)}`;
    const labelPos: "top" | "bottom" =
      override?.labelPos ?? (group.rows > 1 && row === group.rows - 1 ? "bottom" : "top");
    cells.push({
      index,
      row,
      col,
      x: group.gridX + col * (CELL_W + group.colSpacing),
      y: top + row * (ROW_H + group.rowSpacing),
      number,
      label,
      labelPos,
      flipped: override?.flipped ?? false,
      media: group.media,
      connectorType: group.connectorType,
    });
  }
  const width = group.cols * CELL_W + Math.max(0, group.cols - 1) * group.colSpacing;
  return { id: group.id, cells, width, height, top };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/domain/faceplate-geometry.test.ts`
Expected: PASS — the new tests plus all existing geometry tests (legacy `layoutPortGroup(group)` calls are unchanged: same `y`, same `height`; `labelPos`/`top` are additive).

- [ ] **Step 5: Commit**

```bash
git add src/domain/faceplate.ts src/domain/faceplate-geometry.ts src/domain/faceplate-geometry.test.ts
git commit -m "feat: device-height-aware layoutPortGroup (centered) + per-tile labelPos"
```

---

## Task 2: Faceplate — label top/bottom + in-place highlight

**Files:**
- Modify: `src/features/device-library/faceplate/Faceplate.tsx`
- Modify: `src/features/device-library/faceplate/Faceplate.test.tsx`

**Interfaces:**
- Consumes: `layoutPortGroup(group, heightPx)`, `LABEL_H`, `LaidOutPort.labelPos`, `LaidOutGroup` from Task 1.
- Produces:
  - `interface HighlightPort { groupId: string; portIndex: number }`
  - `renderFace(face, opts, highlight?: HighlightPort | null)` and `Faceplate({ ..., highlight })` — pass `dims.heightPx` into `layoutPortGroup`; `PortCell` renders the label above (`top`) or below (`bottom`) the glyph and recolours the tile `#2d5bff` when it is the highlight target. `PortCell` gets `data-highlighted="true|false"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/faceplate/Faceplate.test.tsx`:

```tsx
import type { PortGroup } from "@/domain/faceplate";

function cg(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 2, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}

describe("Faceplate — highlight & label position", () => {
  it("recolours only the highlighted port's tile blue", () => {
    const face: Face = { portGroups: [cg()], elements: [] };
    const { getAllByTestId } = render(
      <Faceplate face={face} widthIn={19} rackUnits={1} rackMounted highlight={{ groupId: "g1", portIndex: 1 }} />,
    );
    const cells = getAllByTestId("port-cell");
    const highlighted = cells.filter((c) => c.getAttribute("data-highlighted") === "true");
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].innerHTML).toContain("#2d5bff");
  });

  it("no port is highlighted when highlight is null", () => {
    const face: Face = { portGroups: [cg()], elements: [] };
    const { getAllByTestId } = render(
      <Faceplate face={face} widthIn={19} rackUnits={1} rackMounted highlight={null} />,
    );
    expect(getAllByTestId("port-cell").every((c) => c.getAttribute("data-highlighted") === "false")).toBe(true);
  });

  it("renders a port's label below the glyph when labelPos is bottom", () => {
    const face: Face = { portGroups: [cg({ portOverrides: { 0: { labelPos: "bottom" } } })], elements: [] };
    const { getAllByTestId } = render(
      <Faceplate face={face} widthIn={19} rackUnits={1} rackMounted />,
    );
    // the first cell's label <text> y should be below its glyph box (greater y than a top label)
    const cell0 = getAllByTestId("port-cell")[0];
    const text = cell0.querySelector("text")!;
    const cell1 = getAllByTestId("port-cell")[1]; // default top
    const text1 = cell1.querySelector("text")!;
    expect(Number(text.getAttribute("y"))).toBeGreaterThan(Number(text1.getAttribute("y")));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/faceplate/Faceplate.test.tsx`
Expected: FAIL — `highlight` prop / `data-highlighted` / label-position not implemented.

- [ ] **Step 3: Implement**

Edit `src/features/device-library/faceplate/Faceplate.tsx`. Add `LABEL_H` to the geometry import:

```tsx
import {
  frameDims,
  screwHoles,
  layoutPortGroup,
  CELL_W,
  ROW_H,
  GLYPH_W,
  LABEL_H,
  type LaidOutPort,
} from "@/domain/faceplate-geometry";
```

Add the highlight type and rewrite `PortCell`:

```tsx
export interface HighlightPort {
  groupId: string;
  portIndex: number;
}

function PortCell({ cell, highlighted }: { cell: LaidOutPort; highlighted: boolean }) {
  const spec = PORT_GLYPHS[cell.media];
  const gx = cell.x + CELL_W / 2;
  const gy = cell.y + ROW_H / 2;
  const glyphColor = highlighted ? "#2d5bff" : "#111418";
  const labelFill = highlighted ? "#2d5bff" : "#4b5563";
  const labelY = cell.labelPos === "top" ? cell.y - 3 : cell.y + ROW_H + LABEL_H - 3;
  return (
    <g data-testid="port-cell" data-highlighted={highlighted ? "true" : "false"}>
      <text
        x={cell.x + CELL_W / 2}
        y={labelY}
        textAnchor="middle"
        fontSize={8}
        fontFamily="Inter, system-ui, sans-serif"
        style={{ fontVariantNumeric: "tabular-nums" }}
        fill={labelFill}
      >
        {cell.label}
      </text>
      <g
        transform={`translate(${gx - GLYPH_W / 2}, ${gy - spec.height / 2})${
          cell.flipped ? ` translate(0, ${spec.height}) scale(1, -1)` : ""
        }`}
        color={glyphColor}
      >
        <svg width={GLYPH_W} height={spec.height} viewBox={spec.viewBox} overflow="visible">
          {spec.body}
        </svg>
      </g>
    </g>
  );
}
```

Update `renderFace` to take `highlight` and pass `heightPx`:

```tsx
export function renderFace(face: Face, opts: FaceplateOptions, highlight?: HighlightPort | null) {
  const dims = frameDims(opts);
  const holes = screwHoles(dims, opts.rackUnits);
  const groups = face.portGroups.map((g) => layoutPortGroup(g, dims.heightPx));
  const svgWidth = dims.frameWidthPx;
  const svgHeight = dims.heightPx;
```

...and the body cells:

```tsx
      <g data-testid="faceplate-body" transform={`translate(${dims.earWidthPx}, 0)`}>
        {groups.flatMap((g) =>
          g.cells.map((cell) => (
            <PortCell
              key={`${g.id}-${cell.index}`}
              cell={cell}
              highlighted={highlight?.groupId === g.id && highlight?.portIndex === cell.index}
            />
          )),
        )}
      </g>
```

Update `Faceplate` to accept and forward `highlight`:

```tsx
export function Faceplate({
  face,
  side,
  highlight,
  ...opts
}: { face: Face; side?: "FRONT" | "BACK"; highlight?: HighlightPort | null } & FaceplateOptions) {
```

...and in its body change `{renderFace(face, opts)}` to `{renderFace(face, opts, highlight)}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/faceplate/Faceplate.test.tsx`
Expected: PASS (existing Faceplate tests + the 3 new). Existing tests don't pass `highlight`, so every cell is `data-highlighted="false"` and colours are unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/faceplate/Faceplate.tsx src/features/device-library/faceplate/Faceplate.test.tsx
git commit -m "feat: Faceplate in-place port highlight + per-tile label position"
```

---

## Task 3: portGroupOps — horizontal collision, maxRow clamp, horizontal move, labelPos

**Files:**
- Modify: `src/features/device-library/editor/portGroupOps.ts`
- Modify: `src/features/device-library/editor/portGroupOps.test.ts`

**Interfaces:**
- Consumes: `CELL_W`, `ROW_H`, `LABEL_H` from `@/domain/faceplate-geometry`.
- Produces (behavioural changes, signatures unchanged unless noted):
  - `wouldOverlap` / `wouldOverlapAt` — horizontal x-range overlap only (plus bounds for `wouldOverlapAt`).
  - `findFreePosition` — horizontal nudge only (y is derived; returns the input `desired.y` unchanged for `y`, snapped/clamped `x`).
  - `movePortGroup` — sets `gridX` only (leaves `gridY`).
  - `maxSpacing` — `maxRow = rows > 1 ? max(0, (bounds.height − 2*LABEL_H − rows*ROW_H) / (rows − 1)) : 0`; `maxCol` unchanged.
  - `setPortOverride` patch type gains `labelPos?: "top" | "bottom"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/portGroupOps.test.ts`:

```ts
describe("horizontal-only collision (3d)", () => {
  it("two groups overlap when their x-ranges overlap regardless of rows", () => {
    // a: 1 row at x0 (width 24); b: 2 rows at x10 → x-ranges overlap → collision
    const face: Face = { portGroups: [group({ id: "a", gridX: 0, rows: 1 })], elements: [] };
    expect(wouldOverlap(face, group({ id: "b", gridX: 10, rows: 2 }))).toBe(true);
  });
  it("no overlap when x-ranges are clear", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 0 })], elements: [] };
    expect(wouldOverlap(face, group({ id: "b", gridX: 40 }))).toBe(false);
  });
});

describe("movePortGroup is horizontal-only (3d)", () => {
  it("changes gridX and leaves gridY", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, { width: 400, height: 84 });
    const id = face.portGroups[0].id;
    const before = face.portGroups[0].gridY;
    const next = movePortGroup(face, id, { x: 104, y: 999 }, { width: 400, height: 84 });
    expect(next.portGroups[0].gridX).toBe(104);
    expect(next.portGroups[0].gridY).toBe(before);
  });
});

describe("maxSpacing.maxRow clamps to device height (3d)", () => {
  it("2 rows in 84px height: maxRow = (84 - 24 - 48)/1 = 12", () => {
    const g = group({ id: "g", rows: 2, cols: 1 });
    expect(maxSpacing({ portGroups: [g], elements: [] }, g, { width: 400, height: 84 }).maxRow).toBeCloseTo(12, 5);
  });
  it("single row → maxRow 0", () => {
    const g = group({ id: "g", rows: 1, cols: 1 });
    expect(maxSpacing({ portGroups: [g], elements: [] }, g, { width: 400, height: 84 }).maxRow).toBe(0);
  });
});

describe("setPortOverride carries labelPos (3d)", () => {
  it("stores labelPos", () => {
    const face: Face = { portGroups: [group({ id: "g" })], elements: [] };
    expect(setPortOverride(face, "g", 0, { labelPos: "bottom" }).portGroups[0].portOverrides[0]).toEqual({ labelPos: "bottom" });
  });
});
```

> Note: any pre-existing overlap test in this file that relied on two groups being vertically separated (same x-range, different y) must be updated — under horizontal-only collision they now overlap. Search the file for such cases and adjust the expectation; the common same-row cases are unaffected.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/portGroupOps.test.ts`
Expected: FAIL — vertical logic still present; `maxRow` uses the old formula.

- [ ] **Step 3: Implement**

In `src/features/device-library/editor/portGroupOps.ts`, add `LABEL_H` to the geometry import (alongside `CELL_W`/`ROW_H`).

Replace `rectsOverlap`/`wouldOverlap` with horizontal x-range logic:

```ts
function groupWidth(g: PortGroup): number {
  return g.cols * CELL_W + Math.max(0, g.cols - 1) * g.colSpacing;
}

function xOverlap(ax: number, aw: number, bx: number, bw: number): boolean {
  return ax < bx + bw && ax + aw > bx;
}

export function wouldOverlap(face: Face, candidate: PortGroup, excludeId?: string): boolean {
  const cw = groupWidth(candidate);
  return face.portGroups.some(
    (g) => g.id !== excludeId && xOverlap(candidate.gridX, cw, g.gridX, groupWidth(g)),
  );
}
```

Change `findFreePosition` to snap/clamp/search on **x only**, keeping the passed `y`:

```ts
export function findFreePosition(
  face: Face, group: PortGroup, desired: Pos, bounds: GridBounds, excludeId?: string,
): Pos | null {
  const w = groupWidth(group);
  const tryAt = (x: number): number | null => {
    const cx = Math.max(0, Math.min(snap(x), bounds.width - w));
    const candidate: PortGroup = { ...group, gridX: cx };
    return wouldOverlap(face, candidate, excludeId) ? null : cx;
  };
  const direct = tryAt(desired.x);
  if (direct !== null) return { x: direct, y: desired.y };
  const maxR = Math.ceil(bounds.width / SNAP) + 1;
  for (let r = 1; r <= maxR; r++) {
    for (const x of [snap(desired.x) - r * SNAP, snap(desired.x) + r * SNAP]) {
      const ok = tryAt(x);
      if (ok !== null) return { x: ok, y: desired.y };
    }
  }
  return null;
}
```

Change `movePortGroup` to horizontal-only:

```ts
export function movePortGroup(face: Face, id: string, pos: Pos, bounds: GridBounds): Face {
  const g = face.portGroups.find((x) => x.id === id);
  if (!g) return face;
  const free = findFreePosition(face, g, pos, bounds, id);
  if (!free) return face;
  return { ...face, portGroups: face.portGroups.map((x) => (x.id === id ? { ...x, gridX: free.x } : x)) };
}
```

Update `maxSpacing`'s `maxRow` branch to the device-height clamp (leave `maxCol` as-is):

```ts
  let maxRow = 0;
  if (group.rows > 1) {
    maxRow = Math.max(0, (bounds.height - 2 * LABEL_H - group.rows * ROW_H) / (group.rows - 1));
  }
```

(Delete the old neighbour-scanning `maxRow` loop.)

Update `wouldOverlapAt` to horizontal + bounds:

```ts
export function wouldOverlapAt(face: Face, group: PortGroup, pos: Pos, bounds: GridBounds): boolean {
  const w = groupWidth(group);
  if (pos.x < 0 || pos.x + w > bounds.width) return true;
  return wouldOverlap(face, { ...group, gridX: pos.x }, group.id);
}
```

Extend `setPortOverride`'s patch type:

```ts
export function setPortOverride(
  face: Face, groupId: string, index: number,
  patch: { name?: string; flipped?: boolean; labelPos?: "top" | "bottom" },
): Face {
```

> `groupBounds` (used elsewhere) may keep returning the full rect; collision no longer calls it. If `maxSpacing`'s `maxCol` branch used `groupBounds`, leave that path intact (it is horizontal).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/portGroupOps.test.ts`
Expected: PASS (new + existing, after adjusting any vertical-separation cases per the Step-1 note).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/portGroupOps.ts src/features/device-library/editor/portGroupOps.test.ts
git commit -m "feat: horizontal-only collision + device-height maxRow + horizontal move + labelPos"
```

---

## Task 4: EditorCanvas — highlight passthrough, centered overlay, horizontal-only move, no blue-copy

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: `Faceplate`'s `highlight` prop (Task 2); `layoutPortGroup(group, heightPx)` (Task 1).
- Produces: `EditorCanvas` gains `highlight?: HighlightPort | null` (forwarded to `Faceplate`); the overlay group boxes / port targets are positioned from the centered layout (`laid.top`, `cell.x`, `cell.y`); the Slice-3c overlay blue-copy (`port-highlight`) is **removed**; move-drag ignores vertical (commits `{ x, y: g.gridY }`).

- [ ] **Step 1: Update the tests**

In `src/features/device-library/editor/EditorCanvas.test.tsx`: **remove** the Slice-3c test `draws the blue highlight only for the selected port` (the `port-highlight` overlay no longer exists). Append:

```tsx
describe("EditorCanvas highlight passthrough (3d)", () => {
  it("forwards highlight to Faceplate (selected port renders blue, no overlay copy)", () => {
    const { getAllByTestId, queryByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" selectedPortIndex={1} onSelect={() => {}} onSelectPort={() => {}}
        highlight={{ groupId: "g1", portIndex: 1 }} />,
    );
    expect(queryByTestId("port-highlight")).toBeNull(); // overlay copy gone
    const blued = getAllByTestId("port-cell").filter((c) => c.getAttribute("data-highlighted") === "true");
    expect(blued).toHaveLength(1);
  });
});
```

(The existing per-port `port-target` test and move/spacing/chevron tests stay.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — `highlight` prop not forwarded; the removed blue-copy test is gone.

- [ ] **Step 3: Implement**

In `EditorCanvas.tsx`:

- Add `import { type HighlightPort } from "@/features/device-library/faceplate/Faceplate";` and add `highlight?: HighlightPort | null;` to `EditorCanvasProps`.
- Pass it to `Faceplate`: `<Faceplate ... highlight={props.highlight} />`.
- **Remove** the blue-copy block (the `{isSel && ( ...port-highlight... )}` JSX added in Slice 3c). Keep the per-cell `port-target-<index>` click targets.
- Position the overlay from the centered layout. Where the group box currently uses `top: g.gridY - SEL_PAD`, compute the laid-out group and use its `top`:

```tsx
          {face.portGroups.map((g) => {
            const laid = layoutPortGroup(g, dims.heightPx);
            const selected = g.id === props.selectedGroupId;
            const left = earX + g.gridX;
            const boxTop = laid.top;
```

...and change the box style `top` to `boxTop - SEL_PAD` (from `g.gridY - SEL_PAD`), and the live-move `liveY` to use `boxTop` (vertical no longer moves): set `top: (dragging ? boxTop : boxTop) - SEL_PAD` — i.e. vertical is always `boxTop`.
- The per-cell targets already use `cell.x - g.gridX + SEL_PAD` / `cell.y - g.gridY + SEL_PAD`; change the vertical to be relative to `boxTop`: `cell.y - boxTop + SEL_PAD` (since cells are now laid out from the centered `top`, not `gridY`).
- Move-drag: seed and commit with vertical fixed. In `onPointerDown` keep `origY: g.gridY`; in the commit (`onUp`), call `props.onMove?.(drag!.id, { x: drag!.origX + dx, y: drag!.origY })` (drop the `+ dy`). Live `liveX = g.gridX + drag!.dx` stays; there is no `liveY` change (`boxTop` is fixed). `invalid` uses `wouldOverlapAt(face, g, { x: liveX, y: g.gridY }, bounds)` (unchanged import).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS (updated + existing). The drag-to-move commit test still asserts `{ x: 60, y: 20 }` for a group whose `origY` is 20 — confirm that test's expected `y` equals `origY` (update it from `{x:60,y:28}` to `{x:60,y:20}` since vertical no longer changes).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: EditorCanvas highlight passthrough, centered overlay, horizontal-only move; drop blue-copy"
```

---

## Task 5: EditorCanvas — chevron click-or-drag

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: existing `onAddColumn`/`onAddRow`.
- Produces: the chevrons support pointer-drag — dragging the › right adds one `onAddColumn` per `CELL_W` of horizontal drag; dragging the ⌄ down adds one `onAddRow` per `ROW_H` of vertical drag. A plain click (no movement) still adds one (existing behaviour).

- [ ] **Step 1: Write the failing test**

Append to `src/features/device-library/editor/EditorCanvas.test.tsx`:

```tsx
describe("EditorCanvas chevron drag (3d)", () => {
  it("dragging the column chevron right adds one column per CELL_W", () => {
    const onAddColumn = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onAddColumn={onAddColumn} />,
    );
    const chev = getByTestId("chevron-col");
    fireEvent.pointerDown(chev, { clientX: 100, clientY: 50 });
    fireEvent.pointerMove(window, { clientX: 100 + 24 * 2 + 2, clientY: 50 }); // ~2 columns of drag
    fireEvent.pointerUp(window, { clientX: 100 + 24 * 2 + 2, clientY: 50 });
    expect(onAddColumn).toHaveBeenCalledTimes(2);
  });

  it("a plain click still adds one column", () => {
    const onAddColumn = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onAddColumn={onAddColumn} />,
    );
    fireEvent.pointerDown(getByTestId("chevron-col"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    expect(onAddColumn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — chevrons only handle click; drag adds nothing / plain click double-behaviour differs.

- [ ] **Step 3: Implement**

Replace each chevron's `onClick` with a pointer-drag handler that counts threshold crossings. Add a `chevDrag` state and effect:

```tsx
  const [chevDrag, setChevDrag] = useState<
    { id: string; axis: "col" | "row"; start: number; added: number } | null
  >(null);

  useEffect(() => {
    if (!chevDrag) return;
    function onMove(e: PointerEvent) {
      setChevDrag((d) => {
        if (!d) return d;
        const step = d.axis === "col" ? CELL_W : ROW_H;
        const dist = d.axis === "col" ? e.clientX - d.start : e.clientY - d.start;
        const want = Math.max(0, Math.floor(dist / step));
        for (let i = d.added; i < want; i++) {
          if (d.axis === "col") props.onAddColumn?.(d.id);
          else props.onAddRow?.(d.id);
        }
        return want > d.added ? { ...d, added: want } : d;
      });
    }
    function onUp() {
      setChevDrag((d) => {
        // a plain click (no threshold crossed) still adds one
        if (d && d.added === 0) {
          if (d.axis === "col") props.onAddColumn?.(d.id);
          else props.onAddRow?.(d.id);
        }
        return null;
      });
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [chevDrag, props]);
```

Change the column chevron to start a drag on pointerdown (and drop its `onClick`):

```tsx
                    <button
                      type="button"
                      data-testid="chevron-col"
                      title="Add a column of ports (click, or drag right for more)"
                      onPointerDown={(e) => { e.stopPropagation(); setChevDrag({ id: g.id, axis: "col", start: e.clientX, added: 0 }); }}
                      style={chevronStyle({ right: -8, top: "50%", translate: "0 -50%" })}
                    >›</button>
```

Row chevron likewise (`axis: "row"`, `start: e.clientY`, drop `onClick`):

```tsx
                    <button
                      type="button"
                      data-testid="chevron-row"
                      title="Add a row of ports (click, or drag down for more)"
                      onPointerDown={(e) => { e.stopPropagation(); setChevDrag({ id: g.id, axis: "row", start: e.clientY, added: 0 }); }}
                      style={chevronStyle({ bottom: -8, left: "50%", translate: "-50% 0" })}
                    >⌄</button>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS (all EditorCanvas tests). The prior click-only chevron test (`fireEvent.click(chevron-col)` → called once) may now need to be a pointerDown+pointerUp pair — update that existing test to fire `pointerDown` then `pointerUp` at the same coords (a plain click) so it still asserts a single add.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: EditorCanvas chevron click-or-drag (add multiple rows/cols)"
```

---

## Task 6: PortSettings — label position toggle

**Files:**
- Modify: `src/features/device-library/editor/PortSettings.tsx`
- Modify: `src/features/device-library/editor/PortSettings.test.tsx`

**Interfaces:**
- Produces: `PortSettings` gains `labelPos: "top" | "bottom"` prop and a `data-testid="port-labelpos"` toggle that emits `onChange({ labelPos })` (flips top↔bottom). Its `onChange` patch type gains `labelPos?`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/device-library/editor/PortSettings.test.tsx`:

```tsx
it("toggles label position top↔bottom", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<PortSettings portLabel="01" name="" flipped={false} labelPos="top" onChange={onChange} />);
  await user.click(screen.getByTestId("port-labelpos"));
  expect(onChange).toHaveBeenLastCalledWith({ labelPos: "bottom" });
});
```

(Update the existing `PortSettings` render calls in this file to pass `labelPos="top"`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/editor/PortSettings.test.tsx`
Expected: FAIL — no `port-labelpos` / `labelPos` prop.

- [ ] **Step 3: Implement**

Edit `src/features/device-library/editor/PortSettings.tsx` — add `labelPos` to the props and `onChange` patch type, and a toggle button:

```tsx
export function PortSettings({
  portLabel, name, flipped, labelPos, onChange,
}: {
  portLabel: string;
  name: string;
  flipped: boolean;
  labelPos: "top" | "bottom";
  onChange: (patch: { name?: string; flipped?: boolean; labelPos?: "top" | "bottom" }) => void;
}) {
```

Add, next to the Flip button:

```tsx
        <button
          type="button"
          data-testid="port-labelpos"
          onClick={() => onChange({ labelPos: labelPos === "top" ? "bottom" : "top" })}
          className="flex h-9 items-center gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold"
        >
          Label: {labelPos === "top" ? "Top" : "Bottom"}
        </button>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/editor/PortSettings.test.tsx`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/PortSettings.tsx src/features/device-library/editor/PortSettings.test.tsx
git commit -m "feat: PortSettings label position toggle"
```

---

## Task 7: RackDeviceEditor — wire highlight + label toggle + verification

**Files:**
- Modify: `src/features/device-library/editor/RackDeviceEditor.tsx`
- Modify: `src/features/device-library/editor/RackDeviceEditor.test.tsx`

**Interfaces:**
- Consumes: `EditorCanvas`'s `highlight` prop; `PortSettings`'s `labelPos` prop; `setPortOverride` (labelPos).
- Produces: the editor passes `highlight={{ groupId, portIndex }}` (when a port is selected) to `EditorCanvas`, and drives `PortSettings`' `labelPos` + label toggle via `setPortOverride`.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/RackDeviceEditor.test.tsx`:

```tsx
describe("RackDeviceEditor — 3d refinements", () => {
  function withGroup() {
    const face: Face = {
      portGroups: [{
        id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
        countingDirection: "ltr", rows: 1, cols: 3, gridX: 0, gridY: 0,
        colSpacing: 0, rowSpacing: 0, portOverrides: {},
      }],
      elements: [],
    };
    render(<RackDeviceEditor mode="edit" types={types} brands={brands}
      initial={{ name: "S", deviceTypeId: "t1", widthIn: 19, frontFace: face }} onSave={noop} onCancel={noop} />);
  }

  it("selecting a port highlights it in the preview (blue tile, no overlay copy)", () => {
    withGroup();
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-1"));
    expect(screen.queryByTestId("port-highlight")).toBeNull();
    const blued = screen.getAllByTestId("port-cell").filter((c) => c.getAttribute("data-highlighted") === "true");
    expect(blued).toHaveLength(1);
  });

  it("toggling label position moves that port's label", async () => {
    const user = userEvent.setup();
    withGroup();
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    const before = Number(screen.getAllByTestId("port-cell")[0].querySelector("text")!.getAttribute("y"));
    await user.click(screen.getByTestId("port-labelpos"));
    const after = Number(screen.getAllByTestId("port-cell")[0].querySelector("text")!.getAttribute("y"));
    expect(after).not.toBe(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: FAIL — highlight not wired; PortSettings missing `labelPos`.

- [ ] **Step 3: Wire `RackDeviceEditor.tsx`**

- Pass `highlight` to `EditorCanvas`:

```tsx
              highlight={selectedGroupId && selectedPortIndex !== null ? { groupId: selectedGroupId, portIndex: selectedPortIndex } : null}
```

- In the `PortSettings` mount block, add `labelPos` and include it in the `onChange` (the existing `onChange` already routes to `setPortOverride`, which now accepts `labelPos`). Compute the resolved default from the laid-out cell:

```tsx
        {selectedGroup && selectedPortIndex !== null && (() => {
          const cell = layoutPortGroup(selectedGroup, undefined).cells.find((c) => c.index === selectedPortIndex);
          const ov = selectedGroup.portOverrides[selectedPortIndex] ?? {};
          return (
            <PortSettings
              portLabel={cell ? cell.label : String(selectedPortIndex + 1)}
              name={ov.name ?? ""}
              flipped={ov.flipped ?? false}
              labelPos={cell ? cell.labelPos : "top"}
              onChange={(patch) => setActiveFace(setPortOverride(activeFace, selectedGroup.id, selectedPortIndex, patch))}
            />
          );
        })()}
```

(`layoutPortGroup(selectedGroup, undefined)` resolves `labelPos` via the same default logic; `undefined` heightPx is fine here since only `labelPos`/`label` are read.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: PASS (3a/3b/3c editor tests + the 2 new).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all tests across the suite. **Before running, update the one pre-existing cross-file test that Task 5 breaks:** in `RackDeviceEditor.test.tsx`, the Slice-3b test `chevron adds a column (preview gains a port cell)` uses `fireEvent.click(screen.getByTestId("chevron-col"))`; the chevron is now pointer-based, so change that line to a plain-click pointer pair — `fireEvent.pointerDown(screen.getByTestId("chevron-col"), { clientX: 10, clientY: 10 }); fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });` — which still adds exactly one column. (No other suite test clicks a chevron.)

- [ ] **Step 6: Browser verification (controller)**

With Supabase running, open `/device-library` → Create. Verify:
- Drop a copper port → it renders **vertically centered**. Add a 2nd row → the two rows straddle center (top-half / bottom-half).
- Select a port → its glyph + number turn **blue in place** (no separate overlay copy).
- In the port panel, toggle **Label: Top/Bottom** → that port's number moves above/below its glyph.
- **Drag** the › chevron right → several columns add as you drag; a plain click adds one. Same for ⌄ down (rows).
- Drag a group horizontally → moves left/right; vertical stays centered. Spread with the handle → rows spread symmetrically, clamped.
- **Save**, reopen via **Edit** → label positions, spacing, and horizontal positions persist.

- [ ] **Step 7: Commit + finish the branch**

```bash
git add src/features/device-library/editor/RackDeviceEditor.tsx src/features/device-library/editor/RackDeviceEditor.test.tsx
git commit -m "feat: wire in-place highlight + label-position toggle into the editor"
```

Then run `superpowers:requesting-code-review` (whole-branch), address findings, and `superpowers:finishing-a-development-branch` to open the stacked PR (base = `phase-2a-slice-3c`). Update `docs/superpowers/notes/RESUME.md` and project memory: Slice 3d done; Slice 4 (Text/Icon elements) remains for Phase 2a.

---

## Self-Review

**Spec coverage:**
- Tile + derived vertical centering (heightPx-aware layout, gridY unused vertically) → Tasks 1, 2, 4. ✅
- Collision horizontal-only → Task 3. ✅
- In-place blue highlight (pure Faceplate `highlight`, overlay copy removed) → Tasks 2, 4, 7. ✅
- Per-port label top/bottom (override + default + render + toggle) → Tasks 1, 2, 6, 7. ✅
- Chevron click-or-drag → Task 5. ✅
- Horizontal-only move → Tasks 3, 4. ✅
- rowSpacing-only vertical fine-tune (maxRow device clamp) → Task 3. ✅
- No persistence change (labelPos/spacing/gridX ride existing jsonb) → all. ✅

**Placeholder scan:** No TODO/TBD. The Step-1 notes to update pre-existing vertical-separation / drag-commit / chevron-click tests are concrete instructions with the exact new expectations, not placeholders. All new test code is complete.

**Type consistency:** `HighlightPort` (Task 2) is imported by Task 4 and constructed in Task 7. `LaidOutPort.labelPos` / `LaidOutGroup.top` (Task 1) are consumed by Tasks 2, 4. `layoutPortGroup(group, heightPx?)` signature is consistent across Tasks 1, 2, 4, 7. `setPortOverride` patch type (`labelPos?`) matches Tasks 3, 6, 7. `PortSettings` `labelPos` prop matches Tasks 6, 7. `LABEL_H`/`CELL_W`/`ROW_H` from the geometry module throughout.
```
