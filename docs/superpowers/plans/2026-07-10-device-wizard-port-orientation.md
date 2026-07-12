# Device Wizard — Per-Row Port Orientation Implementation Plan

> **For agentic workers:** small 3-file extension of the existing two-stage pipeline; execute inline with TDD (superpowers:test-driven-development). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Detect per-row port orientation (tab up/down) and apply it as port `rotation` so two-row switches come out mirrored.

**Tech Stack:** TypeScript strict, Vitest. Extends `src/features/device-library/ai/*`.

## Global Constraints

- Two-stage: model reports semantic `"up"`/`"down"` per row; layout computes the `rotation` degrees. No pixels/degrees from the model.
- Non-destructive: no `rowOrientations` → rotation left unset (current behavior unchanged).
- Axis: `"up"` → `rotation 180`, `"down"` → `rotation 0` (matches editor "Flip" = 180°). No 90/270.
- Validate model output; co-locate tests; `npx vitest run <path>`.

---

## Task 1: Contract + validation (`aiDetect.ts`)

**Files:** Modify `src/features/device-library/ai/aiDetect.ts`; Test `aiDetect.test.ts`.

- [ ] **Step 1 — failing tests** (append to the `validateDetectedFace` describe):

```ts
it("keeps valid rowOrientations and clamps to the row count", () => {
  const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 24, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, rowOrientations: ["down", "up", "up"] }], confidence: "high" });
  expect(f.groups[0].rowOrientations).toEqual(["down", "up"]); // clamped to rows=2
});
it("coerces unknown orientation values to 'down'", () => {
  const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, rowOrientations: ["sideways", "up"] }], confidence: "low" });
  expect(f.groups[0].rowOrientations).toEqual(["down", "up"]);
});
it("omits rowOrientations when not an array", () => {
  const f = validateDetectedFace({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 1, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 }, rowOrientations: "up" }], confidence: "low" });
  expect(f.groups[0].rowOrientations).toBeUndefined();
});
```

- [ ] **Step 2 — run, expect FAIL** (`npx vitest run src/features/device-library/ai/aiDetect.test.ts`).

- [ ] **Step 3 — implement.** In `DetectedGroup`, add `rowOrientations?: ("up" | "down")[]`. In `coerceGroup`, after `rows` is computed, add:

```ts
const rowOrientations = Array.isArray(r.rowOrientations)
  ? r.rowOrientations.slice(0, /* rows */ clamp(Math.round(num(r.rows, 1)), 1, 4)).map((v) => (v === "up" ? "up" : "down"))
  : undefined;
```
(Reuse the already-computed clamped `rows` value rather than recomputing — bind it to a `const rows = ...` if not already, then `.slice(0, rows)`.) Include `rowOrientations` in the returned group object (its value is `("up"|"down")[] | undefined`, so an absent input yields an absent field).

- [ ] **Step 4 — run, expect PASS.** Then `npx tsc --noEmit`.

- [ ] **Step 5 — commit:** `git add -A && git commit -m "feat(device-wizard): detect per-row port orientation (contract + validation)"`

---

## Task 2: Prompt + schema (`visionBackend.ts`)

**Files:** Modify `src/features/device-library/ai/visionBackend.ts`. (No unit test — same as the rest of this file.)

- [ ] **Step 1 — schema.** In `responseSchema`, add to the group `items.properties`:
```ts
rowOrientations: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
```
(Leave it out of the group `required` array — it's optional.)

- [ ] **Step 2 — prompt.** Append to `PROMPT`:
> "For each port group, also report rowOrientations: one value per row, either 'up' or 'down', describing which way that row's connector tabs/clips face — the two rows of a switch are often mirrored (one up, one down)."

- [ ] **Step 3 — `npx tsc --noEmit`** clean.

- [ ] **Step 4 — commit:** `git commit -am "feat(device-wizard): ask Gemini for per-row port orientation"`

---

## Task 3: Apply orientation in layout (`layoutDetectedFace.ts`)

**Files:** Modify `src/features/device-library/ai/layoutDetectedFace.ts`; Test `layoutDetectedFace.test.ts`.

- [ ] **Step 1 — failing tests** (append):

```ts
it("mirrors row rotation from rowOrientations", () => {
  const out = layoutDetectedFace(
    face({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 0.3, h: 0.5 }, rowOrientations: ["down", "up"] }] }),
    { widthIn: 17.5, rackUnits: 1 },
  );
  const g = out.portGroups[0];
  const cols = g.cols; // 4
  expect(g.portOverrides[0]?.rotation ?? 0).toBe(0);        // row 0 (down) → 0
  expect(g.portOverrides[cols]?.rotation).toBe(180);         // row 1 (up)  → 180
});
it("leaves rotation unset when no rowOrientations", () => {
  const out = layoutDetectedFace(
    face({ groups: [{ media: "copper", connector: "RJ45", count: 8, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 0.3, h: 0.5 } }] }),
    { widthIn: 17.5, rackUnits: 1 },
  );
  expect(out.portGroups[0].portOverrides).toEqual({});
});
```

- [ ] **Step 2 — run, expect FAIL.**

- [ ] **Step 3 — implement.** In `toPortGroup`, replace `portOverrides: {}` with a built map:
```ts
const portOverrides: PortGroup["portOverrides"] = {};
if (d.rowOrientations) {
  for (let r = 0; r < d.rows; r++) {
    const rot = d.rowOrientations[r] === "up" ? 180 : 0; // default/absent → "down" → 0
    if (rot !== 0) for (let c = 0; c < cols; c++) portOverrides[r * cols + c] = { rotation: rot };
  }
}
```
and return `portOverrides` in the object.

- [ ] **Step 4 — run, expect PASS.** Then `npx tsc --noEmit` and `npx vitest run src/features/device-library/ai`.

- [ ] **Step 5 — commit:** `git commit -am "feat(device-wizard): apply per-row orientation as port rotation in layout"`

---

## Verify

- Full suite `npx vitest run` green.
- Browser: upload a two-row switch photo; confirm the rows render mirrored. If they render inverted (up/down swapped vs the photo), swap the mapping in Task 3 (`"up" ? 180 : 0` → `"down" ? 180 : 0`) — the semantic contract stays the same; only the physical mapping flips. Note the outcome.
