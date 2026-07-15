# Drag a device type onto the rack — design

**Status:** approved (2026-07-15)
**Scope:** feature 1 of 3 (see [Decomposition](#decomposition))

## Goal

Press a device type in the DEVICES palette and drag it onto the rack. The dragged thing is a
blank white device that is pulled out of the chip like a piece of gooey slime, stretching until it
reaches the size of one RU, at which point it elastically snaps solid and can be carried. While it
is over a free RU that RU's rails light up exactly as they do on mouseover, showing where the
device will go. Releasing there opens the existing "Add device" window at that RU.

## Decomposition

The original request covered three independent features. Each ships working software on its own and
gets its own spec → plan → build cycle. This spec is **feature 1**. Build order 1 → 2 → 3.

| # | Feature | Spec |
|---|---------|------|
| 1 | Palette drag with the goo pull, rail highlight, drop → picker at that RU | this document |
| 2 | Smart placement: fit a multi-RU device *including* the dropped RU; else carry-on-cursor with a red invalid tint, Esc/right-click to cancel | not yet written |
| 3 | Inline "Create Custom Device": the editor animates over the picker, device type locked to the picker's active type, save → re-fetch that type's templates and pre-select the new one | not yet written |

Feature 1 is **purely additive**: the drop hands `atU` to the existing `insertTemplate` unchanged, so
the current add-device path cannot regress.

## Current behaviour this builds on

Established by reading the code, not assumed:

- **The palette lives in `RackBuilder.tsx`** (~line 212). Each chip is a `<button
  data-testid={`palette-type-${t.code}`}>` whose `onClick` does `setPicker({ initialTypeId: t.id,
  atU: null })`. `types` are the `device_types` rows with `category === "rack"`, passed from
  `src/app/racks/[id]/page.tsx`.
- **`RackCanvas.tsx`** already owns `hoverU` state. Free-RU hit strips (`ru-hit-{u}`) set it on
  `mouseenter` and clear it on `mouseleave`. **Strips exist only for free RUs**, which is exactly the
  "free RUs only" highlight this feature wants.
- **`RackFrame.tsx`** takes `hoverU` and lights that RU's rails in `RK_SELECT`, and darkens that RU's
  ⊕ marker. Nothing new is needed for the highlight.
- **`renderFace(face, opts)`** (`src/features/device-library/faceplate/Faceplate.tsx`) draws the
  frame, the ears and the outline. With `emptyFace()` (`@/domain/faceplate`) and
  `{ widthIn: 17.5, rackUnits: 1, rackMounted: true }` it draws precisely "a blank white box with
  ears" — the visual this feature needs, with no new artwork.
  Use **17.5**, not 19: `frameDims` sets `frameWidthIn = rackMounted ? RAIL_WIDTH_IN : bodyWidthIn`,
  so any rack-mounted device is `RACK_INTERIOR_W` (912px) wide regardless of `widthIn` — but 19 is an
  *invalid body width* (`isValidBodyWidth` rejects `> MAX_BODY_WIDTH_IN`, which is 17.5) that would
  only render correctly by accident, via the `Math.min(widthIn, MAX_BODY_WIDTH_IN)` clamp. 17.5 is
  the value every real template and test uses, and it yields the same 0.75" ears.
- **`findFreeSlot(placements, ru, heightU, rackHeight, preferredU = 1)`** returns every placeable
  `startU` sorted by `|u - preferredU|`, or `null` only when the device fits nowhere.
  `insertTemplate` already passes `picker.atU` as `preferredU`, so **a drop at U5 already lands on
  the valid `startU` nearest to 5**. It is not a dead end. (The gap — that the nearest span need not
  *contain* U5 — is feature 2's problem, not this one's.)
- **Existing drag idiom:** the grip drag and the ear press-drag in `RackCanvas` use
  `pointerdown` → arm a ref → `window` `pointermove`/`pointerup`, writing the DOM **imperatively**
  per frame with no React re-render. This feature follows that idiom.

## Interaction

A three-state machine. `t` is eased pull progress, `0 → 1`, driven by pointer distance from the chip.

```
idle ──pointerdown on chip──> pulling(t) ──t reaches 1──> solid ──pointerup over free RU──> drop
                                   │                        │
                                   └──pointerup / Esc───────┴──> snap back ──> idle
```

| | `t = 0` | `t = 1` |
|---|---|---|
| box size | chip-sized blob | full RU: `RACK_INTERIOR_W × RU_PX`, times the canvas scale |
| neck | thick, chip-width | thinned away, snaps |
| latch | — | springs solid (`easeOutElastic` overshoot) |

Rules:

- **Solidifying latches one-way.** Once `t` reaches 1 the box stays solid even if the pointer moves
  back toward the chip — a piece broken off slime does not re-attach.
- **Anything other than a drop on a free RU snaps the box back into the chip** and opens nothing.
  That includes releasing before it solidifies, releasing away from the rack, releasing over an
  occupied RU, and pressing Esc. This reuses the vocabulary of the patch cable's existing
  "sucked back in" recoil rather than inventing a new idiom.
- **Only the primary button pulls** (`e.button !== 0` → ignore).
- The box carries **no ports**: a *type* has no port layout. Ports appear only once a template is
  chosen in the picker.
- **Only a solid box can be dropped.** Releasing over a free RU while still `pulling` (`t < 1`) snaps
  back like any other non-drop. The rails still light during the pull — that follows automatically
  from `mouseenter` and is harmless feedback — but the *drop* is gated on `solid`. This is why
  `RackCanvas` takes `dropArmed`, not merely "a pull is happening".

### The trailing-click wrinkle

A strip's `onClick` fires immediately after `pointerup` and would call `onAddAt(u)` →
`setPicker({ initialTypeId: null, … })`, clobbering the dragged type with the "Select type" list.

Resolution: the drop is committed on the strip's **`onPointerUp`** (which fires before `click`), and a
short-lived ref suppresses the trailing click. This is load-bearing and has an explicit test.

## Architecture

Follows the existing pure-ops + view split (`connectionOps`/`PatchLayer`, `endpointOps`/`EndpointFaceView`).

| file | responsibility |
|---|---|
| `src/features/racks/palettePull.ts` *(new, pure)* | `pullProgress(dist)→t`, `neckPath(chip, box, t)`, `boxRect(t, scale)`, `easeOutElastic`. No React, no DOM. TDD'd. |
| `src/features/racks/PalettePullLayer.tsx` *(new)* | `fixed`, `pointer-events:none` overlay above palette and canvas. Renders the neck + blank box; runs the latch spring and the snap-back. |
| `src/features/racks/RackBuilder.tsx` *(modify)* | Owns pull state. Chips get `onPointerDown` + `touch-action: none`. Renders `PalettePullLayer`. A drop calls the existing `setPicker({ initialTypeId, atU })`. |
| `src/features/racks/RackCanvas.tsx` *(modify)* | New props `dropArmed: boolean` and `onDropAt: (u: number) => void`. Strips commit the drop on `pointerUp` **only when `dropArmed`**; ref guard swallows the trailing click. The canvas never learns the type id — it only reports which RU was hit, which keeps its contract narrow. |

### Data flow

1. `pointerdown` on chip → `RackBuilder` arms pull `{ typeId, chipRect, x, y }`.
2. `window` `pointermove` → position updates written imperatively per frame (no React render).
3. Pointer crosses a free-RU strip → the strip's existing `mouseenter` sets `hoverU` → `RackFrame`
   lights the rails. **No new geometry.** Pointer events, unlike native HTML5 drag-and-drop, do not
   suppress mouse events, which is what makes this free.
4. Release:
   - over a free RU **and solid** → strip's `onPointerUp` → `onDropAt(u)` → `setPicker({ initialTypeId: pull.typeId, atU: u })`; pull cleared with no snap-back.
   - otherwise (not solid, not over a free RU, or Esc) → `window` `pointerup` → snap-back → idle.

### Why pointer events, not native DnD

Native HTML5 drag-and-drop gives one static drag image, so the elastic goo is impossible with it.
It also needs `dragenter` plumbing to rebuild the rail highlight (`mouseenter` does not fire during a
native drag), and has no touch support. Feature 2's carry mode (move with **no** button held, click to
release) cannot be built on native DnD either, so choosing pointer events keeps **one** mechanism for
both features instead of two.

## Performance

React state changes only on pull start and end. Per-frame updates write the DOM directly, matching
the comment already in `RackCanvas`: the dragged thing must track the pointer 1:1 with zero render
latency. A re-render per frame would be worse for the goo than for the existing drags.

## Tuning

`PULL_DIST` and the spring constants are starting guesses to be tuned in the browser, exactly as the
patch cable's rope physics were. Initial values: `PULL_DIST = 140` px, `easeOutElastic` on latch.
Expect revision from live feedback ("more gooey", "slower").

## Error handling and edge cases

| case | behaviour |
|---|---|
| Release before `t = 1` | Snap back. No picker. |
| Release away from the rack, or over an occupied RU | Snap back. No picker. |
| Esc during pull | Snap back. No picker. |
| Non-primary button (right-click) | No pull at all. |
| Canvas zoomed mid-pull | Box size recomputes from the live scale each frame. |
| Touch | Works via pointer events; chips need `touch-action: none` so the page does not scroll instead. |
| Pull while the picker is open | Not reachable — the picker is a `fixed inset-0 z-[70]` modal over the palette. |

## Testing

Run tests **by explicit filename only** — never a directory or glob. `repository.integration.test.ts`
and `locations/repository.integration.test.ts` delete all `sites` and wipe the local database.

- **`palettePull.test.ts`** (pure, TDD): `t` clamps to `0..1`; the neck thins monotonically as `t`
  rises; the box is *exactly* `RACK_INTERIOR_W × RU_PX` at `t = 1`; latch is one-way.
- **`RackCanvas.test.tsx`**: a strip commits the correct `u` on `pointerup` when `dropArmed`; **the
  trailing click does not call `onAddAt`**; nothing is committed when `dropArmed` is false (covers
  both "no pull" and "pull not yet solid"); the normal click→`onAddAt` path still works when idle.
- **`RackBuilder.test.tsx`**: chip press arms a pull; a drop opens the picker with
  `{ initialTypeId, atU }`; release off-rack opens nothing.
- **Browser (non-destructive)**: pull a chip, confirm the box reaches RU size and the rails light at
  the hovered RU; release off-rack and confirm no picker opened and no database write occurred.

## Out of scope

- Fit-including-anchor and carry mode → feature 2.
- Inline "Create Custom Device" → feature 3.
- Dragging *existing* devices between RUs — already works via the ear press-drag.
