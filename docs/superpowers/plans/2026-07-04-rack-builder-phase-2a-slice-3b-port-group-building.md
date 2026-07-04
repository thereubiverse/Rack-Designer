# Phase 2a · Slice 3b — Port-Group Building Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor grid interactive — drag a port type onto the live preview to create a group, drag a group to move it, select a group, grow it with edge chevrons, edit it via the Port Group Settings panel, and delete it — all mutating the 3a draft so Save persists it unchanged.

**Architecture:** Pure face transforms live in a new `portGroupOps.ts` (no React), unit-tested. The interactive controls are an **overlay** absolutely-positioned over the pure, read-only `Faceplate` SVG inside `EditorCanvas` (Faceplate stays untouched), positioned from the same `layoutPortGroup` geometry. `RackDeviceEditor` wires drag/drop/select/settings to the ops via `useDeviceDraft.setActiveFace`.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, HTML5 drag-and-drop + Pointer Events, Vitest 2 + @testing-library/react (jsdom).

## Global Constraints

- **Next.js 16 + React 19 + TypeScript 5**; path alias `@/` → `src/`.
- **`Faceplate` stays pure/read-only** (reused by Phase 2b) — all interactivity is an overlay layered over it; never edit `Faceplate`/`faceplate-geometry`.
- **Overlaps are not allowed.** Create and move **nudge to the nearest free, in-bounds position** via a deterministic 8px-grid ring-search. Chevron growth never nudges — it is a **no-op** if it would exceed the grid or overlap a neighbor.
- **8px snapping** for placement (`SNAP = 8`). **New-group defaults:** `connectorType = CONNECTORS[media][0]`, `idPrefix = ""`, `countingDirection = "ltr"`, `rows = cols = 1`, `colSpacing = rowSpacing = 0`, `portOverrides = {}`, `id = crypto.randomUUID()`.
- **All group mutations go through `useDeviceDraft.setActiveFace`** (writes the active side). `selectedGroupId` is transient editor state, not persisted. No persistence changes (3a's Save already writes `front_face`/`back_face`).
- **Collision uses each group's port-cell footprint** (`layoutPortGroup` width/height at `gridX/gridY`); the visual selection box adds a few px padding to wrap number labels.
- **GridBounds** (the editable body area, in body-local px) = `{ width: frameDims(...).bodyWidthPx, height: frameDims(...).heightPx }`; groups clamp so their full bounds fit `[0,width] × [0,height]`.
- **Overlay ↔ SVG mapping is 1:1** (SVG rendered at natural px). A group at body-local `(gridX, gridY)` renders in the overlay at `left = earWidthPx + gridX`, `top = gridY`.
- Switching Front/Back **deselects**. Deferred to 3c/4: spacing handle, per-port select/flip, Text/Icon elements.
- Tests: Vitest, `describe/it/expect`, one behavior per `it`. `npm test`. Do **not** run `npm run lint` (pre-existing repo-wide failure).
- Work on branch `phase-2a-slice-3b` (already cut from `phase-2a-slice-3a`).
- TDD, DRY, YAGNI, frequent commits.

---

## File Structure

- **Create** `src/features/device-library/editor/portGroupOps.ts` (+ `.test.ts`) — pure geometry helpers (Task 1) + face mutations (Task 2).
- **Modify** `src/features/device-library/editor/EditorCanvas.tsx` (+ `.test.tsx`) — add the optional edit-mode overlay: selection boxes, click-select, drop-to-create, chevrons (Task 3), then pointer drag-to-move (Task 4). Backwards-compatible: no overlay controls when edit props are absent.
- **Create** `src/features/device-library/editor/PortGroupSettings.tsx` (+ `.test.tsx`) — the settings panel (Task 5).
- **Modify** `src/features/device-library/editor/RackDeviceEditor.tsx` (+ its test) — draggable palette, `selectedGroupId`, wire overlay callbacks → ops → `setActiveFace`, mount settings, deselect on side switch (Task 6).

---

## Task 1: Placement geometry helpers (portGroupOps part 1)

**Files:**
- Create: `src/features/device-library/editor/portGroupOps.ts`
- Test: `src/features/device-library/editor/portGroupOps.test.ts`

**Interfaces:**
- Consumes: `layoutPortGroup` from `@/domain/faceplate-geometry`; `Face`, `PortGroup` from `@/domain/faceplate`.
- Produces:
  - `interface Pos { x: number; y: number }`, `interface Rect { x: number; y: number; width: number; height: number }`, `interface GridBounds { width: number; height: number }`
  - `const SNAP = 8`
  - `groupBounds(group: PortGroup): Rect`
  - `wouldOverlap(face: Face, candidate: PortGroup, excludeId?: string): boolean`
  - `findFreePosition(face: Face, group: PortGroup, desired: Pos, bounds: GridBounds, excludeId?: string): Pos | null`

- [ ] **Step 1: Write the failing tests**

Create `src/features/device-library/editor/portGroupOps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { groupBounds, wouldOverlap, findFreePosition, SNAP, type GridBounds } from "./portGroupOps";
import type { Face, PortGroup } from "@/domain/faceplate";

function group(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}
const bounds: GridBounds = { width: 400, height: 84 };

describe("groupBounds", () => {
  it("is the cell footprint at the group's gridX/gridY (1x1 = 24x24)", () => {
    expect(groupBounds(group({ gridX: 10, gridY: 5 }))).toEqual({ x: 10, y: 5, width: 24, height: 24 });
  });
  it("grows with cols/rows", () => {
    expect(groupBounds(group({ cols: 3, rows: 2 }))).toMatchObject({ width: 72, height: 48 });
  });
});

describe("wouldOverlap", () => {
  const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
  it("detects an overlapping candidate", () => {
    expect(wouldOverlap(face, group({ id: "b", gridX: 10, gridY: 0 }))).toBe(true);
  });
  it("clears a non-overlapping candidate", () => {
    expect(wouldOverlap(face, group({ id: "b", gridX: 40, gridY: 0 }))).toBe(false);
  });
  it("excludes the group itself by id", () => {
    expect(wouldOverlap(face, group({ id: "a", gridX: 0, gridY: 0 }), "a")).toBe(false);
  });
});

describe("findFreePosition", () => {
  it("snaps the desired position to the 8px grid when free", () => {
    const face: Face = { portGroups: [], elements: [] };
    expect(findFreePosition(face, group(), { x: 11, y: 3 }, bounds)).toEqual({ x: 8, y: 0 });
  });
  it("clamps within the grid bounds", () => {
    const face: Face = { portGroups: [], elements: [] };
    // desired far right; 1x1 (24 wide) must fit within width 400 → max x = 376
    expect(findFreePosition(face, group(), { x: 999, y: 999 }, bounds)).toEqual({ x: 376, y: 60 });
  });
  it("nudges to the nearest free spot when the target overlaps", () => {
    const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
    const free = findFreePosition(face, group({ id: "b" }), { x: 0, y: 0 }, bounds, "b");
    expect(free).not.toBeNull();
    expect(wouldOverlap(face, group({ id: "b", gridX: free!.x, gridY: free!.y }), "b")).toBe(false);
  });
  it("returns null when the grid is full", () => {
    // a single 1x1 cell grid fully occupied
    const tiny: GridBounds = { width: 24, height: 24 };
    const face: Face = { portGroups: [group({ id: "a", gridX: 0, gridY: 0 })], elements: [] };
    expect(findFreePosition(face, group({ id: "b" }), { x: 0, y: 0 }, tiny, "b")).toBeNull();
  });
});

describe("SNAP", () => {
  it("is 8", () => { expect(SNAP).toBe(8); });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/portGroupOps.test.ts`
Expected: FAIL — cannot resolve `./portGroupOps`.

- [ ] **Step 3: Write the implementation**

Create `src/features/device-library/editor/portGroupOps.ts`:

```ts
import { layoutPortGroup } from "@/domain/faceplate-geometry";
import type { Face, PortGroup } from "@/domain/faceplate";

export interface Pos { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface GridBounds { width: number; height: number }

export const SNAP = 8;

export function groupBounds(group: PortGroup): Rect {
  const laid = layoutPortGroup(group);
  return { x: group.gridX, y: group.gridY, width: laid.width, height: laid.height };
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x
    && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function wouldOverlap(face: Face, candidate: PortGroup, excludeId?: string): boolean {
  const cb = groupBounds(candidate);
  return face.portGroups.some((g) => g.id !== excludeId && rectsOverlap(cb, groupBounds(g)));
}

function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

function clamp(bounds: GridBounds, w: number, h: number, p: Pos): Pos {
  return {
    x: Math.max(0, Math.min(p.x, bounds.width - w)),
    y: Math.max(0, Math.min(p.y, bounds.height - h)),
  };
}

/** Nearest free, in-bounds, 8px-snapped position to `desired`; null if the grid is full. */
export function findFreePosition(
  face: Face, group: PortGroup, desired: Pos, bounds: GridBounds, excludeId?: string,
): Pos | null {
  const laid = layoutPortGroup(group);
  const w = laid.width, h = laid.height;
  const tryAt = (p: Pos): Pos | null => {
    const c = clamp(bounds, w, h, { x: snap(p.x), y: snap(p.y) });
    const candidate: PortGroup = { ...group, gridX: c.x, gridY: c.y };
    return wouldOverlap(face, candidate, excludeId) ? null : c;
  };
  const direct = tryAt(desired);
  if (direct) return direct;

  const maxR = Math.ceil(Math.max(bounds.width, bounds.height) / SNAP) + 1;
  const seen = new Set<string>();
  for (let r = 1; r <= maxR; r++) {
    const ring: { p: Pos; d: number }[] = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p = { x: snap(desired.x) + dx * SNAP, y: snap(desired.y) + dy * SNAP };
        ring.push({ p, d: Math.hypot(p.x - desired.x, p.y - desired.y) });
      }
    }
    ring.sort((a, b) => a.d - b.d || a.p.y - b.p.y || a.p.x - b.p.x);
    for (const { p } of ring) {
      const ok = tryAt(p);
      if (!ok) continue;
      const key = `${ok.x},${ok.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      return ok;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/portGroupOps.test.ts`
Expected: PASS (all Task 1 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/portGroupOps.ts src/features/device-library/editor/portGroupOps.test.ts
git commit -m "feat: port-group placement geometry (bounds, overlap, nearest-free)"
```

---

## Task 2: Face mutations (portGroupOps part 2)

**Files:**
- Modify: `src/features/device-library/editor/portGroupOps.ts` (append)
- Test: `src/features/device-library/editor/portGroupOps.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 helpers; `CONNECTORS`, `Media`, `Face`, `PortGroup` from `@/domain/faceplate`.
- Produces:
  - `addPortGroup(face: Face, media: Media, pos: Pos, bounds: GridBounds): Face`
  - `movePortGroup(face: Face, id: string, pos: Pos, bounds: GridBounds): Face`
  - `addColumn(face: Face, id: string, bounds: GridBounds): Face`
  - `addRow(face: Face, id: string, bounds: GridBounds): Face`
  - `updatePortGroup(face: Face, id: string, patch: Partial<Pick<PortGroup, "idPrefix" | "countingDirection" | "connectorType">>): Face`
  - `deletePortGroup(face: Face, id: string): Face`

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/portGroupOps.test.ts`:

```ts
import {
  addPortGroup, movePortGroup, addColumn, addRow, updatePortGroup, deletePortGroup,
} from "./portGroupOps";

describe("addPortGroup", () => {
  it("appends a 1-port group with the media's default connector at the snapped position", () => {
    const face: Face = { portGroups: [], elements: [] };
    const next = addPortGroup(face, "sfp", { x: 33, y: 9 }, bounds);
    expect(next.portGroups).toHaveLength(1);
    const g = next.portGroups[0];
    expect(g).toMatchObject({ media: "sfp", connectorType: "SFP", cols: 1, rows: 1, gridX: 32, gridY: 8 });
    expect(g.id).toBeTruthy();
  });
  it("nudges the new group off an existing one at the same spot", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const next = addPortGroup(face, "copper", { x: 0, y: 0 }, bounds);
    expect(next.portGroups).toHaveLength(2);
    expect(wouldOverlap({ portGroups: [next.portGroups[0]], elements: [] }, next.portGroups[1])).toBe(false);
  });
  it("cancels (no group added) when the grid is full", () => {
    const tiny: GridBounds = { width: 24, height: 24 };
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, tiny);
    const next = addPortGroup(face, "copper", { x: 0, y: 0 }, tiny);
    expect(next.portGroups).toHaveLength(1);
  });
});

describe("movePortGroup", () => {
  it("relocates the group to the snapped target", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    // 104 and 32 are already on the 8px grid, so they pass through unchanged
    const next = movePortGroup(face, id, { x: 104, y: 32 }, bounds);
    expect(next.portGroups[0]).toMatchObject({ gridX: 104, gridY: 32 });
  });
});

describe("addColumn / addRow", () => {
  it("adds a column / a row", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    expect(addColumn(face, id, bounds).portGroups[0].cols).toBe(2);
    expect(addRow(face, id, bounds).portGroups[0].rows).toBe(2);
  });
  it("is a no-op when growth would exceed the grid width", () => {
    const narrow: GridBounds = { width: 24, height: 84 };
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, narrow);
    const id = face.portGroups[0].id;
    expect(addColumn(face, id, narrow).portGroups[0].cols).toBe(1);
  });
  it("is a no-op when growth would overlap a neighbor", () => {
    let face: Face = { portGroups: [], elements: [] };
    face = addPortGroup(face, "copper", { x: 0, y: 0 }, bounds);      // at 0,0 (24 wide)
    const id = face.portGroups[0].id;
    face = addPortGroup(face, "copper", { x: 24, y: 0 }, bounds);     // immediately to its right
    expect(addColumn(face, id, bounds).portGroups.find((g) => g.id === id)!.cols).toBe(1);
  });
});

describe("updatePortGroup / deletePortGroup", () => {
  it("patches only the allowed fields", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    const next = updatePortGroup(face, id, { idPrefix: "Gi", countingDirection: "rtl", connectorType: "Keystone" });
    expect(next.portGroups[0]).toMatchObject({ idPrefix: "Gi", countingDirection: "rtl", connectorType: "Keystone" });
  });
  it("deletes by id", () => {
    const face = addPortGroup({ portGroups: [], elements: [] }, "copper", { x: 0, y: 0 }, bounds);
    const id = face.portGroups[0].id;
    expect(deletePortGroup(face, id).portGroups).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/portGroupOps.test.ts`
Expected: FAIL — `addPortGroup` etc. not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/features/device-library/editor/portGroupOps.ts` (add the import at the top of the file next to the existing imports):

```ts
import { CONNECTORS, type Media } from "@/domain/faceplate";
```

Append:

```ts
export function addPortGroup(face: Face, media: Media, pos: Pos, bounds: GridBounds): Face {
  const base: PortGroup = {
    id: crypto.randomUUID(),
    media,
    connectorType: CONNECTORS[media][0],
    idPrefix: "",
    countingDirection: "ltr",
    rows: 1, cols: 1,
    gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0,
    portOverrides: {},
  };
  const free = findFreePosition(face, base, pos, bounds);
  if (!free) return face;
  return { ...face, portGroups: [...face.portGroups, { ...base, gridX: free.x, gridY: free.y }] };
}

export function movePortGroup(face: Face, id: string, pos: Pos, bounds: GridBounds): Face {
  const g = face.portGroups.find((x) => x.id === id);
  if (!g) return face;
  const free = findFreePosition(face, g, pos, bounds, id);
  if (!free) return face;
  return {
    ...face,
    portGroups: face.portGroups.map((x) => (x.id === id ? { ...x, gridX: free.x, gridY: free.y } : x)),
  };
}

function grow(face: Face, id: string, bounds: GridBounds, delta: { cols?: number; rows?: number }): Face {
  const g = face.portGroups.find((x) => x.id === id);
  if (!g) return face;
  const grown: PortGroup = { ...g, cols: g.cols + (delta.cols ?? 0), rows: g.rows + (delta.rows ?? 0) };
  const b = groupBounds(grown);
  if (b.x + b.width > bounds.width || b.y + b.height > bounds.height) return face;
  if (wouldOverlap(face, grown, id)) return face;
  return { ...face, portGroups: face.portGroups.map((x) => (x.id === id ? grown : x)) };
}

export function addColumn(face: Face, id: string, bounds: GridBounds): Face {
  return grow(face, id, bounds, { cols: 1 });
}

export function addRow(face: Face, id: string, bounds: GridBounds): Face {
  return grow(face, id, bounds, { rows: 1 });
}

export function updatePortGroup(
  face: Face, id: string,
  patch: Partial<Pick<PortGroup, "idPrefix" | "countingDirection" | "connectorType">>,
): Face {
  return { ...face, portGroups: face.portGroups.map((x) => (x.id === id ? { ...x, ...patch } : x)) };
}

export function deletePortGroup(face: Face, id: string): Face {
  return { ...face, portGroups: face.portGroups.filter((x) => x.id !== id) };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/portGroupOps.test.ts`
Expected: PASS (Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/portGroupOps.ts src/features/device-library/editor/portGroupOps.test.ts
git commit -m "feat: port-group face mutations (add/move/grow/update/delete)"
```

---

## Task 3: EditorCanvas overlay — select, drop-to-create, chevrons

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: `frameDims`, `layoutPortGroup` from `@/domain/faceplate-geometry`; `Pos` from `./portGroupOps`; `Face`, `Media`, `MEDIA` from `@/domain/faceplate`.
- Produces: `EditorCanvas` gains optional edit props (all optional — when none supplied it renders exactly as in 3a):
  - `selectedGroupId?: string | null`
  - `onCreate?: (media: Media, pos: Pos) => void`
  - `onSelect?: (id: string | null) => void`
  - `onAddColumn?: (id: string) => void`
  - `onAddRow?: (id: string) => void`
  - Test hooks: overlay `data-testid="editor-overlay"`; per-group box `data-testid="group-box-<id>"` (with `data-selected="true|false"`); chevrons `data-testid="chevron-col"` / `data-testid="chevron-row"`.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/EditorCanvas.test.tsx` (add `fireEvent`, `vi`, and the `Face`/`PortGroup` imports as needed):

```tsx
import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";
import type { Face, PortGroup } from "@/domain/faceplate";

function grp(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 3, gridX: 20, gridY: 20,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}
const faceWithGroup: Face = { portGroups: [grp()], elements: [] };

describe("EditorCanvas overlay", () => {
  it("has no overlay controls in pure-preview mode (no edit props)", () => {
    const { queryByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" />,
    );
    expect(queryByTestId("editor-overlay")).toBeNull();
  });

  it("renders a selectable box per group and fires onSelect", () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" onSelect={onSelect} />,
    );
    fireEvent.click(getByTestId("group-box-g1"));
    expect(onSelect).toHaveBeenCalledWith("g1");
  });

  it("clicking empty overlay space deselects", () => {
    const onSelect = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" onSelect={onSelect} />,
    );
    fireEvent.click(getByTestId("editor-overlay"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("marks the selected group's box", () => {
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" selectedGroupId="g1" onSelect={() => {}} />,
    );
    expect(getByTestId("group-box-g1").getAttribute("data-selected")).toBe("true");
  });

  it("shows chevrons on the selected group and fires add column/row", () => {
    const onAddColumn = vi.fn();
    const onAddRow = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onAddColumn={onAddColumn} onAddRow={onAddRow} />,
    );
    fireEvent.click(getByTestId("chevron-col"));
    fireEvent.click(getByTestId("chevron-row"));
    expect(onAddColumn).toHaveBeenCalledWith("g1");
    expect(onAddRow).toHaveBeenCalledWith("g1");
  });

  it("dropping a media on the overlay fires onCreate with that media", () => {
    const onCreate = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={{ portGroups: [], elements: [] }} widthIn={19} rackUnits={1} rackMounted side="FRONT" onCreate={onCreate} />,
    );
    fireEvent.drop(getByTestId("editor-overlay"), {
      dataTransfer: { getData: () => "copper" },
      clientX: 50, clientY: 10,
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toBe("copper");
  });

  it("ignores a drop whose payload is not a known media", () => {
    const onCreate = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={{ portGroups: [], elements: [] }} widthIn={19} rackUnits={1} rackMounted side="FRONT" onCreate={onCreate} />,
    );
    fireEvent.drop(getByTestId("editor-overlay"), { dataTransfer: { getData: () => "banana" }, clientX: 5, clientY: 5 });
    expect(onCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — no `editor-overlay` / edit props unsupported.

- [ ] **Step 3: Rewrite `EditorCanvas.tsx`**

Replace `src/features/device-library/editor/EditorCanvas.tsx`:

```tsx
"use client";

import { useRef } from "react";
import { Faceplate } from "@/features/device-library/faceplate/Faceplate";
import { frameDims, layoutPortGroup } from "@/domain/faceplate-geometry";
import { MEDIA, type Face, type Media } from "@/domain/faceplate";
import type { Pos } from "./portGroupOps";

const SEL_PAD = 6; // visual padding so the selection box wraps the number labels

export interface EditorCanvasProps {
  face: Face;
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
  side: "FRONT" | "BACK";
  selectedGroupId?: string | null;
  onCreate?: (media: Media, pos: Pos) => void;
  onSelect?: (id: string | null) => void;
  onAddColumn?: (id: string) => void;
  onAddRow?: (id: string) => void;
}

export function EditorCanvas(props: EditorCanvasProps) {
  const { face, widthIn, rackUnits, rackMounted, side } = props;
  const overlayRef = useRef<HTMLDivElement>(null);
  const editing = Boolean(props.onSelect || props.onCreate);
  const dims = frameDims({ widthIn, rackUnits, rackMounted });
  const earX = dims.earWidthPx;

  function dropPos(e: React.DragEvent): Pos {
    const rect = overlayRef.current?.getBoundingClientRect();
    const left = rect ? rect.left : 0;
    const top = rect ? rect.top : 0;
    return { x: e.clientX - left - earX, y: e.clientY - top };
  }

  return (
    <div data-testid="editor-canvas" style={{ position: "relative", display: "inline-block" }}>
      <Faceplate face={face} widthIn={widthIn} rackUnits={rackUnits} rackMounted={rackMounted} side={side} />

      {editing && (
        <div
          ref={overlayRef}
          data-testid="editor-overlay"
          style={{ position: "absolute", inset: 0 }}
          onClick={() => props.onSelect?.(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const media = e.dataTransfer.getData("text/plain") as Media;
            if (props.onCreate && (MEDIA as string[]).includes(media)) {
              props.onCreate(media, dropPos(e));
            }
          }}
        >
          {face.portGroups.map((g) => {
            const laid = layoutPortGroup(g);
            const selected = g.id === props.selectedGroupId;
            const left = earX + g.gridX;
            return (
              <div
                key={g.id}
                data-testid={`group-box-${g.id}`}
                data-selected={selected ? "true" : "false"}
                onClick={(e) => { e.stopPropagation(); props.onSelect?.(g.id); }}
                style={{
                  position: "absolute",
                  left: left - SEL_PAD,
                  top: g.gridY - SEL_PAD,
                  width: laid.width + SEL_PAD * 2,
                  height: laid.height + SEL_PAD * 2,
                  cursor: "pointer",
                  borderRadius: 6,
                  border: selected ? "1.5px solid #2d5bff" : "1.5px solid transparent",
                  background: selected ? "rgba(45,91,255,0.06)" : "transparent",
                }}
              >
                {selected && (
                  <>
                    <button
                      type="button"
                      data-testid="chevron-col"
                      title="Add a column of ports"
                      onClick={(e) => { e.stopPropagation(); props.onAddColumn?.(g.id); }}
                      style={chevronStyle({ right: -8, top: "50%", translate: "0 -50%" })}
                    >›</button>
                    <button
                      type="button"
                      data-testid="chevron-row"
                      title="Add a row of ports"
                      onClick={(e) => { e.stopPropagation(); props.onAddRow?.(g.id); }}
                      style={chevronStyle({ bottom: -8, left: "50%", translate: "-50% 0" })}
                    >⌄</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function chevronStyle(pos: React.CSSProperties & { translate?: string }): React.CSSProperties {
  return {
    position: "absolute",
    width: 16, height: 16, borderRadius: "50%",
    background: "#fff", border: "1.5px solid #2d5bff", color: "#2d5bff",
    fontSize: 11, lineHeight: "13px", padding: 0, cursor: "pointer", zIndex: 6,
    ...pos,
  };
}
```

> Note: the tests pass `dataTransfer.getData: () => "copper"` ignoring the key, so `getData("text/plain")` returns the media in tests; in the browser the palette sets `text/plain` (Task 6). `MEDIA.includes` guards unknown payloads.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS (the two 3a tests + the new overlay tests). The 3a "pure preview" tests still pass because no edit props are passed there.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: EditorCanvas overlay — select, drop-to-create, edge chevrons"
```

---

## Task 4: EditorCanvas drag-to-move

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: Task 3 overlay; `Pos` from `./portGroupOps`.
- Produces: `EditorCanvas` gains `onMove?: (id: string, pos: Pos) => void`. Pointer-dragging a group box translates it live and commits `onMove(id, bodyLocalPos)` on release. The group box gets `cursor: "move"` when `onMove` is set.

- [ ] **Step 1: Write the failing test**

Append to `src/features/device-library/editor/EditorCanvas.test.tsx`:

```tsx
describe("EditorCanvas drag-to-move", () => {
  it("commits onMove with the dragged delta on pointer up", () => {
    const onMove = vi.fn();
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onMove={onMove} />,
    );
    const box = getByTestId("group-box-g1");
    fireEvent.pointerDown(box, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { clientX: 140, clientY: 108 });
    fireEvent.pointerUp(window, { clientX: 140, clientY: 108 });
    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, pos] = onMove.mock.calls[0];
    expect(id).toBe("g1");
    // group started at gridX 20, gridY 20; moved +40,+8
    expect(pos).toEqual({ x: 60, y: 28 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — `onMove` not wired (no call).

- [ ] **Step 3: Add drag-to-move to `EditorCanvas.tsx`**

Add these imports/handlers. First extend the imports and props:

```tsx
import { useRef, useState, useEffect } from "react";
```

Add `onMove` to `EditorCanvasProps`:

```tsx
  onMove?: (id: string, pos: Pos) => void;
```

Inside `EditorCanvas`, add drag state and a window listener effect (place after `const earX = ...`):

```tsx
  const [drag, setDrag] = useState<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);

  useEffect(() => {
    if (!drag) return;
    function onUp(e: PointerEvent) {
      props.onMove?.(drag!.id, {
        x: drag!.origX + (e.clientX - drag!.startX),
        y: drag!.origY + (e.clientY - drag!.startY),
      });
      setDrag(null);
    }
    window.addEventListener("pointerup", onUp);
    return () => window.removeEventListener("pointerup", onUp);
  }, [drag, props]);
```

On each group box, add a pointer-down handler that starts a drag (only when `onMove` is set). Update the box element to include:

```tsx
                onPointerDown={(e) => {
                  if (!props.onMove) return;
                  e.stopPropagation();
                  setDrag({ id: g.id, startX: e.clientX, startY: e.clientY, origX: g.gridX, origY: g.gridY });
                }}
```

And set the cursor to move when draggable: change the box `cursor` to `props.onMove ? "move" : "pointer"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS (all EditorCanvas tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: EditorCanvas drag-to-move for port groups"
```

---

## Task 5: Port Group Settings panel

**Files:**
- Create: `src/features/device-library/editor/PortGroupSettings.tsx`
- Test: `src/features/device-library/editor/PortGroupSettings.test.tsx`

**Interfaces:**
- Consumes: `CONNECTORS`, `PortGroup`, `CountingDirection`, `Media` from `@/domain/faceplate`.
- Produces: `PortGroupSettings({ group, onChange, onDelete }: { group: PortGroup; onChange: (patch: Partial<Pick<PortGroup, "idPrefix" | "countingDirection" | "connectorType">>) => void; onDelete: () => void }): JSX.Element` — the settings form. Header shows the media name. Test hooks: `data-testid="pg-settings"`, `data-testid="pg-delete"`; fields labelled "ID prefix", "Counting Direction", "Connector type".

- [ ] **Step 1: Write the failing tests**

Create `src/features/device-library/editor/PortGroupSettings.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortGroupSettings } from "./PortGroupSettings";
import type { PortGroup } from "@/domain/faceplate";

function grp(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}

describe("PortGroupSettings", () => {
  it("shows the media in the header and the media's connector options", () => {
    render(<PortGroupSettings group={grp()} onChange={() => {}} onDelete={() => {}} />);
    expect(screen.getByTestId("pg-settings")).toHaveTextContent(/copper/i);
    const connector = screen.getByLabelText(/connector type/i) as HTMLSelectElement;
    expect([...connector.options].map((o) => o.value)).toEqual(["RJ45", "RJ11", "Keystone"]);
  });

  it("emits patches for ID prefix, counting direction, connector type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortGroupSettings group={grp()} onChange={onChange} onDelete={() => {}} />);
    await user.type(screen.getByLabelText(/id prefix/i), "G");
    expect(onChange).toHaveBeenLastCalledWith({ idPrefix: "G" });
    await user.selectOptions(screen.getByLabelText(/counting direction/i), "rtl");
    expect(onChange).toHaveBeenLastCalledWith({ countingDirection: "rtl" });
    await user.selectOptions(screen.getByLabelText(/connector type/i), "Keystone");
    expect(onChange).toHaveBeenLastCalledWith({ connectorType: "Keystone" });
  });

  it("calls onDelete", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<PortGroupSettings group={grp()} onChange={() => {}} onDelete={onDelete} />);
    await user.click(screen.getByTestId("pg-delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/PortGroupSettings.test.tsx`
Expected: FAIL — cannot resolve `./PortGroupSettings`.

- [ ] **Step 3: Write the implementation**

Create `src/features/device-library/editor/PortGroupSettings.tsx`:

```tsx
"use client";

import { CONNECTORS, type PortGroup, type CountingDirection, type Media } from "@/domain/faceplate";

const MEDIA_LABELS: Record<Media, string> = {
  copper: "Copper", fiber: "Fiber", sfp: "SFP", usb_a: "USB-A", usb_c: "USB-C",
  hdmi: "HDMI", dp: "DP", vga: "VGA", ps2: "PS/2", audio: "Audio",
};

const DIRECTIONS: { value: CountingDirection; label: string }[] = [
  { value: "ttb", label: "Top-to-bottom" },
  { value: "btt", label: "Bottom-to-top" },
  { value: "ltr", label: "Left-to-right" },
  { value: "rtl", label: "Right-to-left" },
];

export function PortGroupSettings({
  group, onChange, onDelete,
}: {
  group: PortGroup;
  onChange: (patch: Partial<Pick<PortGroup, "idPrefix" | "countingDirection" | "connectorType">>) => void;
  onDelete: () => void;
}) {
  return (
    <div data-testid="pg-settings" className="mt-4 rounded-xl border border-neutral-200 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-bold">Port Group Settings — {MEDIA_LABELS[group.media]}</span>
        <button type="button" data-testid="pg-delete" onClick={onDelete} className="text-xs text-red-600">
          🗑 Delete port group
        </button>
      </div>
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col text-xs font-semibold text-neutral-600">
          ID prefix
          <input
            className="mt-1 h-9 w-28 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
            value={group.idPrefix}
            onChange={(e) => onChange({ idPrefix: e.target.value })}
          />
        </label>
        <label className="flex flex-col text-xs font-semibold text-neutral-600">
          Counting Direction
          <select
            className="mt-1 h-9 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
            value={group.countingDirection}
            onChange={(e) => onChange({ countingDirection: e.target.value as CountingDirection })}
          >
            {DIRECTIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col text-xs font-semibold text-neutral-600">
          Connector type
          <select
            className="mt-1 h-9 rounded-lg border border-neutral-200 px-2 text-sm font-normal"
            value={group.connectorType}
            onChange={(e) => onChange({ connectorType: e.target.value })}
          >
            {CONNECTORS[group.media].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/PortGroupSettings.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/PortGroupSettings.tsx src/features/device-library/editor/PortGroupSettings.test.tsx
git commit -m "feat: Port Group Settings panel"
```

---

## Task 6: Wire building into RackDeviceEditor + verification

**Files:**
- Modify: `src/features/device-library/editor/RackDeviceEditor.tsx`
- Modify: `src/features/device-library/editor/RackDeviceEditor.test.tsx`

**Interfaces:**
- Consumes: `EditorCanvas` (now edit-capable), `PortGroupSettings`, `portGroupOps` (`addPortGroup`/`movePortGroup`/`addColumn`/`addRow`/`updatePortGroup`/`deletePortGroup`, `GridBounds`), `useDeviceDraft` (`setActiveFace`), `frameDims`, `MEDIA`.
- Produces: the modal becomes a working single-group builder — draggable palette chips, `selectedGroupId` state, overlay callbacks wired to ops via `setActiveFace`, the `PortGroupSettings` panel (shown when a group is selected, else the 3a placeholder), and deselect on Front/Back switch.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/RackDeviceEditor.test.tsx` (reuse the file's existing `types`, `brands`, `noop`):

```tsx
import { fireEvent } from "@testing-library/react";

describe("RackDeviceEditor — port-group building", () => {
  it("dropping a palette media creates a group and selects it (settings appear)", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} initial={{ name: "S", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={noop} />);
    fireEvent.drop(screen.getByTestId("editor-overlay"), { dataTransfer: { getData: () => "copper" }, clientX: 60, clientY: 12 });
    expect(screen.getByTestId("pg-settings")).toBeInTheDocument();
    expect(screen.getAllByTestId("port-cell").length).toBe(1);
  });

  it("chevron adds a column (preview gains a port cell)", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} initial={{ name: "S", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={noop} />);
    fireEvent.drop(screen.getByTestId("editor-overlay"), { dataTransfer: { getData: () => "copper" }, clientX: 40, clientY: 12 });
    expect(screen.getAllByTestId("port-cell").length).toBe(1);
    fireEvent.click(screen.getByTestId("chevron-col"));
    expect(screen.getAllByTestId("port-cell").length).toBe(2);
  });

  it("deleting the selected group removes it and hides settings", () => {
    const user = userEvent.setup();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} initial={{ name: "S", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={noop} />);
    fireEvent.drop(screen.getByTestId("editor-overlay"), { dataTransfer: { getData: () => "copper" }, clientX: 40, clientY: 12 });
    expect(screen.getByTestId("pg-settings")).toBeInTheDocument();
    return user.click(screen.getByTestId("pg-delete")).then(() => {
      expect(screen.queryByTestId("pg-settings")).toBeNull();
      expect(screen.queryAllByTestId("port-cell")).toHaveLength(0);
    });
  });

  it("switching Front/Back deselects the group", async () => {
    const user = userEvent.setup();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} initial={{ name: "S", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={noop} />);
    fireEvent.drop(screen.getByTestId("editor-overlay"), { dataTransfer: { getData: () => "copper" }, clientX: 40, clientY: 12 });
    expect(screen.getByTestId("pg-settings")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.queryByTestId("pg-settings")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: FAIL — no `editor-overlay`/`pg-settings` (not wired yet).

- [ ] **Step 3: Wire `RackDeviceEditor.tsx`**

Add imports near the existing editor imports:

```tsx
import { useState } from "react";
import { frameDims } from "@/domain/faceplate-geometry";
import { PortGroupSettings } from "./PortGroupSettings";
import {
  addPortGroup, movePortGroup, addColumn, addRow, updatePortGroup, deletePortGroup,
  type GridBounds,
} from "./portGroupOps";
```

Add `setActiveFace` to the `useDeviceDraft` destructure (it already exists on the hook):

```tsx
  const { draft, activeFace, setField, setActiveSide, setActiveFace, errors, isValid } = useDeviceDraft(props.initial);
```

Add selection state and a bounds/side-change helper inside the component:

```tsx
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const dims = frameDims({
    widthIn: draft.widthIn > 0 ? draft.widthIn : 1,
    rackUnits: draft.rackUnits >= 1 ? draft.rackUnits : 1,
    rackMounted: draft.rackMounted,
  });
  const bounds: GridBounds = { width: dims.bodyWidthPx, height: dims.heightPx };
  const selectedGroup = activeFace.portGroups.find((g) => g.id === selectedGroupId) ?? null;

  function switchSide(next: "front" | "back") {
    setSelectedGroupId(null);
    setActiveSide(next);
  }
```

Make the **palette chips draggable** — replace the palette `<span>` with a draggable one that sets the media:

```tsx
              {MEDIA.map((m) => (
                <span key={m} draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", m)}
                  className="flex cursor-grab items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-800" title={MEDIA_LABELS[m]}>
                  <span className="text-neutral-900"><PortGlyph media={m} /></span>{MEDIA_LABELS[m]}
                </span>
              ))}
```

Wire the Front/Back buttons to `switchSide` (replace the two `onClick={() => setActiveSide(...)}` with `onClick={() => switchSide("front")}` / `"back"`).

Pass edit props + callbacks to `EditorCanvas`:

```tsx
            <EditorCanvas
              face={activeFace}
              widthIn={draft.widthIn > 0 ? draft.widthIn : 1}
              rackUnits={draft.rackUnits >= 1 ? draft.rackUnits : 1}
              rackMounted={draft.rackMounted}
              side={side}
              selectedGroupId={selectedGroupId}
              onSelect={setSelectedGroupId}
              onCreate={(media, pos) => {
                const before = activeFace.portGroups.length;
                const next = addPortGroup(activeFace, media, pos, bounds);
                setActiveFace(next);
                if (next.portGroups.length > before) setSelectedGroupId(next.portGroups[next.portGroups.length - 1].id);
              }}
              onMove={(id, pos) => setActiveFace(movePortGroup(activeFace, id, pos, bounds))}
              onAddColumn={(id) => setActiveFace(addColumn(activeFace, id, bounds))}
              onAddRow={(id) => setActiveFace(addRow(activeFace, id, bounds))}
            />
```

Replace the settings **placeholder** block with the real panel when a group is selected:

```tsx
        {selectedGroup ? (
          <PortGroupSettings
            group={selectedGroup}
            onChange={(patch) => setActiveFace(updatePortGroup(activeFace, selectedGroup.id, patch))}
            onDelete={() => { setActiveFace(deletePortGroup(activeFace, selectedGroup.id)); setSelectedGroupId(null); }}
          />
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-neutral-200 p-6 text-center text-xs text-neutral-400">
            Drag a port type onto the grid to add a group. Select a group to edit it.
          </div>
        )}
```

> Note: `RackDeviceEditor` already imports `useState` in 3a — if so, do not duplicate the import; just ensure it's imported once. Likewise `frameDims` may be new.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: PASS (3a's editor tests + the 4 new building tests).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all prior tests plus Tasks 1–6.

- [ ] **Step 6: Browser verification (controller)**

With Supabase running, start the dev server and open `/device-library` → Create. Verify:
- Drag a **Copper** chip onto the grid → a 1-port group appears and is selected (settings show).
- Drag the group to a new spot → it moves; drop it onto another group → it nudges to a free spot (no overlap).
- Click the **›** chevron → a column is added (preview gains ports); **⌄** adds a row; chevrons stop at the grid edge / against a neighbor.
- Change Counting Direction → numbers re-order; change Connector type / ID prefix.
- Delete → group removed, settings hide.
- Switch Front/Back → selection clears; build a group on Back; **Save**, reopen via Edit → both faces' groups persisted.
- Take a screenshot of a built device.

- [ ] **Step 7: Commit + finish the branch**

```bash
git add src/features/device-library/editor/RackDeviceEditor.tsx src/features/device-library/editor/RackDeviceEditor.test.tsx
git commit -m "feat: wire port-group building into the Rack Device Editor"
```

Then run `superpowers:requesting-code-review` (whole-branch), address findings, and `superpowers:finishing-a-development-branch` to open the stacked PR (base = `phase-2a-slice-3a`). Update `docs/superpowers/notes/RESUME.md` and project memory: Slice 3b done, Slice 3c (spacing handle + per-port) next.

---

## Self-Review

**Spec coverage:**
- Overlay layer over pure Faceplate, positioned from geometry → Tasks 3, 4 (`EditorCanvas`). Faceplate untouched. ✅
- Pure ops module (add/move/addColumn/addRow/update/delete + wouldOverlap/findFreePosition) → Tasks 1, 2. ✅
- Drag-to-create (HTML5) → Task 3 drop + Task 6 draggable palette. ✅
- Drag-to-move (pointer) → Task 4. ✅
- Select/deselect, one at a time, transient state → Tasks 3, 6. ✅
- Edge chevrons add col/row → Task 3; no-op at grid edge / on overlap → Task 2 `grow`. ✅
- Overlaps disallowed → nudge to nearest free (ring-search) → Task 1 `findFreePosition`, Task 2 add/move. ✅
- 8px snap + connector default + new-group defaults → Tasks 1, 2. ✅
- Port Group Settings (ID prefix, counting direction, connector type, delete) → Task 5, mounted in Task 6. ✅
- No persistence change; mutations via `setActiveFace` → Task 6. ✅
- Front/Back deselects → Task 6 `switchSide`. ✅
- Deferred (spacing handle, per-port, elements) correctly absent. ✅

**Placeholder scan:** No TODO/TBD. The remaining dashed "Drag a port type…" block is the real not-selected state (has complete code), not a placeholder. All test code is concrete.

**Type consistency:** `Pos`/`Rect`/`GridBounds`/`SNAP` (Task 1) are reused by Tasks 2–4, 6. Op names (`addPortGroup`, `movePortGroup`, `addColumn`, `addRow`, `updatePortGroup`, `deletePortGroup`) and `EditorCanvas` props (`selectedGroupId`, `onCreate`, `onSelect`, `onAddColumn`, `onAddRow`, `onMove`) match across producing/consuming tasks. `PortGroupSettings` prop shape matches Task 6's usage. `Face`/`PortGroup`/`Media`/`CountingDirection`/`CONNECTORS`/`MEDIA` come from the existing domain module; `frameDims`/`layoutPortGroup` from geometry.
```
