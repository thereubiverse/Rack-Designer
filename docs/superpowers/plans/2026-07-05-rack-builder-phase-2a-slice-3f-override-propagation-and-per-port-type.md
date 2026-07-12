# Slice 3f — Override Propagation + Per-Port Type Replace — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep per-port overrides attached to the right ports when chevrons add/remove rows & columns (with pattern propagation into new ports), and let the user replace a single port's connector type by selecting it and clicking a palette chip.

**Architecture:** All override transforms are pure functions in `portGroupOps.ts` (remap keys deterministically from the row-major index `row*cols+col`; propagate copyable fields from the adjacent row/column). `layoutPortGroup` resolves per-cell `media`/`connectorType` from the override with group fallback, so the existing `Faceplate`/`PortCell` renders mixed media unchanged. Wiring adds an `onClick` to the Port Type palette chips that calls a new `setPortMedia` op when a port is selected.

**Tech Stack:** Next.js 16, React, TypeScript, Vitest + Testing Library. Local Supabase via Docker (not needed for this slice — all changes are client/pure).

**Spec:** [2026-07-05-rack-builder-phase-2a-slice-3f-override-propagation-and-per-port-type-design.md](../specs/2026-07-05-rack-builder-phase-2a-slice-3f-override-propagation-and-per-port-type-design.md)

## Global Constraints

- Overrides stay keyed by numeric row-major index `index = row * cols + col`. No data-model re-key; only add optional `media`/`connectorType` fields to an override entry.
- **Never copy `name`** during propagation (names are per-port identifiers). Copyable fields = `flipped`, `labelPos`, `media`, `connectorType`.
- Prune override entries that end up empty (`{}`) so we don't persist noise.
- Per-port media replace resets that port's `connectorType` to `CONNECTORS[media][0]`.
- Run on branch `phase-2a-slice-3f` (already checked out). Test: `npx vitest run <file>`; full suite `npm test`; lint `npm run lint`.
- Browser-verify all editor interactions (per RESUME — 3d & 3f had bugs only visible in the browser).

---

### Task 1: Data model — override `media`/`connectorType` + per-cell resolution

**Files:**
- Modify: `src/domain/faceplate.ts` (add `PortOverride` type; extend `PortGroup.portOverrides`)
- Modify: `src/domain/faceplate-geometry.ts:135-165` (`layoutPortGroup` resolves per-cell media/connector)
- Modify: `src/features/device-library/faceplate/Faceplate.tsx:49` (add `data-media` to the port-cell `<g>` for rendering + test assertion)
- Test: `src/domain/faceplate-geometry.test.ts`

**Interfaces:**
- Produces: `PortOverride` = `{ name?: string; flipped?: boolean; labelPos?: "top" | "bottom"; media?: Media; connectorType?: string }`. `LaidOutPort.media`/`.connectorType` now resolve from `override?.media ?? group.media` / `override?.connectorType ?? group.connectorType`.

- [ ] **Step 1: Write the failing test**

Add to `src/domain/faceplate-geometry.test.ts`:

```ts
import { layoutPortGroup } from "./faceplate-geometry";
import type { PortGroup } from "./faceplate";

function pg(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 2, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}

describe("layoutPortGroup per-cell media override", () => {
  it("falls back to the group media/connector when no override", () => {
    const laid = layoutPortGroup(pg());
    expect(laid.cells[0].media).toBe("copper");
    expect(laid.cells[0].connectorType).toBe("RJ45");
  });
  it("uses the per-port media/connector override when present", () => {
    const laid = layoutPortGroup(pg({ portOverrides: { 0: { media: "fiber", connectorType: "LC" } } }));
    expect(laid.cells[0].media).toBe("fiber");
    expect(laid.cells[0].connectorType).toBe("LC");
    expect(laid.cells[1].media).toBe("copper");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/faceplate-geometry.test.ts`
Expected: FAIL — `cells[0].media` is `"copper"` (override ignored) in the second test.

- [ ] **Step 3: Add the `PortOverride` type**

In `src/domain/faceplate.ts`, add above `PortGroup` and reference it:

```ts
export interface PortOverride {
  name?: string;
  flipped?: boolean;
  labelPos?: "top" | "bottom";
  media?: Media;
  connectorType?: string;
}
```

Then change the `PortGroup.portOverrides` field to:

```ts
  portOverrides: Record<number, PortOverride>;
```

- [ ] **Step 4: Resolve per-cell media/connector in `layoutPortGroup`**

In `src/domain/faceplate-geometry.ts`, inside the `for` loop of `layoutPortGroup`, change the `cells.push({...})` `media`/`connectorType` fields from group values to override-with-fallback:

```ts
      media: override?.media ?? group.media,
      connectorType: override?.connectorType ?? group.connectorType,
```

(`override` is already read as `const override = group.portOverrides[index];`.)

- [ ] **Step 5: Add `data-media` to the rendered port cell**

In `src/features/device-library/faceplate/Faceplate.tsx`, the `PortCell` wrapper `<g>`:

```tsx
    <g data-testid="port-cell" data-media={cell.media} data-highlighted={highlighted ? "true" : "false"}>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/domain/faceplate-geometry.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/faceplate.ts src/domain/faceplate-geometry.ts src/features/device-library/faceplate/Faceplate.tsx src/domain/faceplate-geometry.test.ts
git commit -m "feat: per-port media/connector override resolved in layoutPortGroup"
```

---

### Task 2: `setPortMedia` pure op

**Files:**
- Modify: `src/features/device-library/editor/portGroupOps.ts` (new export `setPortMedia`)
- Test: `src/features/device-library/editor/portGroupOps.test.ts`

**Interfaces:**
- Produces: `setPortMedia(face: Face, groupId: string, index: number, media: Media): Face` — sets `portOverrides[index].media = media` and `.connectorType = CONNECTORS[media][0]`, preserving other fields on that override.

- [ ] **Step 1: Write the failing test**

Add to `src/features/device-library/editor/portGroupOps.test.ts` (extend the existing import from `"./portGroupOps"` to include `setPortMedia`):

```ts
describe("setPortMedia", () => {
  it("sets the port's media and the media's default connector", () => {
    const face: Face = { portGroups: [group({ id: "g", cols: 2 })], elements: [] };
    const next = setPortMedia(face, "g", 0, "fiber");
    expect(next.portGroups[0].portOverrides[0]).toEqual({ media: "fiber", connectorType: "LC" });
  });
  it("preserves an existing name/flip on that port", () => {
    const face: Face = {
      portGroups: [group({ id: "g", cols: 2, portOverrides: { 0: { name: "WAN", flipped: true } } })],
      elements: [],
    };
    const next = setPortMedia(face, "g", 0, "sfp");
    expect(next.portGroups[0].portOverrides[0]).toEqual({
      name: "WAN", flipped: true, media: "sfp", connectorType: "SFP",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/device-library/editor/portGroupOps.test.ts`
Expected: FAIL — `setPortMedia is not exported` / not a function.

- [ ] **Step 3: Implement `setPortMedia`**

In `src/features/device-library/editor/portGroupOps.ts`, add (imports for `CONNECTORS`, `Media` already exist at the top):

```ts
export function setPortMedia(face: Face, groupId: string, index: number, media: Media): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) =>
      g.id === groupId
        ? {
            ...g,
            portOverrides: {
              ...g.portOverrides,
              [index]: { ...g.portOverrides[index], media, connectorType: CONNECTORS[media][0] },
            },
          }
        : g,
    ),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/device-library/editor/portGroupOps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/portGroupOps.ts src/features/device-library/editor/portGroupOps.test.ts
git commit -m "feat: setPortMedia op — per-port media replace with default connector"
```

---

### Task 3: Override remap + propagation for COLUMN add/remove

**Files:**
- Modify: `src/features/device-library/editor/portGroupOps.ts` (`grow`, `addColumn`, `removeColumn`; add `copyable`/`isEmpty`/`remapColOverrides` helpers)
- Test: `src/features/device-library/editor/portGroupOps.test.ts`

**Interfaces:**
- Consumes: `PortOverride` (Task 1).
- Produces: `addColumn`/`removeColumn` re-key existing overrides for the new `cols`; `addColumn` also propagates copyable fields from `(row, cols-1)` into the new `(row, cols)`.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/device-library/editor/portGroupOps.test.ts`:

```ts
describe("addColumn override remap + propagation", () => {
  const wide: GridBounds = { width: 400, height: 84 };
  it("re-keys an existing override to its new row-major index", () => {
    // 2x2, override on (row1,col0) = index 2. After add -> cols 3 -> index 3.
    const face: Face = { portGroups: [group({ id: "g", rows: 2, cols: 2, portOverrides: { 2: { flipped: true } } })], elements: [] };
    const next = addColumn(face, "g", wide);
    const ov = next.portGroups[0].portOverrides;
    expect(ov[2]).toBeUndefined();
    expect(ov[3]).toEqual({ flipped: true });
  });
  it("propagates copyable fields from the last column but NOT name", () => {
    // 1x2, override on (0,1) = index 1 with flip + name.
    const face: Face = { portGroups: [group({ id: "g", rows: 1, cols: 2, portOverrides: { 1: { flipped: true, name: "keep" } } })], elements: [] };
    const next = addColumn(face, "g", wide);
    const ov = next.portGroups[0].portOverrides;
    expect(ov[1]).toEqual({ flipped: true, name: "keep" }); // existing re-keyed (0,1)->index1
    expect(ov[2]).toEqual({ flipped: true });               // new (0,2) copies flip, not name
  });
});

describe("removeColumn override remap", () => {
  it("drops the removed column's overrides and re-keys survivors", () => {
    // 1x3, overrides on all three cols.
    const face: Face = { portGroups: [group({ id: "g", rows: 1, cols: 3, portOverrides: { 0: { flipped: true }, 1: { name: "b" }, 2: { flipped: true } } })], elements: [] };
    const next = removeColumn(face, "g");
    const g = next.portGroups[0];
    expect(g.cols).toBe(2);
    expect(g.portOverrides).toEqual({ 0: { flipped: true }, 1: { name: "b" } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/device-library/editor/portGroupOps.test.ts`
Expected: FAIL — current `addColumn`/`removeColumn` leave `portOverrides` untouched, so indices scramble.

- [ ] **Step 3: Add helpers + column-aware transforms**

In `src/features/device-library/editor/portGroupOps.ts`, add (after the imports, add `PortOverride` to the type import from `@/domain/faceplate`):

```ts
import type { Face, PortGroup, PortOverride } from "@/domain/faceplate";
```

Add helper functions near the top (below `SNAP`):

```ts
function copyable(ov: PortOverride): PortOverride {
  const out: PortOverride = {};
  if (ov.flipped !== undefined) out.flipped = ov.flipped;
  if (ov.labelPos !== undefined) out.labelPos = ov.labelPos;
  if (ov.media !== undefined) out.media = ov.media;
  if (ov.connectorType !== undefined) out.connectorType = ov.connectorType;
  return out;
}

function isEmpty(ov: PortOverride): boolean {
  return Object.keys(ov).length === 0;
}
```

Add a column-remap builder:

```ts
/** Re-key overrides from `oldCols` to `oldCols+1`, propagating the last column's
 *  copyable fields (not name) into the new column. */
function addColOverrides(g: PortGroup): Record<number, PortOverride> {
  const c = g.cols;
  const nc = c + 1;
  const out: Record<number, PortOverride> = {};
  for (const [k, ov] of Object.entries(g.portOverrides)) {
    const idx = Number(k);
    const row = Math.floor(idx / c);
    const col = idx % c;
    out[row * nc + col] = { ...ov };
  }
  for (let row = 0; row < g.rows; row++) {
    const src = g.portOverrides[row * c + (c - 1)];
    if (src) {
      const copied = copyable(src);
      if (!isEmpty(copied)) out[row * nc + c] = copied;
    }
  }
  return out;
}

/** Re-key overrides from `oldCols` to `oldCols-1`, dropping the removed rightmost column. */
function removeColOverrides(g: PortGroup): Record<number, PortOverride> {
  const c = g.cols;
  const nc = c - 1;
  const out: Record<number, PortOverride> = {};
  for (const [k, ov] of Object.entries(g.portOverrides)) {
    const idx = Number(k);
    const row = Math.floor(idx / c);
    const col = idx % c;
    if (col === c - 1) continue;
    out[row * nc + col] = { ...ov };
  }
  return out;
}
```

Change `grow` to accept the transformed overrides, and route `addColumn` through it:

```ts
function grow(
  face: Face, id: string, bounds: GridBounds,
  delta: { cols?: number; rows?: number },
  overrides?: (g: PortGroup) => Record<number, PortOverride>,
): Face {
  const g = face.portGroups.find((x) => x.id === id);
  if (!g) return face;
  const grown: PortGroup = {
    ...g,
    cols: g.cols + (delta.cols ?? 0),
    rows: g.rows + (delta.rows ?? 0),
    portOverrides: overrides ? overrides(g) : g.portOverrides,
  };
  const b = groupBounds(grown);
  if (b.x + b.width > bounds.width || b.y + b.height > bounds.height) return face;
  if (wouldOverlap(face, grown, id)) return face;
  return { ...face, portGroups: face.portGroups.map((x) => (x.id === id ? grown : x)) };
}

export function addColumn(face: Face, id: string, bounds: GridBounds): Face {
  return grow(face, id, bounds, { cols: 1 }, addColOverrides);
}
```

Change `removeColumn` to remap:

```ts
export function removeColumn(face: Face, id: string): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) =>
      g.id === id && g.cols > 1
        ? { ...g, cols: g.cols - 1, portOverrides: removeColOverrides(g) }
        : g,
    ),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/device-library/editor/portGroupOps.test.ts`
Expected: PASS (including the pre-existing chevron/overlap tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/portGroupOps.ts src/features/device-library/editor/portGroupOps.test.ts
git commit -m "feat: remap + propagate port overrides on column add/remove"
```

---

### Task 4: Override remap + propagation for ROW add/remove

**Files:**
- Modify: `src/features/device-library/editor/portGroupOps.ts` (`addRow`, `removeRow`; add `addRowOverrides`/`removeRowOverrides`)
- Test: `src/features/device-library/editor/portGroupOps.test.ts`

**Interfaces:**
- Consumes: `copyable`/`isEmpty`/`grow` (Task 3).
- Produces: `addRow` propagates copyable fields from `(rows-1, col)` into the new `(rows, col)`; `removeRow` drops the last row's overrides. Column keys are unchanged by row ops.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/device-library/editor/portGroupOps.test.ts`:

```ts
describe("addRow override propagation", () => {
  const tall: GridBounds = { width: 400, height: 200 };
  it("propagates copyable fields from the last row (not name); existing keys stable", () => {
    // 1x2, overrides on (0,0) flip+name and (0,1) labelPos.
    const face: Face = { portGroups: [group({ id: "g", rows: 1, cols: 2, portOverrides: { 0: { flipped: true, name: "a" }, 1: { labelPos: "bottom" } } })], elements: [] };
    const next = addRow(face, "g", tall);
    const ov = next.portGroups[0].portOverrides;
    expect(ov[0]).toEqual({ flipped: true, name: "a" }); // unchanged
    expect(ov[1]).toEqual({ labelPos: "bottom" });        // unchanged
    expect(ov[2]).toEqual({ flipped: true });             // new (1,0) copies flip, not name
    expect(ov[3]).toEqual({ labelPos: "bottom" });        // new (1,1)
  });
});

describe("removeRow override remap", () => {
  it("drops the last row's overrides; other rows keep their keys", () => {
    // 2x2, overrides on row0 (idx0) and row1 (idx2, idx3).
    const face: Face = { portGroups: [group({ id: "g", rows: 2, cols: 2, portOverrides: { 0: { name: "a" }, 2: { flipped: true }, 3: { labelPos: "bottom" } } })], elements: [] };
    const next = removeRow(face, "g");
    const g = next.portGroups[0];
    expect(g.rows).toBe(1);
    expect(g.portOverrides).toEqual({ 0: { name: "a" } });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/device-library/editor/portGroupOps.test.ts`
Expected: FAIL — `addRow` adds no propagated overrides; `removeRow` leaves stale row-1 overrides.

- [ ] **Step 3: Implement row transforms**

In `src/features/device-library/editor/portGroupOps.ts`, add builders near the column ones:

```ts
/** Add a row: existing keys are stable (row-major appends); propagate the last row's
 *  copyable fields into the new bottom row. */
function addRowOverrides(g: PortGroup): Record<number, PortOverride> {
  const c = g.cols;
  const r = g.rows;
  const out: Record<number, PortOverride> = {};
  for (const [k, ov] of Object.entries(g.portOverrides)) out[Number(k)] = { ...ov };
  for (let col = 0; col < c; col++) {
    const src = g.portOverrides[(r - 1) * c + col];
    if (src) {
      const copied = copyable(src);
      if (!isEmpty(copied)) out[r * c + col] = copied;
    }
  }
  return out;
}

/** Remove the last row: drop its overrides (row === rows-1); other keys unchanged. */
function removeRowOverrides(g: PortGroup): Record<number, PortOverride> {
  const c = g.cols;
  const r = g.rows;
  const out: Record<number, PortOverride> = {};
  for (const [k, ov] of Object.entries(g.portOverrides)) {
    const idx = Number(k);
    if (Math.floor(idx / c) === r - 1) continue;
    out[idx] = { ...ov };
  }
  return out;
}
```

Route `addRow` through `grow` and remap `removeRow`:

```ts
export function addRow(face: Face, id: string, bounds: GridBounds): Face {
  return grow(face, id, bounds, { rows: 1 }, addRowOverrides);
}

export function removeRow(face: Face, id: string): Face {
  return {
    ...face,
    portGroups: face.portGroups.map((g) =>
      g.id === id && g.rows > 1
        ? { ...g, rows: g.rows - 1, portOverrides: removeRowOverrides(g) }
        : g,
    ),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/features/device-library/editor/portGroupOps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/portGroupOps.ts src/features/device-library/editor/portGroupOps.test.ts
git commit -m "feat: remap + propagate port overrides on row add/remove"
```

---

### Task 5: Wiring — palette chip click replaces selected port's media

**Files:**
- Modify: `src/features/device-library/editor/RackDeviceEditor.tsx` (import `setPortMedia`; palette chip `onClick` + `data-testid`; pass media label to `PortSettings`)
- Modify: `src/features/device-library/editor/PortSettings.tsx` (read-only current-media line)
- Test: `src/features/device-library/editor/RackDeviceEditor.test.tsx`

**Interfaces:**
- Consumes: `setPortMedia` (Task 2), `MEDIA_LABELS` (already in `RackDeviceEditor.tsx`), `data-media` on `port-cell` (Task 1).

- [ ] **Step 1: Write the failing tests**

Add to `src/features/device-library/editor/RackDeviceEditor.test.tsx`:

```ts
describe("per-port type replace", () => {
  const twoPortFace: Face = {
    portGroups: [{
      id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
      countingDirection: "ltr", rows: 1, cols: 2, gridX: 0, gridY: 0,
      colSpacing: 0, rowSpacing: 0, portOverrides: {},
    }],
    elements: [],
  };

  it("replaces only the selected port's media when a palette chip is clicked", () => {
    render(<RackDeviceEditor mode="edit" types={types} brands={brands}
      initial={{ name: "S", deviceTypeId: "t1", widthIn: 19, frontFace: twoPortFace }}
      onSave={noop} onCancel={noop} />);
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    fireEvent.click(screen.getByTestId("palette-port-fiber"));
    const cells = screen.getAllByTestId("port-cell");
    expect(cells[0].getAttribute("data-media")).toBe("fiber");
    expect(cells[1].getAttribute("data-media")).toBe("copper");
  });

  it("does nothing when no port is selected", () => {
    render(<RackDeviceEditor mode="edit" types={types} brands={brands}
      initial={{ name: "S", deviceTypeId: "t1", widthIn: 19, frontFace: twoPortFace }}
      onSave={noop} onCancel={noop} />);
    fireEvent.click(screen.getByTestId("palette-port-fiber"));
    for (const cell of screen.getAllByTestId("port-cell")) {
      expect(cell.getAttribute("data-media")).toBe("copper");
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: FAIL — `palette-port-fiber` testid does not exist yet.

- [ ] **Step 3: Import `setPortMedia`**

In `src/features/device-library/editor/RackDeviceEditor.tsx`, add `setPortMedia` to the existing import from `"./portGroupOps"`:

```ts
import {
  addPortGroup, movePortGroup, addColumn, addRow, removeColumn, removeRow, updatePortGroup, deletePortGroup,
  setPortOverride, setSpacing, setPortMedia, type GridBounds,
} from "./portGroupOps";
```

- [ ] **Step 4: Add the chip `onClick` + testid**

In `src/features/device-library/editor/RackDeviceEditor.tsx`, the Port Types palette `MEDIA.map` chip `<span>` — add `data-testid` and an `onClick` that replaces the selected port's media (leave `draggable`/`onDragStart` unchanged):

```tsx
                {MEDIA.map((m) => (
                  <span key={m} draggable
                    data-testid={`palette-port-${m}`}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", m)}
                    onClick={() => {
                      if (selectedGroupId && selectedPortIndex !== null) {
                        setActiveFace(setPortMedia(activeFace, selectedGroupId, selectedPortIndex, m));
                      }
                    }}
                    className="flex cursor-grab items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-800" title={MEDIA_LABELS[m]}>
                    <span className="text-neutral-900"><PortGlyph media={m} /></span>{MEDIA_LABELS[m]}
                  </span>
                ))}
```

- [ ] **Step 5: Show current media in `PortSettings`**

In `src/features/device-library/editor/PortSettings.tsx`, add a `mediaLabel` prop and render it under the header. New signature + line:

```tsx
export function PortSettings({
  portLabel, mediaLabel, name, flipped, labelPos, onChange,
}: {
  portLabel: string;
  mediaLabel: string;
  name: string;
  flipped: boolean;
  labelPos: "top" | "bottom";
  onChange: (patch: { name?: string; flipped?: boolean; labelPos?: "top" | "bottom" }) => void;
}) {
```

Under the `Port {portLabel}` header div, add:

```tsx
      <div className="mb-3 text-xs text-neutral-500">
        Type: {mediaLabel} — click a Port Type in the palette to change it.
      </div>
```

Then pass it from `RackDeviceEditor.tsx` in the `PortSettings` render block (the IIFE already has `cell`):

```tsx
            <PortSettings
              portLabel={cell ? cell.label : String(selectedPortIndex + 1)}
              mediaLabel={cell ? MEDIA_LABELS[cell.media] : ""}
              name={ov.name ?? ""}
              flipped={ov.flipped ?? false}
              labelPos={cell ? cell.labelPos : "top"}
              onChange={(patch) => setActiveFace(setPortOverride(activeFace, selectedGroup.id, selectedPortIndex, patch))}
            />
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/features/device-library/editor/RackDeviceEditor.test.tsx src/features/device-library/editor/PortSettings.test.tsx`
Expected: PASS. (If `PortSettings.test.tsx` renders `PortSettings` directly, add `mediaLabel="Copper"` to its render calls.)

- [ ] **Step 7: Commit**

```bash
git add src/features/device-library/editor/RackDeviceEditor.tsx src/features/device-library/editor/PortSettings.tsx src/features/device-library/editor/RackDeviceEditor.test.tsx src/features/device-library/editor/PortSettings.test.tsx
git commit -m "feat: click a palette port type to replace the selected port's media"
```

---

### Task 6: Full suite, lint, browser-verify, docs

**Files:**
- Modify: `docs/superpowers/notes/RESUME.md` (mark Slice 3f complete)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS — all prior tests (170) plus the new ones.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: clean (no new warnings/errors).

- [ ] **Step 3: Browser-verify (per RESUME — mandatory for editor changes)**

Start the dev server (`npm run dev`; Docker + `npx supabase start` up) and, in the Rack Device Editor:
1. Build a 2-col group, flip the whole column's ports, chevron-add a column → the new column's ports are flipped (propagation), existing overrides intact.
2. Select one port, click a different Port Type chip in the palette → only that port's glyph changes; `PortSettings` shows the new type.
3. Give ports distinct overrides across 3 columns, chevron-remove the middle-reaching column (remove from the right) → remaining ports keep their correct overrides (no scramble).
4. Add a row to a group with per-port label positions → the new row matches the pattern.

- [ ] **Step 4: Update RESUME**

In `docs/superpowers/notes/RESUME.md`, update the branch-stack line for `phase-2a-slice-3f` to mark it complete, and change the "Slice 3f — remaining" section to note both items are done (override propagation + index remap; per-port type replace). Update the test count to the new total from Step 1.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/RESUME.md
git commit -m "docs: Slice 3f complete — override propagation + per-port type replace"
```

---

## Self-Review

- **Spec coverage:** §3 data-model change → Task 1. §4 remap+propagation (column) → Task 3, (row) → Task 4. §5 per-port replace (`setPortMedia` + wiring) → Task 2 + Task 5. §6 rendering (per-cell media) → Task 1. §7 testing → tests in every task + browser-verify in Task 6. §8 edge cases (floor, prune-empty, preserve name/selection) → covered by `removeColumn`/`removeRow` floor guards (unchanged), `isEmpty` prune, and `copyable` excluding `name`.
- **Placeholder scan:** none — every code step shows full code; every run step gives an exact command + expected result.
- **Type consistency:** `PortOverride` (Task 1) is imported and used by `copyable`/`isEmpty`/remap builders (Tasks 3–4). `setPortMedia(face, groupId, index, media)` signature matches its call site in Task 5. `addColumn`/`removeColumn`/`addRow`/`removeRow` keep their existing exported signatures (only internals change), so `EditorCanvas`/`RackDeviceEditor` wiring is untouched except the new chip `onClick`.
```
