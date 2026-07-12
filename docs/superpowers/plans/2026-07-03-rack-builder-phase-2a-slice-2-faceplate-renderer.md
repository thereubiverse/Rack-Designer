# Phase 2a · Slice 2 — SVG Faceplate Renderer & Rack-Mount Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reusable, read-only `Faceplate` component that renders a device face (from the existing `Face` model) as a single exportable SVG at true 1U rack proportion, with rack-mount geometry (19″ frame, centered body, gap-filling ears, pinned screw holes) and width-normalized port glyphs.

**Architecture:** All layout math lives in a pure, unit-tested geometry module (`src/domain/faceplate-geometry.ts`) so the React layer stays thin. Port-type glyphs are our own original SVG paths in a normalized coordinate box, drawn inline into one composed `<svg>` (data-bound and exportable, reused unchanged by the Phase 2b rack view). The renderer is a pure function of `(face, { widthIn, rackUnits, rackMounted })` — no interactivity (drag / chevrons / spacing handle are Slice 3).

**Tech Stack:** Next.js 16, React 19, TypeScript 5, SVG, Vitest 2 + @testing-library/react (jsdom).

## Global Constraints

- **Next.js 16 + React 19 + TypeScript 5**; path alias `@/` → `src/`.
- **All faceplate rendering is SVG** (data-bound, exportable), reused by Phase 2b — never HTML/flexbox for the device itself.
- **Renderer is a pure function of template data** — signature `renderFace(face, { widthIn, rackUnits, rackMounted })`. No side effects, no data fetching, no editing UI.
- **Port glyphs are our OWN original SVGs**, `currentColor`-driven, and **every glyph renders at the same normalized width** (`GLYPH_W`).
- **True 1U proportion:** frame = 19″ wide × 1.75″ per U tall.
- Consumes the existing `Face`, `PortGroup`, `Media`, `CountingDirection` types from `src/domain/faceplate.ts` — do not redefine them.
- Tests: Vitest, `describe/it/expect`, one behavior per `it`. Run with `npm test`.
- Visual style: Inter typeface, blue primary `#2563eb`, subtle borders — matches the benchmark.
- TDD, DRY, YAGNI, frequent commits. Work on branch `phase-2a-slice-2`.

---

## File Structure

- **Create** `src/domain/faceplate-geometry.ts` — pure geometry: constants, `earWidthIn`, `frameDims`, `screwHoles`, `portSequence`, `layoutPortGroup`. (grows across Tasks 1–3)
- **Create** `src/domain/faceplate-geometry.test.ts` — unit tests for all of the above.
- **Create** `src/features/device-library/faceplate/portGlyphs.tsx` — the 10 normalized port-type glyphs + `PORT_GLYPHS` registry.
- **Create** `src/features/device-library/faceplate/portGlyphs.test.tsx` — asserts all 10 present and uniform width.
- **Create** `src/features/device-library/faceplate/Faceplate.tsx` — the `Faceplate` / `renderFace` SVG component.
- **Create** `src/features/device-library/faceplate/Faceplate.test.tsx` — component tests.
- **Create** `src/app/device-library/preview/page.tsx` — dev preview route reproducing the 10.6″ reference device for visual verification.

---

## Task 1: Frame & ear geometry

**Files:**
- Create: `src/domain/faceplate-geometry.ts`
- Test: `src/domain/faceplate-geometry.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `RAIL_WIDTH_IN = 19`, `U_HEIGHT_IN = 1.75`, `PX_PER_IN = 48`, `CELL_W = 24`, `ROW_H = 24`, `GLYPH_W = 20` (all `number` consts).
  - `earWidthIn(bodyWidthIn: number, rackMounted: boolean): number`
  - `interface FrameDims { frameWidthIn; bodyWidthIn; earWidthIn; heightIn; frameWidthPx; bodyWidthPx; earWidthPx; heightPx }` (all `number`).
  - `frameDims(opts: { widthIn: number; rackUnits: number; rackMounted: boolean }): FrameDims`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/faceplate-geometry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  RAIL_WIDTH_IN,
  U_HEIGHT_IN,
  PX_PER_IN,
  earWidthIn,
  frameDims,
} from "./faceplate-geometry";

describe("faceplate geometry — frame & ears", () => {
  it("exposes rack constants", () => {
    expect(RAIL_WIDTH_IN).toBe(19);
    expect(U_HEIGHT_IN).toBe(1.75);
  });

  it("ear width fills half the gap between body and 19in rails when rack-mounted", () => {
    expect(earWidthIn(10.6, true)).toBeCloseTo((19 - 10.6) / 2, 5); // 4.2
    expect(earWidthIn(19, true)).toBeCloseTo(0, 5);
  });

  it("has no ears when not rack-mounted", () => {
    expect(earWidthIn(10.6, false)).toBe(0);
  });

  it("clamps ear width to zero for bodies wider than the rails", () => {
    expect(earWidthIn(24, true)).toBe(0);
  });

  it("frameDims: rack-mounted frame locks to 19in, body centered, height scales per U", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    expect(d.frameWidthIn).toBe(19);
    expect(d.bodyWidthIn).toBe(10.6);
    expect(d.earWidthIn).toBeCloseTo(4.2, 5);
    expect(d.heightIn).toBeCloseTo(1.75, 5);
    expect(d.frameWidthPx).toBeCloseTo(19 * PX_PER_IN, 5);
    expect(d.heightPx).toBeCloseTo(1.75 * PX_PER_IN, 5);
  });

  it("frameDims: stand-alone frame equals the body width (no ears)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 2, rackMounted: false });
    expect(d.frameWidthIn).toBe(10.6);
    expect(d.earWidthIn).toBe(0);
    expect(d.heightIn).toBeCloseTo(3.5, 5);
  });

  it("frameDims: body wider than rails is clamped to the rail width when mounted", () => {
    const d = frameDims({ widthIn: 24, rackUnits: 1, rackMounted: true });
    expect(d.bodyWidthIn).toBe(19);
    expect(d.earWidthIn).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/domain/faceplate-geometry.test.ts`
Expected: FAIL — cannot resolve `./faceplate-geometry` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/domain/faceplate-geometry.ts`:

```ts
// Pure rack-mount geometry for the SVG faceplate renderer. No React, no I/O.
// Reused unchanged by the Phase 2b rack view.

export const RAIL_WIDTH_IN = 19;   // EIA 19" rack rail-to-rail width
export const U_HEIGHT_IN = 1.75;   // one rack unit
export const PX_PER_IN = 48;       // rendering scale (19" -> 912px, 1U -> 84px)
export const CELL_W = 24;          // uniform port cell width (px)
export const ROW_H = 24;           // uniform port cell height (px)
export const GLYPH_W = 20;         // normalized glyph width (px)

/** Ear width (inches) on ONE side: half the gap between body and the rails. */
export function earWidthIn(bodyWidthIn: number, rackMounted: boolean): number {
  if (!rackMounted) return 0;
  return Math.max(0, (RAIL_WIDTH_IN - bodyWidthIn) / 2);
}

export interface FrameDims {
  frameWidthIn: number;
  bodyWidthIn: number;
  earWidthIn: number;
  heightIn: number;
  frameWidthPx: number;
  bodyWidthPx: number;
  earWidthPx: number;
  heightPx: number;
}

export function frameDims(opts: {
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
}): FrameDims {
  const { widthIn, rackUnits, rackMounted } = opts;
  const bodyWidthIn = rackMounted ? Math.min(widthIn, RAIL_WIDTH_IN) : widthIn;
  const ear = earWidthIn(bodyWidthIn, rackMounted);
  const frameWidthIn = rackMounted ? RAIL_WIDTH_IN : bodyWidthIn;
  const heightIn = U_HEIGHT_IN * rackUnits;
  return {
    frameWidthIn,
    bodyWidthIn,
    earWidthIn: ear,
    heightIn,
    frameWidthPx: frameWidthIn * PX_PER_IN,
    bodyWidthPx: bodyWidthIn * PX_PER_IN,
    earWidthPx: ear * PX_PER_IN,
    heightPx: heightIn * PX_PER_IN,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/domain/faceplate-geometry.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/faceplate-geometry.ts src/domain/faceplate-geometry.test.ts
git commit -m "feat: faceplate frame & ear geometry"
```

---

## Task 2: Screw-hole layout

**Files:**
- Modify: `src/domain/faceplate-geometry.ts` (append)
- Test: `src/domain/faceplate-geometry.test.ts` (append)

**Interfaces:**
- Consumes: `FrameDims` and `frameDims` from Task 1.
- Produces:
  - `interface ScrewHole { cx: number; cy: number }`
  - `screwHoles(dims: FrameDims, rackUnits: number): ScrewHole[]` — empty when there are no ears; otherwise 2 holes per U per ear (top & bottom third of each U), pinned near the outer rail edges. Ordered left-ear holes first, then right-ear.

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/faceplate-geometry.test.ts`:

```ts
import { screwHoles } from "./faceplate-geometry";

describe("faceplate geometry — screw holes", () => {
  it("no holes when there are no ears (stand-alone)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: false });
    expect(screwHoles(d, 1)).toEqual([]);
  });

  it("rack-mounted 1U yields 4 holes: 2 per ear (top & bottom)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    expect(screwHoles(d, 1)).toHaveLength(4);
  });

  it("hole count scales with rack units (2 per U per ear)", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 2, rackMounted: true });
    expect(screwHoles(d, 2)).toHaveLength(8);
  });

  it("left holes sit inside the left ear, right holes inside the right ear", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    const holes = screwHoles(d, 1);
    const leftX = d.earWidthPx / 2;
    const rightX = d.frameWidthPx - d.earWidthPx / 2;
    expect(holes.filter((h) => Math.abs(h.cx - leftX) < 0.001)).toHaveLength(2);
    expect(holes.filter((h) => Math.abs(h.cx - rightX) < 0.001)).toHaveLength(2);
  });

  it("holes stay within the frame height", () => {
    const d = frameDims({ widthIn: 10.6, rackUnits: 1, rackMounted: true });
    for (const h of screwHoles(d, 1)) {
      expect(h.cy).toBeGreaterThan(0);
      expect(h.cy).toBeLessThan(d.heightPx);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/domain/faceplate-geometry.test.ts`
Expected: FAIL — `screwHoles` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/domain/faceplate-geometry.ts`:

```ts
export interface ScrewHole {
  cx: number;
  cy: number;
}

/**
 * Screw holes pinned near the outer rail edges so they line up on the rack
 * regardless of body width. 2 holes per U per ear (top & bottom third of each
 * U). Returns [] when there are no ears.
 */
export function screwHoles(dims: FrameDims, rackUnits: number): ScrewHole[] {
  if (dims.earWidthPx <= 0) return [];
  const leftX = dims.earWidthPx / 2;
  const rightX = dims.frameWidthPx - dims.earWidthPx / 2;
  const uPx = U_HEIGHT_IN * PX_PER_IN;
  const holes: ScrewHole[] = [];
  for (const cx of [leftX, rightX]) {
    for (let u = 0; u < rackUnits; u++) {
      const top = u * uPx;
      holes.push({ cx, cy: top + uPx * 0.28 });
      holes.push({ cx, cy: top + uPx * 0.72 });
    }
  }
  return holes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/domain/faceplate-geometry.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/faceplate-geometry.ts src/domain/faceplate-geometry.test.ts
git commit -m "feat: faceplate screw-hole layout"
```

---

## Task 3: Port numbering & port-group layout

**Files:**
- Modify: `src/domain/faceplate-geometry.ts` (append)
- Test: `src/domain/faceplate-geometry.test.ts` (append)

**Interfaces:**
- Consumes: `CELL_W`, `ROW_H` from Task 1; `PortGroup`, `CountingDirection`, `Media` from `src/domain/faceplate.ts`.
- Produces:
  - `portSequence(rows: number, cols: number, direction: CountingDirection): number[]` — for each row-major index (`index = row*cols + col`), the 1-based sequence number implied by the counting direction.
  - `interface LaidOutPort { index: number; row: number; col: number; x: number; y: number; number: number; label: string; flipped: boolean; media: Media; connectorType: string }`
  - `interface LaidOutGroup { id: string; cells: LaidOutPort[]; width: number; height: number }`
  - `layoutPortGroup(group: PortGroup): LaidOutGroup` — cells laid out at `gridX/gridY` with `colSpacing/rowSpacing` (px), each `label = idPrefix + zero-padded(number)`, honoring `portOverrides[index].flipped`/`.name`.

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/faceplate-geometry.test.ts`:

```ts
import { portSequence, layoutPortGroup } from "./faceplate-geometry";
import type { PortGroup } from "./faceplate";

describe("faceplate geometry — port numbering", () => {
  it("ltr numbers left-to-right then top-to-bottom (row-major)", () => {
    expect(portSequence(2, 2, "ltr")).toEqual([1, 2, 3, 4]);
  });
  it("rtl reverses within each row", () => {
    expect(portSequence(2, 2, "rtl")).toEqual([2, 1, 4, 3]);
  });
  it("ttb numbers column-major top-to-bottom", () => {
    expect(portSequence(2, 2, "ttb")).toEqual([1, 3, 2, 4]);
  });
  it("btt numbers column-major bottom-to-top", () => {
    expect(portSequence(2, 2, "btt")).toEqual([2, 4, 1, 3]);
  });
});

function group(overrides: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g1",
    media: "copper",
    connectorType: "RJ45",
    idPrefix: "",
    countingDirection: "ltr",
    rows: 1,
    cols: 2,
    gridX: 0,
    gridY: 0,
    colSpacing: 0,
    rowSpacing: 0,
    portOverrides: {},
    ...overrides,
  };
}

describe("faceplate geometry — layoutPortGroup", () => {
  it("lays out cells on a uniform grid from gridX/gridY", () => {
    const g = layoutPortGroup(group({ gridX: 10, gridY: 5 }));
    expect(g.cells).toHaveLength(2);
    expect(g.cells[0]).toMatchObject({ index: 0, row: 0, col: 0, x: 10, y: 5 });
    expect(g.cells[1]).toMatchObject({ index: 1, row: 0, col: 1, x: 34, y: 5 }); // 10 + CELL_W
  });

  it("applies column and row spacing (px) between cells", () => {
    const g = layoutPortGroup(group({ rows: 2, cols: 2, colSpacing: 6, rowSpacing: 8 }));
    expect(g.cells[1].x).toBe(30); // 24 + 6
    expect(g.cells[2].y).toBe(32); // 24 + 8
    expect(g.width).toBe(54); // 2*24 + 6
    expect(g.height).toBe(56); // 2*24 + 8
  });

  it("builds labels from idPrefix + zero-padded sequence number", () => {
    const g = layoutPortGroup(group({ idPrefix: "Gi0/", cols: 3 }));
    expect(g.cells.map((c) => c.label)).toEqual(["Gi0/01", "Gi0/02", "Gi0/03"]);
  });

  it("honors per-port flip and name overrides", () => {
    const g = layoutPortGroup(
      group({ cols: 2, portOverrides: { 1: { flipped: true, name: "UPLINK" } } }),
    );
    expect(g.cells[0].flipped).toBe(false);
    expect(g.cells[1].flipped).toBe(true);
    expect(g.cells[1].label).toBe("UPLINK");
  });

  it("numbers cells according to counting direction", () => {
    const g = layoutPortGroup(group({ cols: 2, countingDirection: "rtl" }));
    expect(g.cells.map((c) => c.number)).toEqual([2, 1]);
    expect(g.cells.map((c) => c.label)).toEqual(["02", "01"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/domain/faceplate-geometry.test.ts`
Expected: FAIL — `portSequence` / `layoutPortGroup` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/domain/faceplate-geometry.ts`:

```ts
import type { PortGroup, Media, CountingDirection } from "./faceplate";

/** 1-based sequence number per row-major index for a counting direction. */
export function portSequence(
  rows: number,
  cols: number,
  direction: CountingDirection,
): number[] {
  const seq: number[] = [];
  for (let index = 0; index < rows * cols; index++) {
    const row = Math.floor(index / cols);
    const col = index % cols;
    let n: number;
    switch (direction) {
      case "ltr":
        n = row * cols + col + 1;
        break;
      case "rtl":
        n = row * cols + (cols - 1 - col) + 1;
        break;
      case "ttb":
        n = col * rows + row + 1;
        break;
      case "btt":
        n = col * rows + (rows - 1 - row) + 1;
        break;
    }
    seq.push(n);
  }
  return seq;
}

export interface LaidOutPort {
  index: number;
  row: number;
  col: number;
  x: number;
  y: number;
  number: number;
  label: string;
  flipped: boolean;
  media: Media;
  connectorType: string;
}

export interface LaidOutGroup {
  id: string;
  cells: LaidOutPort[];
  width: number;
  height: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function layoutPortGroup(group: PortGroup): LaidOutGroup {
  const seq = portSequence(group.rows, group.cols, group.countingDirection);
  const cells: LaidOutPort[] = [];
  for (let index = 0; index < group.rows * group.cols; index++) {
    const row = Math.floor(index / group.cols);
    const col = index % group.cols;
    const override = group.portOverrides[index];
    const number = seq[index];
    const label = override?.name ?? `${group.idPrefix}${pad2(number)}`;
    cells.push({
      index,
      row,
      col,
      x: group.gridX + col * (CELL_W + group.colSpacing),
      y: group.gridY + row * (ROW_H + group.rowSpacing),
      number,
      label,
      flipped: override?.flipped ?? false,
      media: group.media,
      connectorType: group.connectorType,
    });
  }
  const width = group.cols * CELL_W + Math.max(0, group.cols - 1) * group.colSpacing;
  const height = group.rows * ROW_H + Math.max(0, group.rows - 1) * group.rowSpacing;
  return { id: group.id, cells, width, height };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/domain/faceplate-geometry.test.ts`
Expected: PASS (all Task 1–3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/faceplate-geometry.ts src/domain/faceplate-geometry.test.ts
git commit -m "feat: faceplate port numbering & group layout"
```

---

## Task 4: Port-type glyph set (10 normalized SVGs)

**Files:**
- Create: `src/features/device-library/faceplate/portGlyphs.tsx`
- Test: `src/features/device-library/faceplate/portGlyphs.test.tsx`

**Interfaces:**
- Consumes: `GLYPH_W` from `@/domain/faceplate-geometry`; `Media`, `MEDIA` from `@/domain/faceplate`.
- Produces:
  - `interface GlyphSpec { viewBox: string; height: number; body: ReactNode }` — `body` is the inner SVG markup (paths/rects), width normalized so the glyph renders at `GLYPH_W` px; drawn with `currentColor`.
  - `PORT_GLYPHS: Record<Media, GlyphSpec>` — one entry per media (all 10).
  - `PortGlyph({ media }: { media: Media }): JSX.Element` — renders a standalone `<svg width={GLYPH_W} height=... viewBox=...>` wrapping the glyph body (used by the palette and by the composed faceplate via `<use>`-style inlining).

These glyphs are our own original artwork (connector-accurate, width-consistent). Exact `viewBox` crops are set here and fine-tuned during Task 6 visual verification — width stays `GLYPH_W` for every glyph.

- [ ] **Step 1: Write the failing tests**

Create `src/features/device-library/faceplate/portGlyphs.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PORT_GLYPHS, PortGlyph } from "./portGlyphs";
import { GLYPH_W } from "@/domain/faceplate-geometry";
import { MEDIA } from "@/domain/faceplate";

describe("port glyphs", () => {
  it("defines a glyph for every media type", () => {
    for (const m of MEDIA) {
      expect(PORT_GLYPHS[m]).toBeDefined();
      expect(PORT_GLYPHS[m].viewBox).toMatch(/^[\d.\s-]+$/);
    }
  });

  it("renders every glyph at the normalized width", () => {
    for (const m of MEDIA) {
      const { container, unmount } = render(<PortGlyph media={m} />);
      const svg = container.querySelector("svg")!;
      expect(svg.getAttribute("width")).toBe(String(GLYPH_W));
      unmount();
    }
  });

  it("drives fill from currentColor (themable)", () => {
    const { container } = render(<PortGlyph media="copper" />);
    expect(container.innerHTML).toContain("currentColor");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/faceplate/portGlyphs.test.tsx`
Expected: FAIL — cannot resolve `./portGlyphs`.

- [ ] **Step 3: Write minimal implementation**

Create `src/features/device-library/faceplate/portGlyphs.tsx`. Glyph bodies are lifted from the approved mockup (`.superpowers/brainstorm/.../custom-device-test.html`) and normalized to `GLYPH_W`:

```tsx
import type { ReactNode } from "react";
import type { Media } from "@/domain/faceplate";
import { GLYPH_W } from "@/domain/faceplate-geometry";

export interface GlyphSpec {
  viewBox: string;
  height: number; // rendered px height at GLYPH_W width
  body: ReactNode;
}

// Our own original, connector-accurate glyphs. Each is authored so that at
// width=GLYPH_W it reads unmistakably as its connector while every glyph keeps
// the same rendered width. currentColor drives the fill.
export const PORT_GLYPHS: Record<Media, GlyphSpec> = {
  copper: {
    viewBox: "3 4.5 18 15",
    height: 17,
    body: (
      <path
        d="M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-5v2a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"
        fill="currentColor"
      />
    ),
  },
  fiber: {
    viewBox: "2 6 20 12",
    height: 12,
    body: (
      <>
        <rect x="2.5" y="6.5" width="19" height="11" rx="2" fill="currentColor" />
        <rect x="5" y="9" width="6" height="6" rx="1" fill="#fff" />
        <rect x="13" y="9" width="6" height="6" rx="1" fill="#fff" />
        <circle cx="8" cy="12" r="1.4" fill="currentColor" />
        <circle cx="16" cy="12" r="1.4" fill="currentColor" />
      </>
    ),
  },
  sfp: {
    viewBox: "4 6 16 12",
    height: 15,
    body: <rect x="4" y="6" width="16" height="12" rx="2.5" fill="currentColor" />,
  },
  usb_a: {
    viewBox: "3.5 7 17 10",
    height: 12,
    body: (
      <>
        <rect x="3.5" y="7" width="17" height="10" rx="1.5" fill="currentColor" />
        <rect x="6" y="11.4" width="12" height="3.2" rx=".6" fill="#fff" />
        <rect x="7.5" y="12.3" width="3.2" height="1.4" fill="currentColor" />
        <rect x="13.3" y="12.3" width="3.2" height="1.4" fill="currentColor" />
      </>
    ),
  },
  usb_c: {
    viewBox: "2.5 8 19 8",
    height: 9,
    body: (
      <>
        <rect x="2.5" y="8" width="19" height="8" rx="4" fill="currentColor" />
        <rect x="6.5" y="10.4" width="11" height="3.2" rx="1.6" fill="#fff" />
      </>
    ),
  },
  hdmi: {
    viewBox: "3.5 7 17 9.5",
    height: 11,
    body: (
      <>
        <path
          d="M4 7.5h16v3.2l-2.4 4.8a1 1 0 0 1-.9.6H7.3a1 1 0 0 1-.9-.6L4 10.7z"
          fill="currentColor"
        />
        <rect x="7" y="9.3" width="10" height="1.8" rx=".7" fill="#fff" />
      </>
    ),
  },
  dp: {
    viewBox: "3.5 7 17 10",
    height: 12,
    body: (
      <>
        <path
          d="M4 7.5h11.5l4.5 3.4V15.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"
          fill="currentColor"
        />
        <rect x="6.5" y="9.4" width="9.5" height="1.8" rx=".7" fill="#fff" />
      </>
    ),
  },
  vga: {
    viewBox: "2 6 24 12",
    height: 10,
    body: (
      <>
        <path d="M3 6.5h22l-1.7 11H4.7L3 6.5z" fill="currentColor" />
        <g fill="#fff">
          <circle cx="7" cy="9" r=".9" />
          <circle cx="10.5" cy="9" r=".9" />
          <circle cx="14" cy="9" r=".9" />
          <circle cx="17.5" cy="9" r=".9" />
          <circle cx="21" cy="9" r=".9" />
          <circle cx="9" cy="15" r=".9" />
          <circle cx="12.2" cy="15" r=".9" />
          <circle cx="15.4" cy="15" r=".9" />
          <circle cx="18.6" cy="15" r=".9" />
        </g>
      </>
    ),
  },
  ps2: {
    viewBox: "3.5 3.5 17 17",
    height: 20,
    body: (
      <>
        <circle cx="12" cy="12" r="8.5" fill="currentColor" />
        <rect x="10.7" y="4.5" width="2.6" height="3" rx="1" fill="#fff" />
        <g fill="#fff">
          <circle cx="8.3" cy="10.3" r="1.05" />
          <circle cx="15.7" cy="10.3" r="1.05" />
          <circle cx="12" cy="11.4" r="1.05" />
        </g>
      </>
    ),
  },
  audio: {
    viewBox: "3.5 4 17 16",
    height: 18,
    body: (
      <>
        <circle cx="12" cy="12" r="8" fill="currentColor" />
        <circle cx="12" cy="12" r="4.6" fill="#fff" />
        <circle cx="12" cy="12" r="1.9" fill="currentColor" />
      </>
    ),
  },
};

/** Standalone glyph at normalized width (palette chips + faceplate cells). */
export function PortGlyph({ media }: { media: Media }) {
  const spec = PORT_GLYPHS[media];
  return (
    <svg width={GLYPH_W} height={spec.height} viewBox={spec.viewBox}>
      {spec.body}
    </svg>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/faceplate/portGlyphs.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/faceplate/portGlyphs.tsx src/features/device-library/faceplate/portGlyphs.test.tsx
git commit -m "feat: normalized port-type glyph set (10 media)"
```

---

## Task 5: `Faceplate` SVG renderer component

**Files:**
- Create: `src/features/device-library/faceplate/Faceplate.tsx`
- Test: `src/features/device-library/faceplate/Faceplate.test.tsx`

**Interfaces:**
- Consumes: `frameDims`, `screwHoles`, `layoutPortGroup`, `CELL_W`, `ROW_H`, `GLYPH_W` from `@/domain/faceplate-geometry`; `PORT_GLYPHS` from `./portGlyphs`; `Face` from `@/domain/faceplate`.
- Produces:
  - `interface FaceplateOptions { widthIn: number; rackUnits: number; rackMounted: boolean }`
  - `renderFace(face: Face, opts: FaceplateOptions): JSX.Element` — the reusable pure renderer.
  - `Faceplate({ face, widthIn, rackUnits, rackMounted, side }: { face: Face } & FaceplateOptions & { side?: "FRONT" | "BACK" }): JSX.Element` — thin wrapper delegating to `renderFace`, adding the optional FRONT/BACK label. Root element carries `data-testid="faceplate-svg"`; each screw hole carries `data-testid="screw-hole"`; each port cell group carries `data-testid="port-cell"`; the body/grid `<g>` carries `data-testid="faceplate-body"`.

Layout notes for the implementer:
- One composed `<svg>` sized `frameWidthPx × heightPx` (plus a small margin the label needs). Frame rect fill `#f7f8fa`, stroke `#cfd3da`.
- Ears: when `earWidthPx > 0`, draw a left ear rect `[0, earWidthPx]` and right ear rect `[frameWidthPx - earWidthPx, frameWidthPx]`, fill `#e6e9ee`.
- Body `<g>` translated by `earWidthPx` (so the grid is centered in the frame); port groups are positioned by their laid-out `x/y` within the body space.
- Each port cell: number text above (tabular-nums, `#4b5563`) and the glyph centered horizontally in `CELL_W`, vertically centered in `ROW_H`; flipped cells wrap the glyph in `transform="scale(1,-1)"` about the glyph center; label is exposed via the number text (visible) — the per-port name override replaces the number text.
- Screw holes: `<circle r="4" fill="#c3c8d0" stroke="#9aa1ab">` at each `{cx, cy}`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/device-library/faceplate/Faceplate.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Faceplate } from "./Faceplate";
import { emptyFace, type Face, type PortGroup } from "@/domain/faceplate";

function copperGroup(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g1",
    media: "copper",
    connectorType: "RJ45",
    idPrefix: "",
    countingDirection: "ltr",
    rows: 1,
    cols: 4,
    gridX: 0,
    gridY: 0,
    colSpacing: 0,
    rowSpacing: 0,
    portOverrides: {},
    ...over,
  };
}

describe("Faceplate", () => {
  it("renders one composed SVG at true 19in : 1.75in-per-U proportion when rack-mounted", () => {
    const { getByTestId } = render(
      <Faceplate face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted />,
    );
    const svg = getByTestId("faceplate-svg");
    // aspect ratio ~ 19 : 1.75
    const w = Number(svg.getAttribute("width"));
    const h = Number(svg.getAttribute("height"));
    expect(w / h).toBeCloseTo(19 / 1.75, 1);
  });

  it("draws screw holes when rack-mounted (4 for 1U)", () => {
    const { getAllByTestId } = render(
      <Faceplate face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted />,
    );
    expect(getAllByTestId("screw-hole")).toHaveLength(4);
  });

  it("drops the ears and screw holes when not rack-mounted, keeping the grid", () => {
    const { queryAllByTestId, getByTestId } = render(
      <Faceplate face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted={false} />,
    );
    expect(queryAllByTestId("screw-hole")).toHaveLength(0);
    expect(getByTestId("faceplate-body")).toBeInTheDocument();
  });

  it("renders one port cell per port in the group", () => {
    const face: Face = { portGroups: [copperGroup()], elements: [] };
    const { getAllByTestId } = render(
      <Faceplate face={face} widthIn={19} rackUnits={1} rackMounted />,
    );
    expect(getAllByTestId("port-cell")).toHaveLength(4);
  });

  it("shows the FRONT side label when provided", () => {
    const { getByText } = render(
      <Faceplate
        face={emptyFace()}
        widthIn={19}
        rackUnits={1}
        rackMounted
        side="FRONT"
      />,
    );
    expect(getByText("FRONT")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/faceplate/Faceplate.test.tsx`
Expected: FAIL — cannot resolve `./Faceplate`.

- [ ] **Step 3: Write minimal implementation**

Create `src/features/device-library/faceplate/Faceplate.tsx`:

```tsx
import type { Face } from "@/domain/faceplate";
import {
  frameDims,
  screwHoles,
  layoutPortGroup,
  CELL_W,
  ROW_H,
  GLYPH_W,
  type LaidOutPort,
} from "@/domain/faceplate-geometry";
import { PORT_GLYPHS } from "./portGlyphs";

export interface FaceplateOptions {
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
}

const LABEL_GUTTER = 22; // room for the vertical FRONT/BACK label on the right

function PortCell({ cell }: { cell: LaidOutPort }) {
  const spec = PORT_GLYPHS[cell.media];
  const gx = cell.x + CELL_W / 2; // glyph horizontal center
  const gy = cell.y + ROW_H / 2; // glyph vertical center
  const scale = GLYPH_W / 100000; // placeholder; see note below
  void scale;
  return (
    <g data-testid="port-cell">
      <text
        x={cell.x + CELL_W / 2}
        y={cell.y - 3}
        textAnchor="middle"
        fontSize={8}
        fontFamily="Inter, system-ui, sans-serif"
        style={{ fontVariantNumeric: "tabular-nums" }}
        fill="#4b5563"
      >
        {cell.label}
      </text>
      <g
        transform={`translate(${gx - GLYPH_W / 2}, ${gy - spec.height / 2})${
          cell.flipped ? ` translate(0, ${spec.height}) scale(1, -1)` : ""
        }`}
        color="#111418"
      >
        <svg width={GLYPH_W} height={spec.height} viewBox={spec.viewBox} overflow="visible">
          {spec.body}
        </svg>
      </g>
    </g>
  );
}

export function renderFace(face: Face, opts: FaceplateOptions) {
  const dims = frameDims(opts);
  const holes = screwHoles(dims, opts.rackUnits);
  const groups = face.portGroups.map(layoutPortGroup);
  const svgWidth = dims.frameWidthPx;
  const svgHeight = dims.heightPx;

  return (
    <>
      {/* frame */}
      <rect
        x={0}
        y={0}
        width={svgWidth}
        height={svgHeight}
        rx={6}
        fill="#f7f8fa"
        stroke="#cfd3da"
      />
      {/* ears */}
      {dims.earWidthPx > 0 && (
        <>
          <rect x={0} y={0} width={dims.earWidthPx} height={svgHeight} rx={6} fill="#e6e9ee" stroke="#cfd3da" />
          <rect
            x={svgWidth - dims.earWidthPx}
            y={0}
            width={dims.earWidthPx}
            height={svgHeight}
            rx={6}
            fill="#e6e9ee"
            stroke="#cfd3da"
          />
        </>
      )}
      {/* screw holes */}
      {holes.map((h, i) => (
        <circle
          key={i}
          data-testid="screw-hole"
          cx={h.cx}
          cy={h.cy}
          r={4}
          fill="#c3c8d0"
          stroke="#9aa1ab"
        />
      ))}
      {/* body / grid (centered by the ear offset) */}
      <g data-testid="faceplate-body" transform={`translate(${dims.earWidthPx}, 0)`}>
        {groups.flatMap((g) => g.cells.map((cell) => <PortCell key={`${g.id}-${cell.index}`} cell={cell} />))}
      </g>
    </>
  );
}

export function Faceplate({
  face,
  side,
  ...opts
}: { face: Face; side?: "FRONT" | "BACK" } & FaceplateOptions) {
  const dims = frameDims(opts);
  const width = dims.frameWidthPx + (side ? LABEL_GUTTER : 0);
  const height = dims.heightPx;
  return (
    <svg
      data-testid="faceplate-svg"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {renderFace(face, opts)}
      {side && (
        <text
          x={dims.frameWidthPx + LABEL_GUTTER / 2}
          y={height / 2}
          textAnchor="middle"
          transform={`rotate(90, ${dims.frameWidthPx + LABEL_GUTTER / 2}, ${height / 2})`}
          fontSize={11}
          fontWeight={600}
          fontFamily="Inter, system-ui, sans-serif"
          fill="#9aa1ab"
        >
          {side}
        </text>
      )}
    </svg>
  );
}
```

Implementer note on the glyph transform: the `scale` placeholder line above must be **removed** — the glyph is already authored at `GLYPH_W` width, so it is positioned by the `translate` only (no additional scaling). Draw the glyph via the nested `<svg>` as shown; the flip is a vertical mirror about the glyph's vertical center. Remove the two `scale`/`void scale` lines before running tests.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/faceplate/Faceplate.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all prior tests (28 from Slice 1) plus the new geometry/glyph/faceplate tests.

- [ ] **Step 6: Commit**

```bash
git add src/features/device-library/faceplate/Faceplate.tsx src/features/device-library/faceplate/Faceplate.test.tsx
git commit -m "feat: SVG Faceplate renderer with rack-mount geometry"
```

---

## Task 6: Visual preview route + verification

**Files:**
- Create: `src/app/device-library/preview/page.tsx`

**Interfaces:**
- Consumes: `Faceplate` from `@/features/device-library/faceplate/Faceplate`; `Face` from `@/domain/faceplate`.
- Produces: a static dev page at `/device-library/preview` reproducing the reference 10.6″ rack-mounted device from the mockup (USB-C single; USB-A over copper; 8 flipped copper; 2 flipped copper; 2 SFP), plus a stand-alone (rack-mounted off) variant, for browser verification.

- [ ] **Step 1: Create the preview page**

Create `src/app/device-library/preview/page.tsx`:

```tsx
import { Faceplate } from "@/features/device-library/faceplate/Faceplate";
import type { Face, PortGroup } from "@/domain/faceplate";

function g(over: Partial<PortGroup> & { id: string }): PortGroup {
  return {
    media: "copper",
    connectorType: "RJ45",
    idPrefix: "",
    countingDirection: "ltr",
    rows: 1,
    cols: 1,
    gridX: 0,
    gridY: 0,
    colSpacing: 2,
    rowSpacing: 3,
    portOverrides: {},
    ...over,
  };
}

// Reproduces the mockup's reference device left-to-right.
const referenceFace: Face = {
  elements: [],
  portGroups: [
    g({ id: "usbc", media: "usb_c", connectorType: "USB-C", cols: 1, gridX: 8, gridY: 8 }),
    g({ id: "usba", media: "usb_a", connectorType: "USB-A", cols: 1, gridX: 44, gridY: 8 }),
    g({ id: "cop-under", media: "copper", cols: 1, gridX: 44, gridY: 34 }),
    g({
      id: "cop8",
      cols: 8,
      gridX: 84,
      gridY: 20,
      portOverrides: { 0: { flipped: true }, 1: { flipped: true }, 2: { flipped: true }, 3: { flipped: true }, 4: { flipped: true }, 5: { flipped: true }, 6: { flipped: true }, 7: { flipped: true } },
    }),
    g({ id: "cop2", cols: 2, gridX: 300, gridY: 20, portOverrides: { 0: { flipped: true }, 1: { flipped: true } } }),
    g({ id: "sfp2", media: "sfp", connectorType: "SFP+", cols: 2, gridX: 380, gridY: 20 }),
  ],
};

export default function FaceplatePreviewPage() {
  return (
    <main style={{ fontFamily: "Inter, system-ui, sans-serif", padding: 32, color: "#1f2328" }}>
      <h1 style={{ fontSize: 18, fontWeight: 700 }}>Faceplate renderer — preview</h1>

      <h2 style={{ fontSize: 14, marginTop: 24 }}>10.6″ · 1U · Rack Mounted</h2>
      <div style={{ background: "#f6f7f9", border: "1px solid #eceef1", borderRadius: 12, padding: 16, display: "inline-block" }}>
        <Faceplate face={referenceFace} widthIn={10.6} rackUnits={1} rackMounted side="FRONT" />
      </div>

      <h2 style={{ fontSize: 14, marginTop: 24 }}>10.6″ · 1U · Stand-alone (ears off)</h2>
      <div style={{ background: "#f6f7f9", border: "1px solid #eceef1", borderRadius: 12, padding: 16, display: "inline-block" }}>
        <Faceplate face={referenceFace} widthIn={10.6} rackUnits={1} rackMounted={false} side="FRONT" />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Verify in the browser (preview workflow)**

Start the dev server and open `/device-library/preview`. Confirm visually:
- Rack-mounted device shows the 19″ frame with the grid centered and wide bridging ears; screw holes pinned near the outer edges; FRONT label to the right.
- Every port glyph renders at the same width; numbers sit above the ports; the 8-port and 2-port copper groups render flipped (mirrored) glyphs; SFP renders as a solid cage.
- Stand-alone variant drops the ears and holes; the grid stays the same size and position.
- If any glyph looks visually off-width or mis-cropped, tune its `viewBox`/`height` in `portGlyphs.tsx` (width stays `GLYPH_W`) and re-verify. Take a screenshot for the record.

- [ ] **Step 3: Run the full suite + lint**

Run: `npm test && npm run lint`
Expected: PASS / no lint errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/device-library/preview/page.tsx
git commit -m "feat: faceplate renderer preview page"
```

- [ ] **Step 5: Finish the branch**

Use the `superpowers:requesting-code-review` skill for a whole-branch review, then `superpowers:finishing-a-development-branch` to open the PR against `main` (HTTPS remote, `gh` CLI). Update `docs/superpowers/notes/RESUME.md` and the project memory to mark Slice 2 complete and Slice 3 (the interactive editor) next.

---

## Self-Review

**Spec coverage (Phase 2a §5, §7, §9, §11):**
- §5 1U proportion → Task 1 (`frameDims`, `PX_PER_IN`) + Task 5 aspect test. ✅
- §5 rack-mount geometry (locked 19″ frame, centered body, gap-filling ears) → Task 1 + Task 5 body offset. ✅
- §5 screw holes pinned near rails, scale with U → Task 2. ✅
- §5 rack-mounted off drops ears, grid unchanged → Task 1 (`frameDims` off-path) + Task 5 test. ✅
- §5 FRONT/BACK side label → Task 5 `side`. ✅
- §5 uniform-width port cells & normalized glyph width → Task 1 `CELL_W`/`GLYPH_W` + Task 4 test. ✅
- §5 vertical centering by icon → Task 5 `PortCell` (glyph centered in `ROW_H`). ✅
- §5 numbers above/below with tabular figures → Task 3 numbering + Task 5 `text`. ✅
- §5 flipped ports mirror glyph, label unaffected → Task 3 `flipped` + Task 5 transform. ✅
- §7 our own 10 port glyphs, currentColor, width-normalized → Task 4. ✅
- §9 SVG, pure `renderFace(face, {widthIn,rackUnits,rackMounted})`, reusable → Task 5. ✅
- §11 unit tests (ear width, numbering, width normalization, face→renderable) → Tasks 1–4; component tests (rack-mount toggle drops ears, holds grid) → Task 5. ✅
- Selection UI, spacing handle, chevrons, drag, Text/Icon elements → **out of scope** (Slice 3/4), intentionally deferred. ✅

**Placeholder scan:** One deliberate `scale` placeholder in Task 5 Step 3 is called out with an explicit "remove these lines" instruction before the tests run — no silent TODOs. All test code is complete and concrete.

**Type consistency:** `frameDims`, `screwHoles`, `layoutPortGroup`, `FrameDims`, `LaidOutPort`, `LaidOutGroup`, `PORT_GLYPHS`, `PortGlyph`, `renderFace`, `Faceplate`, `FaceplateOptions` are named identically across their producing and consuming tasks. Constants `CELL_W`/`ROW_H`/`GLYPH_W`/`PX_PER_IN` are defined once in Task 1 and reused by name. `PortGroup`/`Face`/`Media`/`CountingDirection`/`MEDIA` come from the existing `src/domain/faceplate.ts`.
```
