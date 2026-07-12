# Phase 2a · Slice 3e — Editor Rendering & Layout Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the editor render the whole device legibly at any window size (scaled to fit, controls aligned), show ears + screw holes by default, restore the mockup's Port Types + Elements palette, and give the selected port a blue tile box.

**Architecture:** `EditorCanvas` wraps the pure `Faceplate` SVG and its interactive overlay in one CSS `transform: scale` container (scale measured via ResizeObserver, default 1); pointer input is converted screen→device by dividing by the scale, so overlay math stays in device pixels. Default body width becomes 17.5″. The palette is restructured (Text/Icon inert). `Faceplate`/geometry are untouched.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, SVG, CSS transforms, ResizeObserver, Vitest 2 + @testing-library/react (jsdom).

## Global Constraints

- **Next.js 16 + React 19 + TypeScript 5**; path alias `@/` → `src/`.
- **`Faceplate` and `faceplate-geometry` are NOT modified** this slice — scaling is a container/overlay concern; the 3d layout already keeps labels in bounds.
- **Fit-to-window:** `scale = min(1, availableWidth / svgWidthPx)` (never upscale past 1); default `scale = 1` when unmeasured (jsdom has no ResizeObserver, so all component tests run at 1:1 — existing behavior unchanged).
- **Pointer input divides by scale** in every handler that reads client coordinates (drop, move, spacing, chevron). At `scale === 1` this is a no-op.
- **Default body width `17.5″`** (frame stays the 19″ rail span → 0.75″ ears each side, ears + screw holes visible by default).
- **Palette:** Port Types section (10 draggable media chips) + Elements section (Text, Icon chips, **inert** — not draggable, no handlers; Slice 4 wires them).
- **Selected-port blue tile box** (`data-testid="port-select-box"`, `pointer-events: none`) around the glyph box extended by `LABEL_H` on the label side, in `#2d5bff`.
- No data-model change (per-port media / propagation are Slice 3f).
- Tests: Vitest, one behaviour per `it`. `npm test`. Do **not** run `npm run lint` (pre-existing repo-wide failure).
- Work on branch `phase-2a-slice-3e` (already cut from `phase-2a-slice-3d`).
- TDD, DRY, YAGNI, frequent commits.

---

## File Structure

- **Modify** `src/features/device-library/editor/useDeviceDraft.ts` (+ `.test.ts`) — `emptyDraft().widthIn = 17.5` (Task 1).
- **Modify** `src/features/device-library/editor/RackDeviceEditor.tsx` (+ its test) — palette restructured into Port Types + Elements sections (Task 2).
- **Modify** `src/features/device-library/editor/EditorCanvas.tsx` (+ `.test.tsx`) — blue tile selection box (Task 3); fit-to-window scaling + pointer-coord conversion (Task 4).

---

## Task 1: Default body width 17.5″

**Files:**
- Modify: `src/features/device-library/editor/useDeviceDraft.ts`
- Test: `src/features/device-library/editor/useDeviceDraft.test.ts`

**Interfaces:**
- Produces: `emptyDraft().widthIn === 17.5`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/device-library/editor/useDeviceDraft.test.ts`:

```ts
import { emptyDraft } from "./useDeviceDraft";

describe("emptyDraft defaults (3e)", () => {
  it("defaults the body width to 17.5in so a new device shows ears", () => {
    expect(emptyDraft().widthIn).toBe(17.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/editor/useDeviceDraft.test.ts`
Expected: FAIL — `widthIn` is `19`.

- [ ] **Step 3: Implement**

In `src/features/device-library/editor/useDeviceDraft.ts`, change the `emptyDraft` default:

```ts
export function emptyDraft(): DeviceDraft {
  return {
    name: "", brandId: null, deviceTypeId: "",
    rackUnits: 1, widthIn: 17.5, rackMounted: true,
    activeSide: "front", frontFace: emptyFace(), backFace: emptyFace(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/useDeviceDraft.test.ts`
Expected: PASS.

Then run the full suite to confirm nothing assumed the old default:

Run: `npm test`
Expected: PASS — all tests. (If any test rendered a default-draft device and asserted zero screw holes, update it: a default device now has ears + holes. None are expected to.)

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/useDeviceDraft.ts src/features/device-library/editor/useDeviceDraft.test.ts
git commit -m "feat: default new-device body width to 17.5in (ears + screw holes visible)"
```

---

## Task 2: Palette restructure (Port Types + Elements)

**Files:**
- Modify: `src/features/device-library/editor/RackDeviceEditor.tsx`
- Modify: `src/features/device-library/editor/RackDeviceEditor.test.tsx`

**Interfaces:**
- Consumes: `MEDIA`/`MEDIA_LABELS`, `PortGlyph` (existing).
- Produces: the palette renders a **Port Types** section (draggable media chips) and an **Elements** section with **Text** and **Icon** chips (inert). Test hooks: the text "Port Types" and "Elements" render; `data-testid="element-text"` and `data-testid="element-icon"` chips exist and are NOT `draggable`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/device-library/editor/RackDeviceEditor.test.tsx`:

```tsx
describe("RackDeviceEditor — palette sections (3e)", () => {
  it("renders Port Types and Elements sections; Text/Icon are inert", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    expect(screen.getByText("Port Types")).toBeInTheDocument();
    expect(screen.getByText("Elements")).toBeInTheDocument();
    const text = screen.getByTestId("element-text");
    const icon = screen.getByTestId("element-icon");
    expect(text).not.toHaveAttribute("draggable", "true");
    expect(icon).not.toHaveAttribute("draggable", "true");
    // a media chip is still draggable
    expect(screen.getByTitle("Copper").getAttribute("draggable")).toBe("true");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: FAIL — no "Port Types"/"Elements" sections.

- [ ] **Step 3: Implement**

In `src/features/device-library/editor/RackDeviceEditor.tsx`, replace the single media-chip box (the `<div className="flex flex-wrap gap-2 rounded-lg border border-neutral-200 bg-white p-2">…</div>` block) with two labelled sections:

```tsx
            <div className="flex items-stretch gap-2">
              <span className="flex items-center justify-center text-[10px] font-medium text-neutral-400" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Port Types</span>
              <div className="flex flex-wrap gap-2 rounded-lg border border-neutral-200 bg-white p-2">
                {MEDIA.map((m) => (
                  <span key={m} draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", m)}
                    className="flex cursor-grab items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-800" title={MEDIA_LABELS[m]}>
                    <span className="text-neutral-900"><PortGlyph media={m} /></span>{MEDIA_LABELS[m]}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-stretch gap-2">
              <span className="flex items-center justify-center text-[10px] font-medium text-neutral-400" style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}>Elements</span>
              <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-white p-2" title="Text and Icon elements arrive in a later slice">
                <span data-testid="element-text" className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-400">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 20l6 -16l2 0l7 16" /><path d="M4 20l3 0" /><path d="M14 20l7 0" /><path d="M6.9 15l6.9 0" /></svg>
                  Text
                </span>
                <span data-testid="element-icon" className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-400">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="6.5" cy="6.5" r="3.5" /><path d="M2.5 21h8l-4 -7z" /><path d="M14 3l7 7" /><path d="M14 14h7v7h-7z" /></svg>
                  Icon
                </span>
              </div>
            </div>
```

(These two `<div className="flex items-stretch gap-2">` blocks replace the single media-chip `<div>`; the surrounding `<div className="mb-3 flex flex-wrap items-start gap-3">` and the Front/Back + Rack-Mounted `<div className="ml-auto ...">` stay as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: PASS (existing editor tests + the new palette test). The drop tests still pass — media chips keep the same `draggable` + `onDragStart`, and the drop handler is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/RackDeviceEditor.tsx src/features/device-library/editor/RackDeviceEditor.test.tsx
git commit -m "feat: restructure palette into Port Types + Elements sections (Text/Icon inert)"
```

---

## Task 3: Blue tile selection box

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: `LABEL_H` from `@/domain/faceplate-geometry`; `laid.cells[i].labelPos` (3d).
- Produces: for the selected port (`selectedGroupId` + `selectedPortIndex`), the overlay renders `data-testid="port-select-box"` — a `#2d5bff` outline box around the tile (glyph box + `LABEL_H` on the label side), `pointer-events: none`.

- [ ] **Step 1: Write the failing test**

Append to `src/features/device-library/editor/EditorCanvas.test.tsx`:

```tsx
describe("EditorCanvas port tile selection box (3e)", () => {
  it("renders a blue tile box for the selected port only", () => {
    const { queryByTestId, rerender } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" onSelect={() => {}} onSelectPort={() => {}} />,
    );
    expect(queryByTestId("port-select-box")).toBeNull();
    rerender(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT"
        selectedGroupId="g1" selectedPortIndex={1} onSelect={() => {}} onSelectPort={() => {}} />,
    );
    const box = queryByTestId("port-select-box");
    expect(box).not.toBeNull();
    expect(box!.getAttribute("style")).toContain("#2d5bff");
    expect(box!.style.pointerEvents).toBe("none");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — no `port-select-box`.

- [ ] **Step 3: Implement**

In `EditorCanvas.tsx`, add `LABEL_H` to the geometry import:

```tsx
import { frameDims, layoutPortGroup, CELL_W, ROW_H, LABEL_H } from "@/domain/faceplate-geometry";
```

Inside the per-cell map, render the tile box for the selected port. Replace the `laid.cells.map(...)` block with one that also emits the box:

```tsx
                    {laid.cells.map((cell) => {
                      const localX = cell.x - g.gridX + SEL_PAD;
                      const localY = cell.y - boxTop + SEL_PAD;
                      const isSelPort = cell.index === props.selectedPortIndex;
                      const boxTopY = cell.labelPos === "top" ? localY - LABEL_H : localY;
                      return (
                        <div key={cell.index}>
                          <div
                            data-testid={`port-target-${cell.index}`}
                            onClick={(e) => { e.stopPropagation(); props.onSelectPort?.(cell.index); }}
                            style={{ position: "absolute", left: localX, top: localY, width: CELL_W, height: ROW_H, cursor: "pointer", zIndex: 5 }}
                          />
                          {isSelPort && (
                            <div
                              data-testid="port-select-box"
                              style={{ position: "absolute", left: localX - 2, top: boxTopY - 2, width: CELL_W + 4, height: ROW_H + LABEL_H + 4, border: "1.5px solid #2d5bff", borderRadius: 4, pointerEvents: "none", zIndex: 6 }}
                            />
                          )}
                        </div>
                      );
                    })}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS (all EditorCanvas tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: blue tile selection box around the selected port"
```

---

## Task 4: Fit-to-window scaling + verification

**Files:**
- Modify: `src/features/device-library/editor/EditorCanvas.tsx`
- Modify: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Produces:
  - `toDevicePos(client: { x: number; y: number }, rect: { left: number; top: number }, scale: number, earX: number): Pos` — exported pure helper: `{ x: (client.x − rect.left)/s − earX, y: (client.y − rect.top)/s }` with `s = scale || 1`.
  - `EditorCanvas` renders a fit wrapper (`data-testid="editor-canvas-fit"`, width 100%) → a sized box (`svgW*scale × svgH*scale`) → a `transform: scale(scale)` div → the existing `editor-canvas`. `scale` from a ResizeObserver (default 1). All client-delta handlers divide by `scaleRef.current`.

- [ ] **Step 1: Write the failing tests**

Append to `src/features/device-library/editor/EditorCanvas.test.tsx`:

```tsx
import { toDevicePos } from "./EditorCanvas";

describe("toDevicePos (3e scaling)", () => {
  it("at scale 1, subtracts the rect origin and ear offset", () => {
    expect(toDevicePos({ x: 150, y: 40 }, { left: 50, top: 10 }, 1, 20)).toEqual({ x: 80, y: 30 });
  });
  it("at scale 0.5, divides the in-rect offset by the scale before removing the ear", () => {
    // in-rect offset (100, 30) / 0.5 = (200, 60); x minus earX 20 = 180
    expect(toDevicePos({ x: 150, y: 40 }, { left: 50, top: 10 }, 0.5, 20)).toEqual({ x: 180, y: 60 });
  });
  it("treats scale 0 as 1 (guard)", () => {
    expect(toDevicePos({ x: 30, y: 10 }, { left: 0, top: 0 }, 0, 0)).toEqual({ x: 30, y: 10 });
  });
});

describe("EditorCanvas fit wrapper (3e)", () => {
  it("wraps the canvas in a fit container and still renders the faceplate + overlay", () => {
    const { getByTestId } = render(
      <EditorCanvas face={faceWithGroup} widthIn={19} rackUnits={1} rackMounted side="FRONT" onSelect={() => {}} />,
    );
    const fit = getByTestId("editor-canvas-fit");
    expect(fit.querySelector('[data-testid="faceplate-svg"]')).not.toBeNull();
    expect(fit.querySelector('[data-testid="editor-overlay"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — `toDevicePos` not exported / no `editor-canvas-fit`.

- [ ] **Step 3: Implement**

In `EditorCanvas.tsx`:

Add the exported helper near the bottom (next to `chevronStyle`):

```tsx
export function toDevicePos(
  client: { x: number; y: number }, rect: { left: number; top: number }, scale: number, earX: number,
): Pos {
  const s = scale || 1;
  return { x: (client.x - rect.left) / s - earX, y: (client.y - rect.top) / s };
}
```

Add scale state + a mirror ref + the ResizeObserver effect (place after `const earX = ...`):

```tsx
  const LABEL_GUTTER = 22; // matches Faceplate's FRONT/BACK gutter (side is always set here)
  const svgW = dims.frameWidthPx + LABEL_GUTTER;
  const svgH = dims.heightPx;
  const outerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);

  useEffect(() => {
    const el = outerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const apply = () => {
      const avail = el.clientWidth;
      const s = avail > 0 ? Math.min(1, avail / svgW) : 1;
      scaleRef.current = s;
      setScale(s);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [svgW]);
```

Convert the client-delta handlers to device space by dividing by `scaleRef.current`:

- In the move effect's `onMove`/`onUp`, divide the deltas:

```tsx
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      setDrag((d) => (d ? { ...d, dx: (e.clientX - d.startX) / s, dy: (e.clientY - d.startY) / s } : d));
    }
    function onUp(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const dx = (e.clientX - drag!.startX) / s;
      const dy = (e.clientY - drag!.startY) / s;
      if (dx !== 0 || dy !== 0) {
        props.onMove?.(drag!.id, { x: drag!.origX + dx, y: drag!.origY });
      }
      setDrag(null);
    }
```

- In the chevron effect's `onMove`, divide the distance:

```tsx
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const step = d.axis === "col" ? CELL_W : ROW_H;
      const dist = (d.axis === "col" ? e.clientX - d.start : e.clientY - d.start) / s;
      const want = Math.max(0, Math.floor(dist / step));
      for (let i = chevAddedRef.current; i < want; i++) {
        if (d.axis === "col") props.onAddColumn?.(d.id);
        else props.onAddRow?.(d.id);
      }
      if (want > chevAddedRef.current) chevAddedRef.current = want;
    }
```

- In the spacing effect's `onMove`, divide the deltas:

```tsx
    function onMove(e: PointerEvent) {
      const s = scaleRef.current || 1;
      const sd = spaceDrag!;
      const colSpacing = Math.max(0, Math.min(sd.maxCol, sd.grabCol + (e.clientX - sd.startX) / s));
      const rowSpacing = Math.max(0, Math.min(sd.maxRow, sd.grabRow + (e.clientY - sd.startY) / s));
      props.onSpacing?.(sd.id, { colSpacing, rowSpacing });
    }
```

- Replace `dropPos` to use the helper + scale:

```tsx
  function dropPos(e: React.DragEvent): Pos {
    const rect = overlayRef.current?.getBoundingClientRect();
    return toDevicePos({ x: e.clientX, y: e.clientY }, { left: rect?.left ?? 0, top: rect?.top ?? 0 }, scaleRef.current, earX);
  }
```

Wrap the returned tree in the fit container. Change the top of the `return (` to:

```tsx
  return (
    <div ref={outerRef} data-testid="editor-canvas-fit" style={{ width: "100%" }}>
      <div style={{ width: svgW * scale, height: svgH * scale }}>
        <div style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
          <div data-testid="editor-canvas" style={{ position: "relative", display: "inline-block" }}>
            <Faceplate face={face} widthIn={widthIn} rackUnits={rackUnits} rackMounted={rackMounted} side={side} highlight={props.highlight} />
            {editing && (
              /* …the existing overlay <div data-testid="editor-overlay"> … unchanged … */
            )}
          </div>
        </div>
      </div>
    </div>
  );
```

(Keep the existing `editor-canvas` / `editor-overlay` / group-map JSX exactly as-is inside the new wrappers — only the outer three wrapper `<div>`s and the closing tags are added.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS. In jsdom `ResizeObserver` is undefined so `scale` stays `1` — all existing drag/drop/chevron/spacing/move tests are unchanged (every `/s` is `/1`).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — all tests across the suite.

- [ ] **Step 6: Browser verification (controller) — the whole 3e flow**

With Supabase running, open `/device-library` → Create. Verify:
- The **whole default device fits** the canvas (scaled), with **ears + screw holes visible** (default 17.5″ body), no horizontal scroll.
- The **palette** shows a Port Types section (draggable chips) and an Elements section with inert Text/Icon chips.
- Drag a chip onto the grid — the group lands where dropped (scaled coords correct); select a port — the **blue tile box** surrounds its icon+label and the tile recolors blue.
- Chevron click/drag, group move, and the spacing handle all land correctly under scaling (drops/drags map to the right ports).
- Add a 2nd row — both rows' labels are visible; toggle a label top/bottom — it stays visible.
- Resize the browser narrower/wider — the device rescales to fit; controls stay aligned.
- Save + reopen via Edit — everything round-trips. Take a screenshot.

Fix any issues by editing source and re-running from Step 5.

- [ ] **Step 7: Commit + finish the branch**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: fit-to-window device scaling with scale-aware pointer input"
```

Then run `superpowers:requesting-code-review` (whole-branch), address findings, and `superpowers:finishing-a-development-branch` to open the stacked PR (base = `phase-2a-slice-3d`). Update `docs/superpowers/notes/RESUME.md` and project memory: Slice 3e done; Slice 3f (bidirectional chevrons, override propagation + index remap, per-port media replace) next.

---

## Self-Review

**Spec coverage:**
- Fit-to-window scaling (scale wrapper + ResizeObserver + pointer /scale) → Task 4. ✅
- Default body width 17.5″ (ears/holes by default) → Task 1. ✅
- Palette restructure (Port Types + Elements, Text/Icon inert) → Task 2. ✅
- Labels always visible → delivered by Task 4's fit (whole device visible); no geometry change; browser-verified in Task 4 Step 6. ✅
- Blue tile selection box → Task 3. ✅
- `Faceplate`/geometry untouched; no data-model change → all tasks. ✅

**Placeholder scan:** No TODO/TBD. The `/* …existing overlay… */` marker in Task 4 Step 3 is an explicit "keep the existing JSX unchanged inside the new wrappers" instruction (the overlay code already exists verbatim in the file), not a placeholder to write new logic. All test code is complete.

**Type consistency:** `toDevicePos(client, rect, scale, earX): Pos` (Task 4) matches its test and `dropPos` caller. `scale`/`scaleRef`/`svgW`/`svgH` are introduced and consumed within Task 4. `LABEL_H` (Task 3) and `CELL_W`/`ROW_H` come from the geometry module. `emptyDraft` (Task 1) is the existing hook export. Palette test hooks `element-text`/`element-icon` (Task 2) match the JSX. `port-select-box` (Task 3) matches its test.
```
