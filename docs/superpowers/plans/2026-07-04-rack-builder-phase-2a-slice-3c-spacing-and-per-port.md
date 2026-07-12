# Phase 2a · Slice 3c — Spacing Handle & Per-Port Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Rack Device Editor — a bottom-right spacing handle that spreads a selected group's ports (clamped to the grid edge and neighbours), per-port selection with a blue label+icon highlight and a name+flip panel, and a live drag-follow visual with a red would-overlap outline for group moves.

**Architecture:** New pure transforms in `portGroupOps.ts` (setPortOverride, setSpacing, maxSpacing, wouldOverlapAt), all interactive controls in the `EditorCanvas` overlay over the untouched pure `Faceplate`, state in `RackDeviceEditor` via `useDeviceDraft.setActiveFace`. Name/flip already round-trip through `Faceplate` (it reads `portOverrides`), so per-port editing is just a `portOverrides` mutation; the blue highlight is an overlay-drawn blue copy of the glyph.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, Pointer Events, Vitest 2 + @testing-library/react (jsdom).

## Global Constraints

- **Next.js 16 + React 19 + TypeScript 5**; path alias `@/` → `src/`.
- **`Faceplate` stays pure/read-only** — never modified. Name/flip flow through `portOverrides` (Faceplate already renders `override.name` as the label and mirrors the glyph on `override.flipped`); the blue selected-port highlight is an overlay-drawn **blue copy** of the glyph+number (reusing `PortGlyph`), never a recolor of the SVG.
- **Overlaps stay disallowed.** The spacing spread is clamped **once on grab** to the largest spacing keeping the group within the grid **and** clear of every other group (grid edge AND neighbours). The live group-move outline turns red when the current position would overlap or exceed the grid.
- **Name-clearing:** the port panel stores `name: value || undefined` so an empty input becomes `undefined` (falls back to the derived `idPrefix+number` label via `layoutPortGroup`'s `??`); never store `""`.
- **Selection model:** `selectedGroupId` (3b) + nested `selectedPortIndex: number | null`. Group-level controls (chevrons + spacing handle) stay visible while a group is selected, even when a port within it is selected. Selecting another group / switching Front-Back / deleting the group clears `selectedPortIndex`.
- **Spacing is per-axis:** horizontal drag → `colSpacing`, vertical → `rowSpacing`; each clamped to `[0, max]`; single-col → `maxCol = 0`, single-row → `maxRow = 0`.
- **All mutations go through `useDeviceDraft.setActiveFace`.** No persistence change (colSpacing/rowSpacing/portOverrides already round-trip in the `PortGroup` jsonb).
- **Geometry:** `CELL_W = ROW_H = 24`, `GLYPH_W = 20` from `@/domain/faceplate-geometry`; `PORT_GLYPHS[media].height` from `portGlyphs`. Overlay maps 1:1 to the SVG; a laid-out cell at `(cell.x, cell.y)` renders at overlay `left = earWidthPx + cell.x`, `top = cell.y`.
- Tests: Vitest, one behaviour per `it`. `npm test`. Do **not** run `npm run lint` (pre-existing repo-wide failure).
- Work on branch `phase-2a-slice-3c` (already cut from `phase-2a-slice-3b`).
- TDD, DRY, YAGNI, frequent commits.

---

## File Structure

- **Modify** `src/features/device-library/editor/portGroupOps.ts` (+ `.test.ts`) — add `setPortOverride`, `setSpacing`, `maxSpacing`, `wouldOverlapAt` (Task 1).
- **Modify** `src/features/device-library/editor/EditorCanvas.tsx` (+ `.test.tsx`) — per-port select targets + blue highlight (Task 2); spacing handle (Task 3); live move-follow + red outline (Task 4).
- **Create** `src/features/device-library/editor/PortSettings.tsx` (+ `.test.tsx`) — per-port name + flip panel (Task 5).
- **Modify** `src/features/device-library/editor/RackDeviceEditor.tsx` (+ its test) — `selectedPortIndex` state, wire onSelectPort/onSpacing, mount `PortSettings`, clear on group/side change (Task 6).

---

## Task 1: Pure ops — overrides, spacing, clamp, overlap-at

**Files:**
- Modify: `src/features/device-library/editor/portGroupOps.ts` (append)
- Test: `src/features/device-library/editor/portGroupOps.test.ts` (append)

**Interfaces:**
- Consumes: existing `groupBounds`, `wouldOverlap`, `GridBounds`, `Pos`; `CELL_W`, `ROW_H` from `@/domain/faceplate-geometry`; `Face`, `PortGroup` from `@/domain/faceplate`.
- Produces:
  - `setPortOverride(face: Face, groupId: string, index: number, patch: { name?: string; flipped?: boolean }): Face`
  - `setSpacing(face: Face, groupId: string, spacing: { colSpacing?: number; rowSpacing?: number }): Face`
  - `maxSpacing(face: Face, group: PortGroup, bounds: GridBounds): { maxCol: number; maxRow: number }`
  - `wouldOverlapAt(face: Face, group: PortGroup, pos: Pos, bounds: GridBounds): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/portGroupOps.test.ts`:

```ts
import { setPortOverride, setSpacing, maxSpacing, wouldOverlapAt } from "./portGroupOps";

describe("setPortOverride", () => {
  it("creates an override for a port index", () => {
    const face: Face = { portGroups: [group({ id: "g", cols: 2 })], elements: [] };
    const next = setPortOverride(face, "g", 1, { name: "UPLINK", flipped: true });
    expect(next.portGroups[0].portOverrides[1]).toEqual({ name: "UPLINK", flipped: true });
    expect(face.portGroups[0].portOverrides[1]).toBeUndefined(); // immutable
  });
  it("merges into an existing override", () => {
    const face: Face = { portGroups: [group({ id: "g", portOverrides: { 0: { name: "A" } } })], elements: [] };
    const next = setPortOverride(face, "g", 0, { flipped: true });
    expect(next.portGroups[0].portOverrides[0]).toEqual({ name: "A", flipped: true });
  });
});

describe("setSpacing", () => {
  it("sets col and row spacing", () => {
    const face: Face = { portGroups: [group({ id: "g" })], elements: [] };
    expect(setSpacing(face, "g", { colSpacing: 8, rowSpacing: 4 }).portGroups[0]).toMatchObject({ colSpacing: 8, rowSpacing: 4 });
  });
});

describe("maxSpacing", () => {
  it("clamps to the grid edge", () => {
    // 3 cols * 24 = 72 tight; grid width 200, gridX 0 → maxCol = (200-0-72)/2 = 64
    const g = group({ id: "g", cols: 3, gridX: 0, gridY: 0 });
    const face: Face = { portGroups: [g], elements: [] };
    expect(maxSpacing(face, g, { width: 200, height: 84 }).maxCol).toBeCloseTo(64, 5);
  });
  it("clamps tighter to a neighbour on the right", () => {
    const g = group({ id: "g", cols: 3, gridX: 0, gridY: 0 });
    const nb = group({ id: "nb", cols: 1, gridX: 120, gridY: 0 }); // right neighbour, same row
    const face: Face = { portGroups: [g, nb], elements: [] };
    // maxCol = (120 - 0 - 72)/2 = 24  (tighter than grid's 64)
    expect(maxSpacing(face, g, { width: 200, height: 84 }).maxCol).toBeCloseTo(24, 5);
  });
  it("a single column has maxCol 0; a single row has maxRow 0", () => {
    const g = group({ id: "g", cols: 1, rows: 1 });
    const m = maxSpacing({ portGroups: [g], elements: [] }, g, { width: 200, height: 84 });
    expect(m.maxCol).toBe(0);
    expect(m.maxRow).toBe(0);
  });
});

describe("wouldOverlapAt", () => {
  const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
  const b = group({ id: "b", gridX: 0, gridY: 0 });
  it("true when the position overlaps another group", () => {
    expect(wouldOverlapAt(face, b, { x: 10, y: 0 }, { width: 400, height: 84 })).toBe(true);
  });
  it("true when out of bounds", () => {
    expect(wouldOverlapAt(face, b, { x: 390, y: 0 }, { width: 400, height: 84 })).toBe(true); // 390+24>400
  });
  it("false at a free in-bounds spot", () => {
    expect(wouldOverlapAt(face, b, { x: 40, y: 0 }, { width: 400, height: 84 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/portGroupOps.test.ts`
Expected: FAIL — new functions not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/features/device-library/editor/portGroupOps.ts` (the file already imports `CELL_W`/`ROW_H`? it imports `layoutPortGroup`; add `CELL_W, ROW_H` to that geometry import):

```ts
export function setPortOverride(
  face: Face, groupId: string, index: number, patch: { name?: string; flipped?: boolean },
): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) =>
      g.id === groupId
        ? { ...g, portOverrides: { ...g.portOverrides, [index]: { ...g.portOverrides[index], ...patch } } }
        : g,
    ),
  };
}

export function setSpacing(
  face: Face, groupId: string, spacing: { colSpacing?: number; rowSpacing?: number },
): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) => (g.id === groupId ? { ...g, ...spacing } : g)),
  };
}

export function maxSpacing(
  face: Face, group: PortGroup, bounds: GridBounds,
): { maxCol: number; maxRow: number } {
  const gb = groupBounds(group);
  let maxCol = 0;
  if (group.cols > 1) {
    let limitRight = bounds.width;
    for (const other of face.portGroups) {
      if (other.id === group.id) continue;
      const ob = groupBounds(other);
      const vertOverlap = gb.y < ob.y + ob.height && gb.y + gb.height > ob.y;
      if (vertOverlap && ob.x >= group.gridX + group.cols * CELL_W) {
        limitRight = Math.min(limitRight, ob.x);
      }
    }
    maxCol = Math.max(0, (limitRight - group.gridX - group.cols * CELL_W) / (group.cols - 1));
  }
  let maxRow = 0;
  if (group.rows > 1) {
    let limitBottom = bounds.height;
    for (const other of face.portGroups) {
      if (other.id === group.id) continue;
      const ob = groupBounds(other);
      const horizOverlap = gb.x < ob.x + ob.width && gb.x + gb.width > ob.x;
      if (horizOverlap && ob.y >= group.gridY + group.rows * ROW_H) {
        limitBottom = Math.min(limitBottom, ob.y);
      }
    }
    maxRow = Math.max(0, (limitBottom - group.gridY - group.rows * ROW_H) / (group.rows - 1));
  }
  return { maxCol, maxRow };
}

export function wouldOverlapAt(
  face: Face, group: PortGroup, pos: Pos, bounds: GridBounds,
): boolean {
  const candidate: PortGroup = { ...group, gridX: pos.x, gridY: pos.y };
  const b = groupBounds(candidate);
  if (b.x < 0 || b.y < 0 || b.x + b.width > bounds.width || b.y + b.height > bounds.height) return true;
  return wouldOverlap(face, candidate, group.id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/portGroupOps.test.ts`
Expected: PASS (all prior + new).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/portGroupOps.ts src/features/device-library/editor/portGroupOps.test.ts
git commit -m "feat: port-group spacing/override ops (setPortOverride, setSpacing, maxSpacing, wouldOverlapAt)"
```

---

## Task 2: EditorCanvas — per-port select + blue highlight

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: `layoutPortGroup`, `CELL_W`, `ROW_H`, `GLYPH_W` from `@/domain/faceplate-geometry`; `PortGlyph`, `PORT_GLYPHS` from `@/features/device-library/faceplate/portGlyphs`.
- Produces: `EditorCanvas` gains `selectedPortIndex?: number | null` and `onSelectPort?: (index: number | null) => void`. For the selected group it renders a transparent click target per cell (`data-testid="port-target-<index>"`) → `onSelectPort(index)`; for the selected port it renders a blue copy (`data-testid="port-highlight"`: a blue `PortGlyph` mirrored on flip + a blue number).

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/EditorCanvas.test.tsx`:

```tsx
describe("EditorCanvas per-port selection", () => {
  it("renders a click target per cell and fires onSelectPort", () => {
    const onSelectPort = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSelectPort={onSelectPort} />,
    );
    fireEvent.click(getByTestId("port-target-1"));
    expect(onSelectPort).toHaveBeenCalledWith(1);
  });

  it("draws the blue highlight only for the selected port", () => {
    const { queryByTestId, rerender } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSelectPort={() => {}} />,
    );
    expect(queryByTestId("port-highlight")).toBeNull();
    rerender(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" selectedPortIndex={1} onSelect={() => {}} onSelectPort={() => {}} />,
    );
    expect(queryByTestId("port-highlight")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — no `port-target-*` / `port-highlight`.

- [ ] **Step 3: Implement**

In `EditorCanvas.tsx`, extend the imports:

```tsx
import { frameDims, layoutPortGroup, CELL_W, ROW_H, GLYPH_W } from "@/domain/faceplate-geometry";
import { PortGlyph, PORT_GLYPHS } from "@/features/device-library/faceplate/portGlyphs";
```

Add to `EditorCanvasProps`:

```tsx
  selectedPortIndex?: number | null;
  onSelectPort?: (index: number | null) => void;
```

Inside the selected group's box (the `{selected && ( ... )}` block, after the chevrons), render the per-cell targets + the blue highlight. Note the cell coordinates from `layoutPortGroup` are body-local (already include `gridX/gridY`); the box itself is offset by `left - SEL_PAD` / `g.gridY - SEL_PAD`, so inside the box a cell sits at `cell.x - g.gridX + SEL_PAD`, `cell.y - g.gridY + SEL_PAD`. Add:

```tsx
                    {laid.cells.map((cell) => {
                      const localX = cell.x - g.gridX + SEL_PAD;
                      const localY = cell.y - g.gridY + SEL_PAD;
                      const isSel = cell.index === props.selectedPortIndex;
                      const spec = PORT_GLYPHS[cell.media];
                      return (
                        <div key={cell.index}>
                          <div
                            data-testid={`port-target-${cell.index}`}
                            onClick={(e) => { e.stopPropagation(); props.onSelectPort?.(cell.index); }}
                            style={{ position: "absolute", left: localX, top: localY, width: CELL_W, height: ROW_H, cursor: "pointer", zIndex: 5 }}
                          />
                          {isSel && (
                            <div data-testid="port-highlight" style={{ position: "absolute", left: localX, top: localY, width: CELL_W, height: ROW_H, pointerEvents: "none", zIndex: 6, color: "#2d5bff" }}>
                              <span style={{ position: "absolute", left: 0, top: -12, width: CELL_W, textAlign: "center", fontSize: 8, fontFamily: "Inter, system-ui, sans-serif", fontVariantNumeric: "tabular-nums", color: "#2d5bff" }}>{cell.label}</span>
                              <div style={{ position: "absolute", left: (CELL_W - GLYPH_W) / 2, top: (ROW_H - spec.height) / 2, transform: cell.flipped ? "scaleY(-1)" : undefined }}>
                                <PortGlyph media={cell.media} />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS (all prior EditorCanvas tests + the 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: EditorCanvas per-port select targets + blue highlight overlay"
```

---

## Task 3: EditorCanvas — spacing handle

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: `maxSpacing` from `./portGroupOps`.
- Produces: `EditorCanvas` gains `onSpacing?: (id: string, spacing: { colSpacing: number; rowSpacing: number }) => void`. For the selected group it renders a bottom-right handle (`data-testid="spacing-handle"`); pointer-drag computes the clamp once (via `maxSpacing`) and calls `onSpacing` live on move.

- [ ] **Step 1: Write the failing test**

Append to `src/features/device-library/editor/EditorCanvas.test.tsx`:

```tsx
describe("EditorCanvas spacing handle", () => {
  it("drags to increase spacing, clamped to the max", () => {
    const onSpacing = vi.fn();
    // group: 3 cols at gridX 0 in a 19in rack-mounted frame (bodyWidthPx 912) → plenty of room
    const face: Face = { portGroups: [grp({ id: "g1", cols: 3, gridX: 0, gridY: 0 })], elements: [] };
    const { getByTestId } = render(
      <EditorCanvas face={face} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSpacing={onSpacing} />,
    );
    const handle = getByTestId("spacing-handle");
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 130, clientY: 100 }); // +30 horizontal
    expect(onSpacing).toHaveBeenCalled();
    const last = onSpacing.mock.calls[onSpacing.mock.calls.length - 1][1];
    expect(last.colSpacing).toBeCloseTo(30, 5);
    fireEvent.pointerUp(window, { clientX: 130, clientY: 100 });
  });

  it("does not spread a single-column group (maxCol 0)", () => {
    const onSpacing = vi.fn();
    const face: Face = { portGroups: [grp({ id: "g1", cols: 1, rows: 1, gridX: 0, gridY: 0 })], elements: [] };
    const { getByTestId } = render(
      <EditorCanvas face={face} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSpacing={onSpacing} />,
    );
    fireEvent.pointerDown(getByTestId("spacing-handle"), { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 200, clientY: 200 });
    const last = onSpacing.mock.calls[onSpacing.mock.calls.length - 1][1];
    expect(last.colSpacing).toBe(0);
    expect(last.rowSpacing).toBe(0);
    fireEvent.pointerUp(window, { clientX: 200, clientY: 200 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — no `spacing-handle` / `onSpacing`.

- [ ] **Step 3: Implement**

In `EditorCanvas.tsx`, add the import:

```tsx
import { maxSpacing, type Pos } from "./portGroupOps";
```
(merge with the existing `import type { Pos } from "./portGroupOps";` — replace it with the line above.)

Add `onSpacing` to `EditorCanvasProps`:

```tsx
  onSpacing?: (id: string, spacing: { colSpacing: number; rowSpacing: number }) => void;
```

Add spacing-drag state and a window listener (near the existing `drag` state/effect):

```tsx
  const bounds = { width: dims.bodyWidthPx, height: dims.heightPx };
  const [spaceDrag, setSpaceDrag] = useState<
    { id: string; startX: number; startY: number; grabCol: number; grabRow: number; maxCol: number; maxRow: number } | null
  >(null);

  useEffect(() => {
    if (!spaceDrag) return;
    function onMove(e: PointerEvent) {
      const s = spaceDrag!;
      const colSpacing = Math.max(0, Math.min(s.maxCol, s.grabCol + (e.clientX - s.startX)));
      const rowSpacing = Math.max(0, Math.min(s.maxRow, s.grabRow + (e.clientY - s.startY)));
      props.onSpacing?.(s.id, { colSpacing, rowSpacing });
    }
    function onUp() { setSpaceDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [spaceDrag, props]);
```

Inside the `{selected && ( ... )}` block (after the chevrons), render the handle:

```tsx
                    {props.onSpacing && (
                      <div
                        data-testid="spacing-handle"
                        title="Drag to change spacing"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          const { maxCol, maxRow } = maxSpacing(face, g, bounds);
                          setSpaceDrag({ id: g.id, startX: e.clientX, startY: e.clientY, grabCol: g.colSpacing, grabRow: g.rowSpacing, maxCol, maxRow });
                        }}
                        style={{ position: "absolute", right: -7, bottom: -7, width: 14, height: 14, borderRadius: "50%", background: "#2d5bff", border: "1.5px solid #fff", cursor: "nwse-resize", zIndex: 7 }}
                      />
                    )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS. (The handle's `onPointerDown` calls `e.stopPropagation()` so it does not start a group move.)

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: EditorCanvas spacing handle (clamped live spread)"
```

---

## Task 4: EditorCanvas — live move-follow + red overlap outline

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: `wouldOverlapAt` from `./portGroupOps`.
- Produces: during a group move-drag the dragged box follows the pointer live and shows a red outline + a `data-testid="move-invalid"` marker when the current position would overlap or exceed the grid. Committing on release is unchanged (`onMove` → `movePortGroup`).

- [ ] **Step 1: Write the failing test**

Append to `src/features/device-library/editor/EditorCanvas.test.tsx`:

```tsx
describe("EditorCanvas live move feedback", () => {
  it("shows a red-invalid marker when dragging a group onto another", () => {
    const twoGroups: Face = {
      portGroups: [grp({ id: "g1", gridX: 0, gridY: 0 }), grp({ id: "g2", cols: 1, gridX: 200, gridY: 0 })],
      elements: [],
    };
    const { getByTestId, queryByTestId } = render(
      <EditorCanvas face={twoGroups} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g2" onSelect={() => {}} onMove={() => {}} />,
    );
    const box = getByTestId("group-box-g2");
    // drag g2 (at gridX 200) left onto g1 (at gridX 0)
    fireEvent.pointerDown(box, { clientX: 200, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 5, clientY: 20 }); // now near gridX 5 → overlaps g1
    expect(queryByTestId("move-invalid")).not.toBeNull();
    fireEvent.pointerUp(window, { clientX: 5, clientY: 20 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — no `move-invalid` / no live tracking.

- [ ] **Step 3: Implement**

Extend the move-drag to track the live pointer. Change the `drag` state to include the live delta, and add a `pointermove` listener. Replace the existing `drag` state declaration + its effect with:

```tsx
  const [drag, setDrag] = useState<
    { id: string; startX: number; startY: number; origX: number; origY: number; dx: number; dy: number } | null
  >(null);

  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      setDrag((d) => (d ? { ...d, dx: e.clientX - d.startX, dy: e.clientY - d.startY } : d));
    }
    function onUp(e: PointerEvent) {
      const dx = e.clientX - drag!.startX;
      const dy = e.clientY - drag!.startY;
      if (dx !== 0 || dy !== 0) {
        props.onMove?.(drag!.id, { x: drag!.origX + dx, y: drag!.origY + dy });
      }
      setDrag(null);
    }
    function onCancel() { setDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [drag, props]);
```

Update the `onPointerDown` on the group box to seed `dx: 0, dy: 0`:

```tsx
                  setDrag({ id: g.id, startX: e.clientX, startY: e.clientY, origX: g.gridX, origY: g.gridY, dx: 0, dy: 0 });
```

In the group-box rendering, compute the live-move visuals for the dragging group. Just before the box `return (`, add:

```tsx
            const dragging = drag?.id === g.id;
            const liveX = dragging ? g.gridX + drag!.dx : g.gridX;
            const liveY = dragging ? g.gridY + drag!.dy : g.gridY;
            const invalid = dragging && wouldOverlapAt(face, g, { x: liveX, y: liveY }, bounds);
```

Change the box `left`/`top` to follow the live position, and the border to red when invalid:

```tsx
                  left: (earX + liveX) - SEL_PAD,
                  top: liveY - SEL_PAD,
                  ...
                  border: invalid ? "1.5px solid #dc2626" : selected ? "1.5px solid #2d5bff" : "1.5px solid transparent",
```

And render the invalid marker inside the box when dragging-invalid:

```tsx
                {invalid && <div data-testid="move-invalid" style={{ display: "none" }} />}
```

Add the import:

```tsx
import { maxSpacing, wouldOverlapAt, type Pos } from "./portGroupOps";
```
(merge into the Task 3 import line.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS (all EditorCanvas tests, including the prior drag-commit test — commit-on-release still fires because `onUp` reads the final client coords).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: EditorCanvas live move-follow + red would-overlap outline"
```

---

## Task 5: PortSettings panel

**Files:**
- Create: `src/features/device-library/editor/PortSettings.tsx`
- Test: `src/features/device-library/editor/PortSettings.test.tsx`

**Interfaces:**
- Produces: `PortSettings({ portLabel, name, flipped, onChange }: { portLabel: string; name: string; flipped: boolean; onChange: (patch: { name?: string; flipped?: boolean }) => void }): JSX.Element`. Root `data-testid="port-settings"`. Name input labelled "Port name"; Flip toggle button `data-testid="port-flip"`. The name input passes `name: value || undefined` (empty → undefined).

- [ ] **Step 1: Write the failing tests**

Create `src/features/device-library/editor/PortSettings.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortSettings } from "./PortSettings";

describe("PortSettings", () => {
  it("shows the port label and current name", () => {
    render(<PortSettings portLabel="03" name="UPLINK" flipped={false} onChange={() => {}} />);
    expect(screen.getByTestId("port-settings")).toHaveTextContent(/port 03/i);
    expect(screen.getByLabelText(/port name/i)).toHaveValue("UPLINK");
  });

  it("emits the typed name", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="" flipped={false} onChange={onChange} />);
    await user.type(screen.getByLabelText(/port name/i), "A");
    expect(onChange).toHaveBeenLastCalledWith({ name: "A" });
  });

  it("emits undefined when the name is cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="X" flipped={false} onChange={onChange} />);
    await user.clear(screen.getByLabelText(/port name/i));
    expect(onChange).toHaveBeenLastCalledWith({ name: undefined });
  });

  it("toggles flip", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="" flipped={false} onChange={onChange} />);
    await user.click(screen.getByTestId("port-flip"));
    expect(onChange).toHaveBeenLastCalledWith({ flipped: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/PortSettings.test.tsx`
Expected: FAIL — cannot resolve `./PortSettings`.

- [ ] **Step 3: Write the implementation**

Create `src/features/device-library/editor/PortSettings.tsx`:

```tsx
"use client";

export function PortSettings({
  portLabel, name, flipped, onChange,
}: {
  portLabel: string;
  name: string;
  flipped: boolean;
  onChange: (patch: { name?: string; flipped?: boolean }) => void;
}) {
  return (
    <div data-testid="port-settings" className="mt-4 rounded-xl border border-neutral-200 p-4">
      <div className="mb-3 text-sm font-bold">Port {portLabel}</div>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col text-xs font-semibold text-neutral-600">
          Port name
          <input
            className="mt-1 h-9 w-40 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
            value={name}
            onChange={(e) => onChange({ name: e.target.value || undefined })}
          />
        </label>
        <button
          type="button"
          data-testid="port-flip"
          aria-pressed={flipped}
          onClick={() => onChange({ flipped: !flipped })}
          className="flex h-9 items-center gap-2 rounded-lg border border-neutral-200 px-3 text-xs font-semibold"
        >
          Flip
          <span className={`inline-block h-4 w-8 rounded-full ${flipped ? "bg-blue-600" : "bg-neutral-300"}`} />
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/PortSettings.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/PortSettings.tsx src/features/device-library/editor/PortSettings.test.tsx
git commit -m "feat: PortSettings panel (per-port name + flip)"
```

---

## Task 6: Wire per-port + spacing into RackDeviceEditor + verification

**Files:**
- Modify: `src/features/device-library/editor/RackDeviceEditor.tsx`
- Modify: `src/features/device-library/editor/RackDeviceEditor.test.tsx`

**Interfaces:**
- Consumes: `EditorCanvas` (now with `selectedPortIndex`/`onSelectPort`/`onSpacing`), `PortSettings`, `portGroupOps` (`setPortOverride`, `setSpacing`), `useDeviceDraft` (`setActiveFace`).
- Produces: the editor supports per-port select/name/flip and the spacing handle. `selectedPortIndex` state; `PortSettings` shown when a port is selected (alongside the group settings); port selection clears when the group changes, the side switches, or the group is deleted.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/RackDeviceEditor.test.tsx`:

```tsx
describe("RackDeviceEditor — per-port editing", () => {
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

  it("selecting a port shows the port panel", () => {
    withGroup();
    // select the group first
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-1"));
    expect(screen.getByTestId("port-settings")).toBeInTheDocument();
  });

  it("typing a port name updates the rendered label", async () => {
    const user = userEvent.setup();
    withGroup();
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    await user.type(screen.getByLabelText(/port name/i), "WAN");
    expect(screen.getByText("WAN")).toBeInTheDocument();
  });

  it("switching Front/Back clears the port selection", async () => {
    const user = userEvent.setup();
    withGroup();
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    expect(screen.getByTestId("port-settings")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.queryByTestId("port-settings")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: FAIL — port targets/panel not wired.

- [ ] **Step 3: Wire `RackDeviceEditor.tsx`**

Add imports:

```tsx
import { PortSettings } from "./PortSettings";
import {
  addPortGroup, movePortGroup, addColumn, addRow, updatePortGroup, deletePortGroup,
  setPortOverride, setSpacing, type GridBounds,
} from "./portGroupOps";
import { layoutPortGroup } from "@/domain/faceplate-geometry";
```
(merge the `setPortOverride, setSpacing` into the existing `portGroupOps` import; add `layoutPortGroup` — used to resolve the selected port's label for the panel.)

Add `selectedPortIndex` state (next to `selectedGroupId`):

```tsx
  const [selectedPortIndex, setSelectedPortIndex] = useState<number | null>(null);
```

Update `switchSide` to also clear the port, and clear the port whenever the group selection changes. Replace `switchSide` and add a `selectGroup` helper:

```tsx
  function selectGroup(id: string | null) {
    setSelectedGroupId(id);
    setSelectedPortIndex(null);
  }

  function switchSide(next: "front" | "back") {
    setSelectedGroupId(null);
    setSelectedPortIndex(null);
    setActiveSide(next);
  }
```

In the `EditorCanvas` usage: change `onSelect={setSelectedGroupId}` to `onSelect={selectGroup}`, and add the per-port + spacing props:

```tsx
              selectedPortIndex={selectedPortIndex}
              onSelectPort={setSelectedPortIndex}
              onSpacing={(id, spacing) => setActiveFace(setSpacing(activeFace, id, spacing))}
```

In the `onCreate` callback, replace `setSelectedGroupId(...)` with `selectGroup(...)` (keep clearing the port on create). In the `onDelete` of `PortGroupSettings`, also clear the port: replace `setSelectedGroupId(null)` with `selectGroup(null)`.

Compute the selected port + its resolved label, and render `PortSettings` when a port is selected. After the `PortGroupSettings`/placeholder block, add:

```tsx
        {selectedGroup && selectedPortIndex !== null && (() => {
          const cell = layoutPortGroup(selectedGroup).cells.find((c) => c.index === selectedPortIndex);
          const ov = selectedGroup.portOverrides[selectedPortIndex] ?? {};
          return (
            <PortSettings
              portLabel={cell ? cell.label : String(selectedPortIndex + 1)}
              name={ov.name ?? ""}
              flipped={ov.flipped ?? false}
              onChange={(patch) => setActiveFace(setPortOverride(activeFace, selectedGroup.id, selectedPortIndex, patch))}
            />
          );
        })()}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: PASS (3a/3b editor tests + the 3 new).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all prior tests plus Tasks 1–6.

- [ ] **Step 6: Browser verification (controller)**

With Supabase running, start the dev server and open `/device-library` → Create. Verify:
- Build a group (drag copper, add columns), select it → drag the **bottom-right handle**: ports spread horizontally/vertically and **hard-stop** at the grid edge / a neighbouring group.
- Click a single **port** → its label+icon turn **blue**; the port panel appears. Type a name → the preview label changes; toggle **Flip** → that glyph mirrors, its number stays put.
- Click the group background → the port deselects (panel hides), the group stays selected.
- Drag a group toward another → the box **follows live** and its outline turns **red** over an overlapping position; release → it nudges to a free spot.
- Switch Front/Back → port selection clears.
- **Save**, reopen via **Edit** → spacing + port names + flips persist.
- Screenshot a finished multi-group device.

- [ ] **Step 7: Commit + finish the branch**

```bash
git add src/features/device-library/editor/RackDeviceEditor.tsx src/features/device-library/editor/RackDeviceEditor.test.tsx
git commit -m "feat: wire per-port editing + spacing handle into the Rack Device Editor"
```

Then run `superpowers:requesting-code-review` (whole-branch), address findings, and `superpowers:finishing-a-development-branch` to open the stacked PR (base = `phase-2a-slice-3b`). Update `docs/superpowers/notes/RESUME.md` and project memory: Slice 3c done → Phase 2a editor complete; Slice 4 (Text/Icon elements) next.

---

## Self-Review

**Spec coverage:**
- Selection model (`selectedGroupId` + `selectedPortIndex`), clears on group/side change → Tasks 2, 6. ✅
- Blue highlight via overlay blue copy; Faceplate untouched → Task 2. ✅
- Per-port click targets → Task 2; name+flip panel → Task 5; name/flip flow through `portOverrides`/`setActiveFace` → Task 6. ✅
- Name-clearing stores `undefined` → Task 5 (`value || undefined`). ✅
- Spacing handle: grab-time clamp (grid + neighbours) via `maxSpacing`, live spread, hard stop, single-row/col → 0 → Tasks 1, 3. ✅
- Live group-move follow + red outline via `wouldOverlapAt` → Tasks 1, 4. ✅
- Group-level controls stay visible while a port is selected (handle/chevrons under `{selected}`) → Tasks 2–4. ✅
- No persistence change (jsonb already carries spacing/overrides) → Task 6. ✅
- Deferred (Text/Icon elements) correctly absent. ✅

**Placeholder scan:** No TODO/TBD. The `move-invalid` marker is an intentional `display:none` test/aria hook (the visible signal is the red border); complete code given. All tests concrete.

**Type consistency:** `setPortOverride`/`setSpacing`/`maxSpacing`/`wouldOverlapAt` (Task 1) are used identically in Tasks 3, 4, 6. `EditorCanvas` new props (`selectedPortIndex`, `onSelectPort`, `onSpacing`) match across Tasks 2, 3, 6. `PortSettings` prop shape matches Task 6's usage. `GridBounds`/`Pos` reused from 3b. `layoutPortGroup` cell fields (`index`, `x`, `y`, `label`, `flipped`, `media`) and `PORT_GLYPHS[media].height`/`GLYPH_W`/`CELL_W`/`ROW_H` come from the existing Slice-2 modules.
```
