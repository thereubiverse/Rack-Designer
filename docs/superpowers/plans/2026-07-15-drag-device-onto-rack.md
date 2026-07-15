# Drag a device type onto the rack — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Press a device type in the DEVICES palette and drag it onto the rack — a blank white
device is pulled out of the chip like gooey slime, snaps solid at one RU's size, lights the rails of
the free RU under the cursor, and on release opens the existing "Add device" window at that RU.

**Architecture:** Four files. A new PURE maths module (`palettePull.ts`) holds every number and
shape; a new overlay view (`PalettePullLayer.tsx`) renders the neck and box and runs the per-frame
loop; `RackBuilder` owns the pull state and the gesture; `RackCanvas` gains a narrow
`dropArmed`/`onDropAt` contract on its existing free-RU strips. Per-frame updates are written to the
DOM imperatively — React state changes only at start/latch/end — copying the grip-drag idiom already
in `RackCanvas`.

**Tech Stack:** Next.js 16 (Turbopack), React, TypeScript strict, Vitest + @testing-library/react,
Tailwind v4, SVG.

**Spec:** `docs/superpowers/specs/2026-07-15-drag-device-onto-rack-design.md` — read it first.

## Global Constraints

- **NEVER run vitest against a directory or glob.** `src/features/racks/repository.integration.test.ts`
  and `src/features/locations/repository.integration.test.ts` run `db.from("sites").delete()` and
  **WIPE the user's local database** (this has already happened once). Run tests **BY EXPLICIT
  FILENAME ONLY** — e.g. `npx vitest run src/features/racks/palettePull.test.ts`. Never
  `npx vitest run src/features/racks/`.
- **Run every command from the project root** `/Users/reubensingh/development/network-doc-platform`
  (the Bash tool's cwd resets between calls; prefix with `cd` in the same command).
- **Typecheck with `./node_modules/.bin/tsc --noEmit`** — bare `npx tsc` resolves to the wrong package.
- **`RackCanvas` takes `dropArmed: boolean`, NOT a pull/type id.** The drop is gated on the pull being
  solid. The canvas never learns the type id; it only reports which RU was hit.
- **The blank box uses `widthIn: 17.5`, never 19.** 19 is an invalid body width (`isValidWidthIn`
  rejects `> MAX_BODY_WIDTH_IN` = 17.5) that only renders correctly by accident via the
  `Math.min(widthIn, MAX_BODY_WIDTH_IN)` clamp in `frameDims`.
- **Feature 1 is purely additive.** Do not change `insertTemplate` or `findFreeSlot`. Fit-including-
  anchor and carry mode are feature 2; the inline editor is feature 3.
- **`PULL_DIST = 140` and the spring constants are starting guesses**, to be tuned in the browser with
  the user (Task 5). Do not present them as settled; do not assert exact tuned values in tests.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## File Structure

| file | responsibility |
|---|---|
| `src/features/racks/palettePull.ts` *(create)* | PURE: every constant, easing, size and path. No React, no DOM. |
| `src/features/racks/palettePull.test.ts` *(create)* | Unit tests for the above. |
| `src/features/racks/PalettePullLayer.tsx` *(create)* | Fixed `pointer-events:none` overlay. Renders neck + blank box; runs the rAF loop and the phase machine. |
| `src/features/racks/PalettePullLayer.test.tsx` *(create)* | Renders the layer over a fake pull ref. |
| `src/features/racks/RackCanvas.tsx` *(modify)* | `dropArmed` + `onDropAt` on the free-RU strips' `onPointerUp`; trailing-click guard; `getScale` added to `RackCanvasHandle`. |
| `src/features/racks/RackCanvas.test.tsx` *(modify)* | Tests for the above. |
| `src/features/racks/RackBuilder.tsx` *(modify)* | Owns the pull ref + phase; chips get `onPointerDown`; renders the layer; drop calls the existing `setPicker`. |
| `src/features/racks/RackBuilder.test.tsx` *(modify)* | Tests for the gesture end to end. |

---

### Task 1: Pure pull maths (`palettePull.ts`)

**Files:**
- Create: `src/features/racks/palettePull.ts`
- Test: `src/features/racks/palettePull.test.ts`

**Interfaces:**
- Consumes: `RACK_INTERIOR_W` from `./RackFrame` (912); `RU_PX` from `@/domain/faceplate-geometry` (84).
- Produces (later tasks rely on these exact names):
  - `PULL_DIST: number`, `SNAP_MS: number`
  - `interface Vec { x: number; y: number }`
  - `interface Size { w: number; h: number }`
  - `pullProgress(dist: number): number`
  - `easeOutCubic(t: number): number`
  - `easeOutElastic(t: number): number`
  - `boxSize(t: number, scale: number, chip: Size): Size`
  - `neckHalfWidth(chipH: number, t: number): number`
  - `neckPath(chip: Vec, box: Vec, t: number, chipH: number): string`

- [ ] **Step 1: Write the failing test**

Create `src/features/racks/palettePull.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  PULL_DIST, pullProgress, easeOutCubic, easeOutElastic, boxSize, neckHalfWidth, neckPath,
} from "./palettePull";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";

const CHIP = { w: 132, h: 34 };

describe("pullProgress", () => {
  it("runs 0 -> 1 over PULL_DIST and clamps at both ends", () => {
    expect(pullProgress(0)).toBe(0);
    expect(pullProgress(-5)).toBe(0);           // defensive: never negative
    expect(pullProgress(PULL_DIST / 2)).toBeCloseTo(0.5, 5);
    expect(pullProgress(PULL_DIST)).toBe(1);
    expect(pullProgress(PULL_DIST * 10)).toBe(1); // clamps, never exceeds 1
  });
});

describe("easings", () => {
  it("easeOutCubic is pinned at both ends and monotonic between", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const v = easeOutCubic(t);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
  it("easeOutElastic is pinned at both ends and overshoots 1 in between (that IS the spring)", () => {
    expect(easeOutElastic(0)).toBe(0);
    expect(easeOutElastic(1)).toBe(1);
    const samples = Array.from({ length: 50 }, (_, i) => easeOutElastic(i / 49));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });
});

describe("boxSize", () => {
  it("is EXACTLY one RU of rack at t=1, scaled by the canvas", () => {
    // The whole point of the gesture: it solidifies at the size of the RU space it will occupy.
    expect(boxSize(1, 1, CHIP)).toEqual({ w: RACK_INTERIOR_W, h: RU_PX });
    expect(boxSize(1, 0.5, CHIP)).toEqual({ w: RACK_INTERIOR_W * 0.5, h: RU_PX * 0.5 });
  });
  it("starts at the chip's own size at t=0", () => {
    expect(boxSize(0, 1, CHIP)).toEqual({ w: CHIP.w, h: CHIP.h });
  });
  it("grows monotonically between", () => {
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const w = boxSize(t, 1, CHIP).w;
      expect(w).toBeGreaterThan(prev);
      prev = w;
    }
  });
});

describe("the neck", () => {
  it("thins monotonically to nothing as the pull stretches", () => {
    let prev = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const w = neckHalfWidth(CHIP.h, t);
      expect(w).toBeLessThan(prev);
      prev = w;
    }
    expect(neckHalfWidth(CHIP.h, 1)).toBe(0);
  });
  it("has snapped — no path at all — once solid", () => {
    expect(neckPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 1, CHIP.h)).toBe("");
    expect(neckPath({ x: 0, y: 0 }, { x: 200, y: 0 }, 1.5, CHIP.h)).toBe("");
  });
  it("draws a closed ribbon between chip and box while stretching", () => {
    const d = neckPath({ x: 10, y: 10 }, { x: 150, y: 40 }, 0.5, CHIP.h);
    expect(d.startsWith("M ")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    expect(d).toContain("Q");            // curved, not a straight polygon
    expect(d).not.toContain("NaN");
  });
  it("survives a zero-length pull without NaN (pointer still on the chip)", () => {
    const d = neckPath({ x: 10, y: 10 }, { x: 10, y: 10 }, 0, CHIP.h);
    expect(d).not.toContain("NaN");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/palettePull.test.ts`
Expected: FAIL — `Failed to resolve import "./palettePull"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/racks/palettePull.ts`:

```ts
// src/features/racks/palettePull.ts
// PURE maths for the palette -> rack "goo pull": pressing a device chip pulls a blank device out of
// it like a piece of gooey slime, which grows to the size of one RU and then snaps solid.
// No React, no DOM — every number and shape the gesture needs lives here so it can be tested
// directly and tuned in one place (same split as connectionOps/PatchLayer).
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";

/** Pointer distance from the chip at which the box reaches full RU size and latches solid.
 *  STARTING GUESS — tune in the browser with the user, like the patch cable's rope constants. */
export const PULL_DIST = 140;
/** Snap-back duration (ms) when a pull is abandoned. STARTING GUESS — tune in the browser. */
export const SNAP_MS = 260;

export interface Vec { x: number; y: number }
export interface Size { w: number; h: number }

const clamp01 = (t: number) => (t > 1 ? 1 : t > 0 ? t : 0);

/** Raw pull progress 0..1 from the pointer's distance to the chip. */
export function pullProgress(dist: number): number {
  return clamp01(dist / PULL_DIST);
}

/** Growth easing: the blob swells fast then settles as it approaches full size. */
export function easeOutCubic(t: number): number {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
}

/** Spring for the latch — overshoots 1 and rings down. Pinned to 0 and 1 at the ends. */
export function easeOutElastic(t: number): number {
  const c = clamp01(t);
  if (c === 0 || c === 1) return c;
  const p = 0.3;
  return Math.pow(2, -10 * c) * Math.sin(((c - p / 4) * (2 * Math.PI)) / p) + 1;
}

/** The carried box's size at progress `t`, in CSS px, for a rack canvas at `scale`.
 *  At t=1 it is EXACTLY one RU of rack — the space it will occupy once dropped. */
export function boxSize(t: number, scale: number, chip: Size): Size {
  const e = easeOutCubic(t);
  const fullW = RACK_INTERIOR_W * scale;
  const fullH = RU_PX * scale;
  return { w: chip.w + (fullW - chip.w) * e, h: chip.h + (fullH - chip.h) * e };
}

/** Half-width of the gooey neck where it leaves the chip. Thins to nothing as the pull stretches. */
export function neckHalfWidth(chipH: number, t: number): number {
  return (chipH / 2) * (1 - clamp01(t));
}

/** The gooey neck: a closed ribbon from the chip to the box, pinched at the waist like slime being
 *  pulled apart. Viewport coordinates. Returns "" once t reaches 1 — the neck has snapped. */
export function neckPath(chip: Vec, box: Vec, t: number, chipH: number): string {
  if (t >= 1) return "";
  const w = neckHalfWidth(chipH, t);
  const dx = box.x - chip.x, dy = box.y - chip.y;
  const len = Math.hypot(dx, dy) || 1; // || 1 guards the zero-length pull (pointer still on the chip)
  const nx = -dy / len, ny = dx / len; // unit normal to the pull direction
  const mx = (chip.x + box.x) / 2, my = (chip.y + box.y) / 2;
  const waist = w * 0.35;              // the neck pinches in the middle
  return [
    `M ${chip.x + nx * w} ${chip.y + ny * w}`,
    `Q ${mx + nx * waist} ${my + ny * waist} ${box.x} ${box.y}`,
    `Q ${mx - nx * waist} ${my - ny * waist} ${chip.x - nx * w} ${chip.y - ny * w}`,
    "Z",
  ].join(" ");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/palettePull.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/reubensingh/development/network-doc-platform && ./node_modules/.bin/tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform
git add src/features/racks/palettePull.ts src/features/racks/palettePull.test.ts
git commit -m "$(cat <<'EOF'
feat(racks): pure maths for the palette goo-pull

Every constant, easing, size and path for the palette -> rack drag, with no
React or DOM, so the gesture can be tested directly and tuned in one place.

boxSize is pinned to EXACTLY one RU of rack at t=1 -- the whole point of the
gesture is that it solidifies at the size of the space it will occupy.

PULL_DIST and the spring are starting guesses to be tuned in the browser.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `RackCanvas` drop contract

**Files:**
- Modify: `src/features/racks/RackCanvas.tsx`
- Test: `src/features/racks/RackCanvas.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - Two new props on `RackCanvas`: `dropArmed: boolean` and `onDropAt: (u: number) => void`.
  - `RackCanvasHandle` becomes `{ zoomBy: (factor: number) => void; getScale: () => number }`.

**Context:** `RackCanvas` already renders one `ru-hit-{u}` strip per FREE RU. They already set
`hoverU` on `mouseenter`/`mouseleave`, which already lights that RU's rails via `RackFrame`'s
`hoverU` prop — **the rail highlight needs no new code**. This task only adds the drop report and the
click guard.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/racks/RackCanvas.test.tsx`, inside `describe("RackCanvas", ...)`. Note `base`
already exists in that file; add the two new required props to it first.

Change the existing `base` object to include the new props:

```tsx
const base = {
  heightU: 4, placements, side: "FRONT" as const, onSelect: vi.fn(), onAddAt: vi.fn(), onMove: vi.fn(), onDelete: vi.fn(),
  connections: [], selectedConnectionId: null, onPatch: vi.fn(), onSelectConnection: vi.fn(),
  onDisconnect: vi.fn(), onReplace: vi.fn(), portLabel: (p: PortRef) => `${p.rackDeviceId}/${p.portIndex + 1}`,
  dropArmed: false, onDropAt: vi.fn(),
};
```

Then add these tests:

```tsx
it("a strip reports the drop RU on pointerup when a solid pull is armed", () => {
  const onDropAt = vi.fn();
  render(<RackCanvas {...base} selectedId={null} dropArmed onDropAt={onDropAt} />);
  fireEvent.pointerUp(screen.getByTestId("ru-hit-4"));
  expect(onDropAt).toHaveBeenCalledWith(4);
});

it("a strip reports NOTHING when no pull is armed", () => {
  // Covers both 'no pull at all' and 'pull not yet solid' — dropArmed is the single gate.
  const onDropAt = vi.fn();
  render(<RackCanvas {...base} selectedId={null} dropArmed={false} onDropAt={onDropAt} />);
  fireEvent.pointerUp(screen.getByTestId("ru-hit-4"));
  expect(onDropAt).not.toHaveBeenCalled();
});

it("swallows the click that trails a drop, so it can't reopen the picker with no type", () => {
  // Regression guard: click fires right after pointerup. Without the guard it would call
  // onAddAt -> setPicker({ initialTypeId: null }), clobbering the type the user just dragged.
  const onAddAt = vi.fn(), onDropAt = vi.fn();
  render(<RackCanvas {...base} selectedId={null} dropArmed onAddAt={onAddAt} onDropAt={onDropAt} />);
  const strip = screen.getByTestId("ru-hit-4");
  fireEvent.pointerUp(strip);
  fireEvent.click(strip);            // the browser's trailing click
  expect(onDropAt).toHaveBeenCalledWith(4);
  expect(onAddAt).not.toHaveBeenCalled();
});

it("still opens the picker on a normal click when idle", () => {
  // The guard must not break the everyday free-RU click.
  const onAddAt = vi.fn();
  render(<RackCanvas {...base} selectedId={null} dropArmed={false} onAddAt={onAddAt} />);
  fireEvent.click(screen.getByTestId("ru-hit-4"));
  expect(onAddAt).toHaveBeenCalledWith(4);
});

it("exposes the live canvas scale on its handle", () => {
  // The pull overlay needs it to size the box to one RU at the current zoom.
  const ref = createRef<RackCanvasHandle>();
  render(<RackCanvas ref={ref} {...base} selectedId={null} />);
  expect(ref.current!.getScale()).toBe(1);
  act(() => ref.current!.zoomBy(2));
  expect(ref.current!.getScale()).toBe(2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/RackCanvas.test.tsx`
Expected: FAIL — `onDropAt` not called; `ref.current.getScale is not a function`.

- [ ] **Step 3: Add the props to the component signature**

In `src/features/racks/RackCanvas.tsx`, add to the props type (after `portLabel`):

```tsx
  portLabel: (p: PortRef) => string;
  /** True only while a palette pull is SOLID — i.e. a drop is possible. The canvas deliberately
   *  never learns which type is being dragged; it only reports which RU was hit. */
  dropArmed: boolean;
  onDropAt: (u: number) => void;
```

- [ ] **Step 4: Extend the handle with `getScale`**

Replace line 28:

```tsx
export type RackCanvasHandle = { zoomBy: (factor: number) => void };
```

with:

```tsx
export type RackCanvasHandle = {
  zoomBy: (factor: number) => void;
  /** Live display scale. The palette-pull overlay reads it per frame to size its box to exactly
   *  one RU at the current zoom. scaleRef (not the state) is the authoritative value. */
  getScale: () => number;
};
```

and replace the `useImperativeHandle` call (~line 89):

```tsx
  useImperativeHandle(ref, () => ({ zoomBy }), [zoomBy]);
```

with:

```tsx
  useImperativeHandle(ref, () => ({ zoomBy, getScale: () => scaleRef.current }), [zoomBy]);
```

- [ ] **Step 5: Add the drop report and the click guard to the strips**

Add this ref next to the other refs in the component body (near `const [hoverU, setHoverU] = useState<number | null>(null);`):

```tsx
  // A click fires immediately after pointerup. When that pointerup committed a drop, the click must
  // NOT also run onAddAt — that would reopen the picker with initialTypeId null and throw away the
  // type the user just dragged. Set on drop, cleared on the next macrotask (the click is dispatched
  // before timers, so the guard is still up when it arrives).
  const swallowStripClickRef = useRef(false);
```

Replace the free-RU strip element with:

```tsx
          <div key={u} data-testid={`ru-hit-${u}`} title={`Add device at U${u}`}
            onClick={(e) => {
              e.stopPropagation();
              if (swallowStripClickRef.current) return;
              props.onAddAt(u);
            }}
            onPointerUp={() => {
              if (!props.dropArmed) return;
              swallowStripClickRef.current = true;
              setTimeout(() => { swallowStripClickRef.current = false; }, 0);
              props.onDropAt(u);
            }}
            onMouseEnter={() => setHoverU(u)}
            onMouseLeave={() => setHoverU((cur) => (cur === u ? null : cur))}
            className="absolute cursor-pointer"
            style={{ left: ix, top: ruTopY(u, 1, heightU), width: RACK_INTERIOR_W, height: RU_PX }} />
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/RackCanvas.test.tsx`
Expected: PASS — all tests including the 5 new ones.

- [ ] **Step 7: Satisfy the new required props at the existing call site**

`RackBuilder.tsx` renders `<RackCanvas .../>` and will not typecheck until it passes the two new
props. Add these temporary values to that JSX (Task 4 replaces them with real state):

```tsx
            dropArmed={false}
            onDropAt={() => {}}
```

Run: `cd /Users/reubensingh/development/network-doc-platform && ./node_modules/.bin/tsc --noEmit`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform
git add src/features/racks/RackCanvas.tsx src/features/racks/RackCanvas.test.tsx src/features/racks/RackBuilder.tsx
git commit -m "$(cat <<'EOF'
feat(racks): give RackCanvas a drop contract for the palette pull

Free-RU strips report their U on pointerup when `dropArmed`, and the handle
now exposes the live scale so the pull overlay can size its box to one RU at
the current zoom.

The canvas takes `dropArmed`, not a type id: it only reports which RU was hit,
which keeps its contract narrow and leaves the gesture's state in RackBuilder.

A click fires right after pointerup, so a drop would ALSO run onAddAt and
reopen the picker with no type -- throwing away the dragged type. A ref guard
swallows exactly that one click; the everyday free-RU click still works.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The pull overlay (`PalettePullLayer.tsx`)

**Files:**
- Create: `src/features/racks/PalettePullLayer.tsx`
- Test: `src/features/racks/PalettePullLayer.test.tsx`

**Interfaces:**
- Consumes from Task 1: `PULL_DIST`, `SNAP_MS`, `pullProgress`, `easeOutElastic`, `boxSize`,
  `neckPath`, `type Vec`, `type Size`.
- Consumes existing: `renderFace` from `@/features/device-library/faceplate/Faceplate`; `emptyFace`
  from `@/domain/faceplate`; `RACK_INTERIOR_W` from `./RackFrame`; `RU_PX` from
  `@/domain/faceplate-geometry`.
- Produces:
  - `export type PullPhase = "pulling" | "solid" | "snapback"`
  - `export interface PullState { typeId: string; chip: Vec; chipSize: Size; x: number; y: number; phase: PullPhase; snapFrom: Vec | null; snapStart: number }`
  - `export function PalettePullLayer(props: { pullRef: React.MutableRefObject<PullState | null>; scaleOf: () => number }): JSX.Element`

**Why a ref, not props:** the box must track the pointer 1:1. Re-rendering React every frame would
add latency, so the parent mutates `pullRef.current` and this layer reads it inside its own rAF loop
and writes the DOM directly — the same idiom as the grip drag in `RackCanvas`.

**This layer is a PURE PAINTER — it owns no state transitions.** `RackBuilder` decides when the pull
latches solid and when the snap-back ends; the layer only draws whatever `pullRef.current` currently
says. This is deliberate: latching inside the rAF loop would make the drop depend on a frame having
fired, which is untestable in jsdom (rAF is not synchronous) and would put the state machine in the
view. The phase belongs with the state's owner.

- [ ] **Step 1: Write the failing test**

Create `src/features/racks/PalettePullLayer.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { PalettePullLayer, type PullState } from "./PalettePullLayer";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { PULL_DIST } from "./palettePull";

function pull(over: Partial<PullState> = {}): PullState {
  return {
    typeId: "t1", chip: { x: 100, y: 100 }, chipSize: { w: 132, h: 34 },
    x: 100, y: 100, phase: "pulling", snapFrom: null, snapStart: 0, ...over,
  };
}
const mount = (state: PullState | null) => {
  const ref = createRef<PullState | null>() as React.MutableRefObject<PullState | null>;
  ref.current = state;
  const r = render(<PalettePullLayer pullRef={ref} scaleOf={() => 1} />);
  return { ...r, ref };
};

describe("PalettePullLayer", () => {
  it("renders nothing when there is no pull", () => {
    const { container } = mount(null);
    expect(container.querySelector('[data-testid="pull-box"]')).toBeNull();
  });

  it("draws the blank device with ears and no ports", () => {
    // The dragged thing is a blank device: the faceplate frame + ears, drawn by the SAME renderer
    // the rack uses, with an empty face. A type has no port layout, so there are no ports.
    const { container } = mount(pull({ x: 300, y: 100 }));
    expect(container.querySelector('[data-testid="pull-box"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="face-ear"]').length).toBe(2);
    expect(container.querySelectorAll('[data-testid="port-cell"]').length).toBe(0);
  });

  it("is exactly one RU when solid", () => {
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100 }));
    const box = container.querySelector('[data-testid="pull-box"]') as HTMLElement;
    expect(box.style.width).toBe(`${RACK_INTERIOR_W}px`);
    expect(box.style.height).toBe(`${RU_PX}px`);
  });

  it("shows the gooey neck while stretching and drops it once solid", () => {
    const mid = mount(pull({ x: 100 + PULL_DIST / 2, y: 100 }));
    const neck = mid.container.querySelector('[data-testid="pull-neck"]') as SVGPathElement;
    expect(neck.getAttribute("d")).not.toBe("");

    const solid = mount(pull({ phase: "solid", x: 400, y: 100 }));
    const gone = solid.container.querySelector('[data-testid="pull-neck"]');
    expect(gone === null || gone.getAttribute("d") === "").toBe(true);
  });

  it("is translucent while carried, so the rack reads through it", () => {
    const { container } = mount(pull({ phase: "solid", x: 400, y: 100 }));
    const box = container.querySelector('[data-testid="pull-box"]') as HTMLElement;
    expect(Number(box.style.opacity)).toBeGreaterThan(0);
    expect(Number(box.style.opacity)).toBeLessThan(1);
  });

  it("never intercepts the pointer — the rack strips underneath must still get it", () => {
    const { container } = mount(pull({ x: 300, y: 100 }));
    const root = container.querySelector('[data-testid="pull-layer"]') as HTMLElement;
    expect(root.className).toContain("pointer-events-none");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/PalettePullLayer.test.tsx`
Expected: FAIL — `Failed to resolve import "./PalettePullLayer"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/racks/PalettePullLayer.tsx`:

```tsx
"use client";

// src/features/racks/PalettePullLayer.tsx
// The palette -> rack drag visual: a blank device pulled out of a chip like gooey slime, growing to
// the size of one RU and snapping solid. Fixed, pointer-events:none, above the palette and canvas.
//
// Reads its state from a REF, not props, and writes the DOM inside its own rAF loop — the box has to
// track the pointer 1:1, and a React render per frame would add latency. Same idiom as the grip drag
// in RackCanvas. React state here changes only when the layer mounts/unmounts.
// It owns NO state transitions: RackBuilder decides when the pull latches solid and when the
// snap-back ends. This layer only draws whatever pullRef.current currently says. Latching in here
// would make the drop depend on a frame having fired — untestable, and the wrong home for the
// machine anyway.
import { useEffect, useRef, type MutableRefObject } from "react";
import { renderFace } from "@/features/device-library/faceplate/Faceplate";
import { emptyFace } from "@/domain/faceplate";
import { RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { SNAP_MS, boxSize, easeOutElastic, neckPath, pullProgress, type Size, type Vec } from "./palettePull";

export type PullPhase = "pulling" | "solid" | "snapback";

export interface PullState {
  typeId: string;
  chip: Vec;          // chip centre, viewport coords
  chipSize: Size;     // the chip's own box — where the blob starts
  x: number;          // live pointer, viewport coords
  y: number;
  phase: PullPhase;
  snapFrom: Vec | null; // where the box was when the pull was abandoned
  snapStart: number;    // performance.now() at the start of the snap-back
}

/** Carried box opacity — translucent so the rack and its rails read through it. */
const BOX_OPACITY = 0.75;

export function PalettePullLayer({ pullRef, scaleOf }: {
  pullRef: MutableRefObject<PullState | null>;
  scaleOf: () => number;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const neckRef = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const p = pullRef.current;
      const box = boxRef.current, neck = neckRef.current;
      if (!p || !box) return;
      const scale = scaleOf();

      if (p.phase === "snapback") {
        // Shrink back into the chip. RackBuilder unmounts us on its own SNAP_MS timer.
        const k = Math.min(1, (performance.now() - p.snapStart) / SNAP_MS);
        const from = p.snapFrom ?? p.chip;
        const cx = from.x + (p.chip.x - from.x) * k;
        const cy = from.y + (p.chip.y - from.y) * k;
        paint(box, neck, { x: cx, y: cy }, boxSize(1 - k, scale, p.chipSize), "", (1 - k) * BOX_OPACITY);
        return;
      }

      // `solid` is latched by RackBuilder, so t is 1 forever after — dragging back toward the chip
      // never re-attaches it.
      const t = p.phase === "solid" ? 1 : pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y));
      let s = boxSize(t, scale, p.chipSize);
      if (p.phase === "solid") {
        // Spring on the moment it went solid: overshoot, then ring down to exactly one RU.
        const k = Math.min(1, (performance.now() - p.snapStart) / SNAP_MS);
        const e = k >= 1 ? 1 : easeOutElastic(k);
        s = { w: RACK_INTERIOR_W * scale * e, h: RU_PX * scale * e };
      }
      paint(box, neck, { x: p.x, y: p.y }, s, neckPath(p.chip, { x: p.x, y: p.y }, t, p.chipSize.h), BOX_OPACITY);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [pullRef, scaleOf]);

  if (!pullRef.current) return <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]" />;

  // First paint comes from the ref directly, so the very first frame is already correct.
  const p = pullRef.current;
  const scale = scaleOf();
  const t = p.phase === "solid" ? 1 : pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y));
  const s = boxSize(t, scale, p.chipSize);
  const d = neckPath(p.chip, { x: p.x, y: p.y }, t, p.chipSize.h);

  return (
    <div data-testid="pull-layer" className="pointer-events-none fixed inset-0 z-[60]">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        <path ref={neckRef} data-testid="pull-neck" d={d} fill="#ffffff" fillOpacity={0.9} stroke="#d4d4d4" />
      </svg>
      <div ref={boxRef} data-testid="pull-box" className="absolute"
        style={{ left: 0, top: 0, width: s.w, height: s.h, opacity: BOX_OPACITY,
          transform: `translate(${p.x - s.w / 2}px, ${p.y - s.h / 2}px)` }}>
        <svg width="100%" height="100%" viewBox={`0 0 ${RACK_INTERIOR_W} ${RU_PX}`} preserveAspectRatio="none">
          {/* The SAME renderer the rack uses, with an empty face: frame + ears, no ports.
              17.5 (never 19) — a rack-mounted frame is RACK_INTERIOR_W wide regardless, and 19 is an
              invalid body width that only works via the MAX_BODY_WIDTH_IN clamp. */}
          {renderFace(emptyFace(), { widthIn: 17.5, rackUnits: 1, rackMounted: true })}
        </svg>
      </div>
    </div>
  );
}

function paint(box: HTMLDivElement, neck: SVGPathElement | null, at: Vec, s: Size, d: string, opacity: number) {
  box.style.width = `${s.w}px`;
  box.style.height = `${s.h}px`;
  box.style.opacity = String(opacity);
  box.style.transform = `translate(${at.x - s.w / 2}px, ${at.y - s.h / 2}px)`;
  if (neck) neck.setAttribute("d", d);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/PalettePullLayer.test.tsx`
Expected: PASS — 6 tests.

- [ ] **Step 5: Typecheck**

Run: `cd /Users/reubensingh/development/network-doc-platform && ./node_modules/.bin/tsc --noEmit`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform
git add src/features/racks/PalettePullLayer.tsx src/features/racks/PalettePullLayer.test.tsx
git commit -m "$(cat <<'EOF'
feat(racks): the goo-pull overlay

Renders the blank device and its gooey neck, and runs the phase machine:
stretch -> latch solid with an elastic spring -> or snap back to the chip.

The blank device is renderFace(emptyFace()) -- the same renderer the rack
uses, so the dragged thing is literally a rack device with no ports, and no
new artwork exists to drift.

Reads a ref and paints inside its own rAF loop rather than taking props: the
box tracks the pointer 1:1, and a React render per frame would add latency.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire the gesture into `RackBuilder`

**Files:**
- Modify: `src/features/racks/RackBuilder.tsx`
- Test: `src/features/racks/RackBuilder.test.tsx`

**Interfaces:**
- Consumes from Task 1: `SNAP_MS`, `pullProgress`.
- Consumes from Task 3: `PalettePullLayer`, `type PullState`.
- Consumes from Task 2: `RackCanvas`'s `dropArmed` / `onDropAt`; `RackCanvasHandle.getScale`.
- Produces: the finished feature. Nothing later depends on it.

**Ordering fact this relies on:** a strip's React `onPointerUp` runs when the event reaches the React
root, which is INSIDE `body` — so it fires **before** a native `window` `pointerup` listener. The drop
therefore clears `pullRef` first, and the window handler then sees `null` and skips the snap-back. No
extra "did we drop?" flag is needed.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/racks/RackBuilder.test.tsx`, inside the existing `describe`. The file already
has a `baseProps()` helper and mocks `./actions`; reuse both — do NOT invent a new harness. The
fixture rack is 12U with devices at U5 and U3, so `ru-hit-1` is a free RU. The one chip is
`palette-type-SW` (the `deviceType` fixture's `code`). The picker renders
`role="dialog" aria-label="Add device"`.

Add `act` to the existing `@testing-library/react` import if it is not already there (it is).

```tsx
it("pressing a palette chip and dropping on a free RU opens the picker at that RU", () => {
  // The whole gesture: press the chip, pull past PULL_DIST so it latches solid, release on a strip.
  // jsdom reports a zero-size rect for the chip, so its centre is (0,0) and the pointer's distance
  // is simply clientX — 500 is comfortably past PULL_DIST (140).
  render(<RackBuilder {...baseProps()} />);
  const chip = screen.getByTestId("palette-type-SW");
  fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
  act(() => { fireEvent.pointerMove(window, { clientX: 500, clientY: 0 }); }); // -> latches solid
  fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
  expect(screen.getByRole("dialog", { name: /add device/i })).toBeInTheDocument();
});

it("a chip press released before it solidifies opens nothing", () => {
  render(<RackBuilder {...baseProps()} />);
  const chip = screen.getByTestId("palette-type-SW");
  fireEvent.pointerDown(chip, { clientX: 0, clientY: 0, button: 0 });
  act(() => { fireEvent.pointerMove(window, { clientX: 10, clientY: 0 }); }); // short of PULL_DIST
  fireEvent.pointerUp(screen.getByTestId("ru-hit-1"));
  expect(screen.queryByRole("dialog", { name: /add device/i })).toBeNull();
});

it("right-clicking a chip starts no pull", () => {
  render(<RackBuilder {...baseProps()} />);
  fireEvent.pointerDown(screen.getByTestId("palette-type-SW"), { clientX: 0, clientY: 0, button: 2 });
  expect(screen.queryByTestId("pull-box")).toBeNull();
});

it("still opens the picker on a plain chip click", () => {
  // The existing palette behaviour must survive: click a chip -> picker at that type, no RU.
  render(<RackBuilder {...baseProps()} />);
  fireEvent.click(screen.getByTestId("palette-type-SW"));
  expect(screen.getByRole("dialog", { name: /add device/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/RackBuilder.test.tsx`
Expected: FAIL — no dialog after the drop.

- [ ] **Step 3: Add the imports**

In `src/features/racks/RackBuilder.tsx`:

```tsx
import { PalettePullLayer, type PullState } from "./PalettePullLayer";
import { SNAP_MS, pullProgress } from "./palettePull";
```

`useCallback` and `useEffect` are already imported in this file; `useRef` and `useState` are too.

- [ ] **Step 4: Add the pull state and gesture**

Add inside the component body, next to the other state (`canvasRef` already exists at ~line 60):

```tsx
  // Palette -> rack pull. The live values are a REF (mutated per frame, no re-render); React state
  // is only `pullMounted` (mount the overlay) and `dropArmed` (latched once, when it goes solid).
  const pullRef = useRef<PullState | null>(null);
  const [pullMounted, setPullMounted] = useState(false);
  const [dropArmed, setDropArmed] = useState(false);

  const endPull = useCallback(() => {
    pullRef.current = null;
    setPullMounted(false);
    setDropArmed(false);
  }, []);

  const beginSnapBack = useCallback(() => {
    const p = pullRef.current;
    if (!p || p.phase === "snapback") return;
    p.snapFrom = { x: p.x, y: p.y };
    p.snapStart = performance.now();
    p.phase = "snapback";
    setDropArmed(false);                  // a retreating box must not be droppable
    setTimeout(endPull, SNAP_MS);         // the layer animates; this owns when it's over
  }, [endPull]);

  function startPull(e: React.PointerEvent, typeId: string) {
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    pullRef.current = {
      typeId,
      chip: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      chipSize: { w: r.width, h: r.height },
      x: e.clientX, y: e.clientY,
      phase: "pulling", snapFrom: null, snapStart: 0,
    };
    setPullMounted(true);
    setDropArmed(false);
  }

  useEffect(() => {
    if (!pullMounted) return;
    const onMove = (e: PointerEvent) => {
      const p = pullRef.current;
      if (!p || p.phase === "snapback") return;
      p.x = e.clientX; p.y = e.clientY;   // per-frame: mutate the ref, never setState
      // Latch solid HERE, not in the layer's rAF loop: the drop must not depend on a frame having
      // fired, and the phase machine belongs with the state's owner. This setState runs once.
      if (p.phase === "pulling" && pullProgress(Math.hypot(p.x - p.chip.x, p.y - p.chip.y)) >= 1) {
        p.phase = "solid";
        p.snapStart = performance.now();  // the latch spring's clock
        setDropArmed(true);
      }
    };
    const onUp = () => {
      // A drop on a strip already cleared pullRef (its React onPointerUp runs first — the React root
      // is inside body, so it sees the event before this window listener). Nothing left to do.
      if (!pullRef.current) return;
      beginSnapBack();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") beginSnapBack(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("keydown", onKey);
    };
  }, [pullMounted, beginSnapBack]);
```

- [ ] **Step 5: Give the chips the gesture**

Replace the palette chip button (~line 212) with:

```tsx
          <button key={t.id} type="button" data-testid={`palette-type-${t.code}`}
            onPointerDown={(e) => startPull(e, t.id)}
            onClick={() => setPicker({ initialTypeId: t.id, atU: null })}
            style={{ touchAction: "none" }}
            className="block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm font-medium hover:bg-neutral-50">
            {t.name}
          </button>
```

- [ ] **Step 6: Replace the placeholder canvas props from Task 2**

In the `<RackCanvas ... />` JSX, replace `dropArmed={false}` and `onDropAt={() => {}}` with:

```tsx
            dropArmed={dropArmed}
            onDropAt={(u) => {
              const typeId = pullRef.current?.typeId;
              endPull();                                  // clears pullRef before window's pointerup
              if (typeId) setPicker({ initialTypeId: typeId, atU: u });
            }}
```

- [ ] **Step 7: Render the overlay**

Add just before the closing element that already wraps `{picker && (...)}` — i.e. as a sibling of the
picker, at the top level of the component's returned tree:

```tsx
      {pullMounted && (
        <PalettePullLayer pullRef={pullRef} scaleOf={() => canvasRef.current?.getScale() ?? 1} />
      )}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/RackBuilder.test.tsx`
Expected: PASS.

- [ ] **Step 9: Run the full affected set BY FILENAME and typecheck**

Run:
```bash
cd /Users/reubensingh/development/network-doc-platform && ./node_modules/.bin/tsc --noEmit && npx vitest run \
  src/features/racks/palettePull.test.ts \
  src/features/racks/PalettePullLayer.test.tsx \
  src/features/racks/RackCanvas.test.tsx \
  src/features/racks/RackBuilder.test.tsx \
  src/features/racks/RackFrame.test.tsx
```
Expected: tsc silent; all files pass.

**NEVER** run `npx vitest run src/features/racks/` — it globs in `repository.integration.test.ts`,
which deletes every row in `sites` and wipes the user's local database.

- [ ] **Step 10: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform
git add src/features/racks/RackBuilder.tsx src/features/racks/RackBuilder.test.tsx
git commit -m "$(cat <<'EOF'
feat(racks): drag a device type from the palette onto the rack

Press a chip and a blank device is pulled out of it, grows to one RU, snaps
solid, and drops onto the free RU under the cursor -- opening the existing
Add device window at that RU.

The rail highlight is free: the free-RU strips already set hoverU on
mouseenter and only exist for free RUs, and pointer events (unlike native
drag-and-drop) don't suppress mouse events. No new geometry.

A drop clears pullRef before the window pointerup handler runs -- a strip's
React onPointerUp fires first, because the React root is inside body -- so the
snap-back correctly skips itself without needing a "did we drop?" flag.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Browser verification and tuning

**Files:** possibly `src/features/racks/palettePull.ts` (constants only).

**Interfaces:** consumes everything above; produces nothing new.

This task is a conversation with the user, not a code change. `PULL_DIST` and the spring were
guesses; the patch cable's rope needed several rounds of "more bounce", "slower", "faster on
connect". Expect the same.

- [ ] **Step 1: Start the dev server and open the rack**

Use the Browser pane's `preview_start` (never `npm run dev` via Bash). Navigate to the rack builder.

- [ ] **Step 2: Verify the gesture non-destructively**

Do NOT drag a device into the rack and commit it — that writes to the user's database. Verify only
what leaves no trace:
- Press a chip and pull: `[data-testid="pull-box"]` exists; its `width`/`height` reach
  `RACK_INTERIOR_W * scale` and `RU_PX * scale` (read `getScale()` from the canvas handle).
- While over a free RU, `[data-testid="rail-hover"] rect` count is 2 and their `fill` is `RK_SELECT`.
- Release away from the rack → the box snaps back, no dialog opens, and
  `select count(*) from rack_devices;` is unchanged.

Check the row count before and after:
```bash
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "select count(*) from rack_devices;"
```

- [ ] **Step 3: Screenshot the pull mid-stretch and solid, and show the user**

- [ ] **Step 4: Tune with the user**

Ask whether the goo wants to be stretchier (raise `PULL_DIST`), springier (lower the elastic period
`p` in `easeOutElastic`), or slower (raise `SNAP_MS`). Change ONLY constants in `palettePull.ts`.
Re-run `npx vitest run src/features/racks/palettePull.test.ts` after any change — the tests assert
relationships (pinned ends, monotonicity, exact RU size at t=1), not tuned values, so they must
still pass.

- [ ] **Step 5: Commit any tuning**

```bash
cd /Users/reubensingh/development/network-doc-platform
git add src/features/racks/palettePull.ts
git commit -m "$(cat <<'EOF'
feat(racks): tune the goo-pull feel

Constants only, from live feedback. The tests assert relationships (pinned
ends, monotonicity, exactly one RU at t=1), not tuned values, so they hold.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage:**

| spec requirement | task |
|---|---|
| Goo pull out of the chip, grows to RU size | 1 (maths), 3 (visual) |
| Latches solid one-way, elastic spring | 1 (`easeOutElastic`), 3 (`phase === "solid"` short-circuits `t`) |
| Blank white box with ears, no ports, `widthIn: 17.5` | 3 |
| Translucent while carried | 3 |
| Rail highlight = existing mouseover, no new geometry | 2 (unchanged `mouseenter`), verified in 5 |
| Drop gated on solid → `dropArmed` | 2, 4 |
| Drop opens the picker at that RU | 4 |
| Snap back on: release early / off-rack / occupied RU / Esc | 4 (`beginSnapBack`), 3 (animation) |
| Trailing-click wrinkle | 2 |
| Only primary button pulls | 4 (`e.button !== 0`) |
| Per-frame imperative, React state only at start/latch/end | 3, 4 |
| Box resizes with canvas zoom mid-pull | 2 (`getScale`), 3 (`scaleOf()` per frame) |
| `touch-action: none` on chips | 4 |
| Existing add-device paths unchanged | 2 (idle click test), 4 (chip click test) |

No gaps.

**Placeholder scan:** none — every step carries its real code and exact commands.

**Design fix found during self-review (already applied above):** the first draft had the *layer* latch
`solid` inside its rAF loop and call an `onSolid` callback. That was wrong twice over — `dropArmed`
would only be set once a frame had fired, so in jsdom (where rAF is not synchronous) the drop would
silently never commit and Task 4's test would fail for a reason unrelated to the code under test; and
it put the state machine inside the painter. `RackBuilder` now latches solid synchronously in its
`pointermove` handler, and owns snap-back completion via a `SNAP_MS` timer. The layer takes no
callbacks and is a pure painter.

**Type consistency:** `PullState`/`PullPhase` are defined in Task 3 and imported by Task 4.
`boxSize(t, scale, chip)`, `neckPath(chip, box, t, chipH)`, `pullProgress(dist)`, `SNAP_MS`,
`easeOutElastic` are defined in Task 1 and used with those exact signatures in Task 3.
`RackCanvasHandle.getScale` is added in Task 2 and consumed in Task 4. `dropArmed`/`onDropAt` are
added in Task 2 and supplied for real in Task 4 (with a typecheck-preserving placeholder in Task 2
Step 7, so the tree compiles at every commit).
