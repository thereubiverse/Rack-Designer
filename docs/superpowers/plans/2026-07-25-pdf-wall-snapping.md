# PDF Wall Extraction & Snap-Assisted Tracing (Slice D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retain the uploaded PDF, extract its wall geometry and room labels exactly, render the plan as crisp vector at any zoom, and make manual room tracing snap onto real walls.

**Architecture:** A pure geometry module decodes pdf.js path operators into wall runs grouped by their infinite line (θ, ρ) — never by axis, which discards angled wings. A server module runs it over the retained PDF and stores the result as JSONB. The canvas gains a wall-snap source in its existing snap chain and swaps its `<image>` layer for a pdf.js-rendered canvas so quality never degrades.

**Tech Stack:** Next.js 16, TypeScript strict, `pdfjs-dist` (already a dependency), Supabase (DB + Storage, local via Docker), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-25-pdf-wall-snapping-design.md` — read §1, §5.3, §5.4 before starting.

## Global Constraints

- **NEVER run vitest against a directory or glob.** `*.integration.test.ts` files here delete rows wholesale and WILL wipe the developer's local database. Run tests by EXPLICIT FILENAME only.
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- No local `psql`. Use `docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres` — **the `-i` is required** or the heredoc silently reaches nothing.
- Every migration ends with the THREE blanket grant statements from `0001`'s tail, byte-identical:
  ```sql
  grant usage on schema public to anon, authenticated, service_role;
  grant all privileges on all tables in schema public to service_role;
  grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  ```
- Server actions return `{ ok: boolean; error?: string }` and never throw to the caller — `await` every fallible call INSIDE the try/catch.
- **Trust posture:** `floorId` is the only client input; `site_id` is derived from the floor row. Wall/label geometry is clamped to 0..1 server-side and count-capped. Nothing geometry-shaped is trusted raw.
- Coordinates are normalized 0..1 over the rendered page. `[0,0]` is a REAL coordinate — every check is `!= null`, never falsy (the Null Island rule).
- **Group wall segments by infinite line (θ, ρ), never by axis + position.** Axis-aligned grouping discarded this building's rotated wing and cost 36 points of coverage. This is the single most important technical fact in the slice.
- **Walls live in the SCREENED-BACK (grey) stroke class**, not the prominent one. On any overlay discipline the base building is greyed and the sheet's own subject is drawn prominently.
- Non-PDF plans and PDFs without usable vector data keep Slice C behaviour unchanged. Nothing regresses.
- Use `command grep` in shells (interactive grep is aliased to a wrapper that chokes on some flags).
- Run commands from the project root; the Bash tool's cwd resets between calls.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## File Structure

| file | responsibility |
|---|---|
| `src/features/clients/planGeometry.ts` | **pure** — decode path ops → segments; group by (θ,ρ); merge runs; filter. No I/O, no pdf.js import |
| `src/features/clients/planGeometry.test.ts` | its tests |
| `src/features/clients/planExtract.ts` | `server-only` — drives pdf.js over PDF bytes, calls planGeometry, returns walls + labels |
| `src/features/clients/planExtractActions.ts` | the `extractPlanGeometryAction` server action |
| `src/features/clients/PlanVectorLayer.tsx` | client — renders the PDF page to a canvas at the current zoom |
| `supabase/migrations/0015_plan_geometry.sql` | schema |

`FloorPlanCanvas.tsx` is modified in Tasks 6–7 only (snap source + swapping the image layer).

---

### Task 1: Migration 0015 — retain the PDF, store geometry

**Files:**
- Create: `supabase/migrations/0015_plan_geometry.sql`
- Modify: `src/lib/supabase/types.ts`

**Interfaces:**
- Produces: `FloorPlanRow` gains `pdf_storage_path: string | null; pdf_page: number | null; wall_runs: WallRun[] | null; plan_labels: PlanLabel[] | null; geometry_extracted_at: string | null`.

- [ ] **Step 1: Write the migration**

```sql
-- Slice D: the uploaded PDF is retained so its exact vector geometry can be extracted, and
-- re-extracted later when the wall filter improves, without asking the user to re-upload.
alter table floor_plans add column pdf_storage_path      text;
-- WHICH page of a multi-page PDF the PNG was rendered from. Slice B rendered a chosen page but
-- never persisted the index, so a retained PDF could not be mapped back to its own sheet.
alter table floor_plans add column pdf_page              integer check (pdf_page is null or pdf_page >= 0);
-- Wall runs, normalized 0..1 over the rendered page: [{x1,y1,x2,y2}]. Advisory snapping data.
alter table floor_plans add column wall_runs             jsonb;
-- Room labels lifted from the PDF text layer: [{text,x,y}]. Exact strings, no OCR.
alter table floor_plans add column plan_labels           jsonb;
alter table floor_plans add column geometry_extracted_at timestamptz;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

- [ ] **Step 2: Apply and verify**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0015_plan_geometry.sql
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "\d floor_plans"
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "select count(*) as plans, count(pdf_storage_path) as with_pdf from floor_plans;"
```

Expected: five new nullable columns; `plans` unchanged from before (1), `with_pdf` = 0. Existing rows keep working because every new column is nullable.

- [ ] **Step 3: Update types, typecheck, commit**

Add the five fields to `FloorPlanRow` in `src/lib/supabase/types.ts`, plus these two exported interfaces in the same file:

```ts
/** A straight wall segment, normalized 0..1 over the rendered plan page. Endpoints, not (θ,ρ),
 *  because the canvas consumes them directly for drawing and snapping. */
export interface WallRun { x1: number; y1: number; x2: number; y2: number }
/** A room label lifted from the PDF text layer — exact string, exact position. */
export interface PlanLabel { text: string; x: number; y: number }
```

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
npx vitest run src/features/clients/planActions.test.ts
git add supabase/migrations/0015_plan_geometry.sql src/lib/supabase/types.ts
git commit -m "feat(db): retain source PDF and store extracted plan geometry"
```

Expected: tsc silent; planActions suite green (its fixtures use object literals that widen safely because every new column is optional/nullable — if any fixture breaks, add `pdf_storage_path: null` etc. and list the files in your report).

---

### Task 2: Pure geometry — `planGeometry.ts` (TDD)

**Files:**
- Create: `src/features/clients/planGeometry.ts`, `src/features/clients/planGeometry.test.ts`

**Interfaces:**
- Consumes: `WallRun` from `@/lib/supabase/types`.
- Produces:
  - `interface RawSeg { a: [number, number]; b: [number, number]; grey: boolean }`
  - `interface WallOpts { minLenFrac?: number; mergeGapPx?: number; thetaBucketRad?: number; rhoBucketPx?: number }`
  - `buildWallRuns(segs: RawSeg[], W: number, H: number, opts?: WallOpts): WallRun[]`
  - `normalizeRuns(runs: WallRun[], W: number, H: number): WallRun[]` — px → 0..1, clamped
  - `MAX_WALL_RUNS = 4000`

**Why (θ, ρ):** two segments belong to the same wall iff they lie on the same infinite line. Parameterising by angle θ and perpendicular offset ρ makes that test rotation-invariant. Grouping by axis+position only works for axis-aligned walls and silently drops rotated wings — measured at a 36-point coverage cost on the real sheet.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from "vitest";
import { buildWallRuns, normalizeRuns, MAX_WALL_RUNS } from "./planGeometry";

const seg = (ax: number, ay: number, bx: number, by: number, grey = true) =>
  ({ a: [ax, ay] as [number, number], b: [bx, by] as [number, number], grey });

describe("buildWallRuns", () => {
  it("merges co-linear touching segments into one run", () => {
    const out = buildWallRuns([seg(0, 0, 50, 0), seg(50, 0, 100, 0)], 1000, 1000, { minLenFrac: 0.01 });
    expect(out).toHaveLength(1);
    expect(out[0].x1).toBeCloseTo(0, 1);
    expect(out[0].x2).toBeCloseTo(100, 1);
  });

  it("keeps ANGLED walls — the rotated-wing regression", () => {
    // A 45-degree wall. Axis-aligned grouping would discard this entirely.
    const out = buildWallRuns([seg(0, 0, 70, 70), seg(70, 70, 140, 140)], 1000, 1000, { minLenFrac: 0.01 });
    expect(out).toHaveLength(1);
    expect(Math.hypot(out[0].x2 - out[0].x1, out[0].y2 - out[0].y1)).toBeGreaterThan(190);
  });

  it("does NOT merge parallel segments on different lines", () => {
    const out = buildWallRuns([seg(0, 0, 100, 0), seg(0, 40, 100, 40)], 1000, 1000, { minLenFrac: 0.01 });
    expect(out).toHaveLength(2);
  });

  it("does NOT merge co-linear segments separated by more than the gap", () => {
    const out = buildWallRuns([seg(0, 0, 50, 0), seg(300, 0, 400, 0)], 1000, 1000,
      { minLenFrac: 0.01, mergeGapPx: 6 });
    expect(out).toHaveLength(2);
  });

  it("drops runs shorter than minLenFrac of the long edge", () => {
    const out = buildWallRuns([seg(0, 0, 5, 0)], 1000, 1000, { minLenFrac: 0.01 }); // 5px < 10px
    expect(out).toEqual([]);
  });

  it("ignores non-grey segments — walls live in the screened-back class", () => {
    const out = buildWallRuns([seg(0, 0, 100, 0, false)], 1000, 1000, { minLenFrac: 0.01 });
    expect(out).toEqual([]);
  });

  it("never throws on degenerate input and caps the output", () => {
    expect(buildWallRuns([], 1000, 1000)).toEqual([]);
    expect(buildWallRuns([seg(5, 5, 5, 5)], 1000, 1000)).toEqual([]); // zero length
    const many = Array.from({ length: MAX_WALL_RUNS + 500 }, (_, i) => seg(0, i * 3, 900, i * 3));
    expect(buildWallRuns(many, 1000, 20000, { minLenFrac: 0.001 }).length).toBeLessThanOrEqual(MAX_WALL_RUNS);
  });
});

describe("normalizeRuns", () => {
  it("maps pixels to 0..1 and keeps the 0 edge", () => {
    const out = normalizeRuns([{ x1: 0, y1: 0, x2: 500, y2: 250 }], 1000, 500);
    expect(out[0]).toEqual({ x1: 0, y1: 0, x2: 0.5, y2: 0.5 });
  });
  it("clamps out-of-page coordinates into range", () => {
    const out = normalizeRuns([{ x1: -50, y1: 0, x2: 2000, y2: 250 }], 1000, 500);
    expect(out[0].x1).toBe(0);
    expect(out[0].x2).toBe(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/planGeometry.test.ts
```
Expected: FAIL — cannot resolve `./planGeometry`.

- [ ] **Step 3: Implement**

```ts
import type { WallRun } from "@/lib/supabase/types";

export interface RawSeg { a: [number, number]; b: [number, number]; grey: boolean }
export interface WallOpts {
  minLenFrac?: number;
  mergeGapPx?: number;
  thetaBucketRad?: number;
  rhoBucketPx?: number;
}

/** Bounded so a pathological sheet cannot produce an unbounded payload. */
export const MAX_WALL_RUNS = 4000;

// Tuned on the real sheet (see the spec's §5.4 table): 94.9% of hand-traced room edges land
// within 6px of an extracted run, at ~1,013 runs.
const DEFAULTS: Required<WallOpts> = {
  minLenFrac: 0.010,
  mergeGapPx: 6,
  thetaBucketRad: Math.PI / 180, // 1 degree
  rhoBucketPx: 1.5,
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Group segments by the INFINITE LINE they lie on — angle θ plus perpendicular offset ρ — then
 *  merge overlapping/adjacent spans along each line. Rotation-invariant by construction: grouping
 *  by axis + position instead silently discards every wall in a rotated wing. */
export function buildWallRuns(segs: RawSeg[], W: number, H: number, opts: WallOpts = {}): WallRun[] {
  const o = { ...DEFAULTS, ...opts };
  const minLen = Math.max(W, H) * o.minLenFrac;

  const lines = new Map<string, { th: number; rho: number; spans: [number, number][] }>();
  for (const s of segs) {
    if (!s.grey) continue;
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1];
    if (Math.hypot(dx, dy) < 0.5) continue;
    // θ in [0, π): a segment and its reverse describe the same line.
    let th = Math.atan2(dy, dx);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - 1e-9) th = 0;
    const rho = s.a[0] * Math.sin(th) - s.a[1] * Math.cos(th);
    const key = `${Math.round(th / o.thetaBucketRad)}_${Math.round(rho / o.rhoBucketPx)}`;
    let entry = lines.get(key);
    if (!entry) { entry = { th, rho, spans: [] }; lines.set(key, entry); }
    // Project both endpoints onto the line direction to get a 1-D span.
    const ux = Math.cos(th), uy = Math.sin(th);
    const p = s.a[0] * ux + s.a[1] * uy, q = s.b[0] * ux + s.b[1] * uy;
    entry.spans.push([Math.min(p, q), Math.max(p, q)]);
  }

  const runs: WallRun[] = [];
  for (const { th, rho, spans } of lines.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    const ux = Math.cos(th), uy = Math.sin(th), nx = Math.sin(th), ny = -Math.cos(th);
    let [cs, ce] = spans[0];
    const flush = () => {
      if (ce - cs >= minLen) {
        runs.push({
          x1: ux * cs + nx * rho, y1: uy * cs + ny * rho,
          x2: ux * ce + nx * rho, y2: uy * ce + ny * rho,
        });
      }
    };
    for (let i = 1; i < spans.length; i++) {
      if (spans[i][0] <= ce + o.mergeGapPx) ce = Math.max(ce, spans[i][1]);
      else { flush(); [cs, ce] = spans[i]; }
    }
    flush();
    if (runs.length >= MAX_WALL_RUNS) break;
  }
  return runs.slice(0, MAX_WALL_RUNS);
}

/** Pixels → normalized 0..1 over the page, clamped. `0` is a real coordinate, never "missing". */
export function normalizeRuns(runs: WallRun[], W: number, H: number): WallRun[] {
  return runs.map((r) => ({
    x1: clamp01(r.x1 / W), y1: clamp01(r.y1 / H),
    x2: clamp01(r.x2 / W), y2: clamp01(r.y2 / H),
  }));
}
```

- [ ] **Step 4: Run (PASS), typecheck, commit**

```bash
npx vitest run src/features/clients/planGeometry.test.ts
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/clients/planGeometry.ts src/features/clients/planGeometry.test.ts
git commit -m "feat(clients): pure wall-run extraction grouped by infinite line"
```

---

### Task 3: PDF extraction — `planExtract.ts` (server)

**Files:**
- Create: `src/features/clients/planExtract.ts`
- Modify: `src/features/clients/planStorage.ts`

**Interfaces:**
- Consumes: `buildWallRuns`, `normalizeRuns` (Task 2); `WallRun`, `PlanLabel` (Task 1).
- Produces:
  - `uploadPlanPdf(db, path, bytes): Promise<void>` and `removePlanPdf(db, path): Promise<void>` in `planStorage.ts` (thin wrappers, `contentType: "application/pdf"`, error prefix = function name).
  - `extractPlanGeometry(pdfBytes: Uint8Array, pageIndex: number): Promise<{ walls: WallRun[]; labels: PlanLabel[]; width: number; height: number }>`

**The coordinate contract — get this right or every wall is silently offset.** Use ONE viewport for both rendering and extraction. `viewport.transform` already composes scale, the bottom-left→top-left Y flip, AND page `/Rotate`; applying it to CTM-transformed points is the whole mapping. Do not hand-roll the flip.

**pdf.js v6 path encoding (verified by probe):** `constructPath` args are `[paintOp, [flatArray], minMax]`. The flat array interleaves local opcodes with coordinates: `0`=moveTo(2 coords), `1`=lineTo(2), `2`=curveTo(6), `3`=curveTo-variant(4), `4`=closePath(0). Curves contribute only their endpoint — walls are straight.

- [ ] **Step 1: Add the two storage wrappers to `planStorage.ts`**

```ts
const PDF_CONTENT_TYPE = "application/pdf";

/** The original upload, retained so geometry can be re-extracted when the wall filter improves. */
export async function uploadPlanPdf(db: SupabaseClient, path: string, bytes: Uint8Array): Promise<void> {
  const { error } = await db.storage.from(BUCKET).upload(path, bytes, {
    upsert: true,
    contentType: PDF_CONTENT_TYPE,
  });
  if (error) throw new Error(`uploadPlanPdf: ${error.message}`);
}

export async function removePlanPdf(db: SupabaseClient, path: string): Promise<void> {
  const { error } = await db.storage.from(BUCKET).remove([path]);
  if (error) throw new Error(`removePlanPdf: ${error.message}`);
}
```

- [ ] **Step 2: Create `planExtract.ts`**

```ts
import "server-only";
import type { WallRun, PlanLabel } from "@/lib/supabase/types";
import { buildWallRuns, normalizeRuns } from "./planGeometry";

const RENDER_LONG_EDGE = 2600;   // matches the PNG Slice B renders, so both share one coordinate space
const MAX_LABELS = 400;

/** True for the SCREENED-BACK stroke class. On every overlay discipline (electrical, mechanical,
 *  ceiling) the base building is greyed and the sheet's own subject is drawn prominently — so the
 *  walls are in here, not in the black. Verified on the real sheet: grey-only reaches 94.9%
 *  edge coverage. */
function isScreenedBack(colour: unknown): boolean {
  return typeof colour === "string" && /^#[9abcdABCD]/.test(colour);
}

export async function extractPlanGeometry(
  pdfBytes: Uint8Array,
  pageIndex: number
): Promise<{ walls: WallRun[]; labels: PlanLabel[]; width: number; height: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const OPS = pdfjs.OPS;
  const doc = await pdfjs.getDocument({ data: pdfBytes, useSystemFonts: true }).promise;
  const page = await doc.getPage(pageIndex + 1);          // pdf.js pages are 1-based

  const unit = page.getViewport({ scale: 1 });
  const scale = RENDER_LONG_EDGE / Math.max(unit.width, unit.height);
  const vp = page.getViewport({ scale });                 // includes /Rotate
  const W = Math.round(vp.width), H = Math.round(vp.height);

  const ops = await page.getOperatorList();
  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  let colour = "#000000";
  const mul = (m: number[], n: number[]) => [
    m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1],
    m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3],
    m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5],
  ];
  const apply = (m: number[], x: number, y: number): [number, number] =>
    [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
  // viewport.transform maps PDF user space to device pixels: scale + Y-flip + rotation, all at once.
  const toPx = (p: [number, number]) => apply(vp.transform as number[], p[0], p[1]);

  const segs: { a: [number, number]; b: [number, number]; grey: boolean }[] = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i] as never[];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args as unknown as number[]);
    else if (fn === OPS.setStrokeRGBColor) colour = String((args as unknown as unknown[])[0]);
    else if (fn === OPS.constructPath) {
      const flat = (args as unknown as [unknown, ArrayLike<number>[]])[1]?.[0];
      if (!flat) continue;
      const grey = isScreenedBack(colour);
      const n = flat.length ?? 0;
      let j = 0;
      let cur: [number, number] | null = null;
      let start: [number, number] | null = null;
      while (j < n) {
        const op = flat[j++];
        if (op === 0) { cur = apply(ctm, flat[j++], flat[j++]); start = cur; }
        else if (op === 1) {
          const p = apply(ctm, flat[j++], flat[j++]);
          if (cur) segs.push({ a: toPx(cur), b: toPx(p), grey });
          cur = p;
        }
        else if (op === 2) { j += 4; cur = apply(ctm, flat[j++], flat[j++]); }
        else if (op === 3) { j += 2; cur = apply(ctm, flat[j++], flat[j++]); }
        else if (op === 4) { if (cur && start) segs.push({ a: toPx(cur), b: toPx(start), grey }); cur = start; }
        else break;
      }
    }
  }

  const walls = normalizeRuns(buildWallRuns(segs, W, H), W, H);

  const content = await page.getTextContent();
  const labels: PlanLabel[] = [];
  for (const item of content.items as { str?: string; transform?: number[] }[]) {
    const text = (item.str ?? "").trim();
    if (!text || !item.transform) continue;
    const [x, y] = apply(vp.transform as number[], item.transform[4], item.transform[5]);
    labels.push({ text, x: Math.max(0, Math.min(1, x / W)), y: Math.max(0, Math.min(1, y / H)) });
    if (labels.length >= MAX_LABELS) break;
  }

  return { walls, labels, width: W, height: H };
}
```

- [ ] **Step 3: Verify against the REAL sheet, typecheck, commit**

There is no unit test for this module — it is a thin pdf.js driver, and the same convention applies as to the untested `visionBackend.ts`/`planVisionBackend.ts`. Its geometry is covered by Task 2's tests; its correctness against a real file is verified here, once, with a throwaway script:

```bash
cat > /tmp/claude-501/-Users-reubensingh-development/037108cc-cdca-4e62-a2f7-7a6ebe3d8aa6/scratchpad/verify-extract.mjs <<'EOF'
import fs from "node:fs";
const { extractPlanGeometry } = await import("./src/features/clients/planExtract.ts");
const bytes = new Uint8Array(fs.readFileSync(process.argv[2]));
const r = await extractPlanGeometry(bytes, 0);
console.log("walls", r.walls.length, "labels", r.labels.length, "page", r.width + "x" + r.height);
const bad = r.walls.filter(w => [w.x1,w.y1,w.x2,w.y2].some(v => v < 0 || v > 1 || !Number.isFinite(v)));
console.log("out-of-range walls:", bad.length, "(must be 0)");
console.log("sample labels:", r.labels.slice(0,5).map(l=>l.text));
EOF
npx tsx /tmp/claude-501/-Users-reubensingh-development/037108cc-cdca-4e62-a2f7-7a6ebe3d8aa6/scratchpad/verify-extract.mjs "/Users/reubensingh/Documents/QuickConnect/URI - Magnolia Gardens/Cellar.pdf"
```

Expected: **walls ≈ 1000 (accept 800–1400)**, labels ≈ 400 (capped), page `2600x1733`, out-of-range 0, and sample labels showing real room text. If `tsx` is unavailable, run `npx vitest run` against a temporary one-off test file instead and delete it after — do NOT leave a test that depends on a file outside the repo.

If walls is far outside that band the filter has regressed — stop and report rather than proceeding.

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
npx vitest run src/features/clients/planActions.test.ts
git add src/features/clients/planExtract.ts src/features/clients/planStorage.ts
git commit -m "feat(clients): extract wall runs and labels from the source PDF"
```

---

### Task 4: Retain the PDF at upload

**Files:**
- Modify: `src/features/clients/PlanUploadZone.tsx`, `src/features/clients/actions.ts`, `src/features/locations/repository.ts`
- Modify: `src/features/clients/PlanUploadZone.test.tsx`, `src/features/clients/planActions.test.ts`

**Interfaces:**
- Consumes: `uploadPlanPdf`, `removePlanPdf` (Task 3).
- Produces: `uploadFloorPlanAction` additionally accepts FormData fields `pdf` (Blob, optional) and `pdfPage` (string, optional). `upsertFloorPlan` gains optional `pdfStoragePath?: string | null; pdfPage?: number | null`. `deleteFloorPlan` removes the PDF object too.

**Contract:**
- The client already holds the original `File` when it calls `convertPdfPage(file, pageIndex)`. It now sends that same File as `pdf` and the chosen index as `pdfPage`, alongside the PNG. Nothing else about the upload flow changes.
- Server side: PDF path is `${siteId}/${floorId}.pdf`. Upload it **after** the PNG succeeds, inside the same try/catch. A PDF failure must not orphan a successful PNG — on PDF failure, still upsert the row with `pdf_storage_path: null` and return `{ ok: true }`, because a plan without geometry is a working plan (it falls back to Slice C).
- `pdfPage` is parsed with `Number()` and rejected unless it is a finite integer ≥ 0; invalid → treat as absent.
- `deleteFloorPlan` removes the PDF best-effort in its own try/catch, exactly like the PNG — a missing object must never block row/placement cleanup.

- [ ] **Step 1: Tests RED.** In `planActions.test.ts` add, asserting real recorded arguments:
  - upload with a `pdf` blob and `pdfPage: "2"` → `uploadPlanPdf` called with path `SITE-A/f1.pdf`, and `upsertFloorPlan` received `pdfStoragePath: "SITE-A/f1.pdf", pdfPage: 2`.
  - upload with NO pdf → `uploadPlanPdf` never called; row upserted with `pdfStoragePath: null`.
  - `uploadPlanPdf` rejecting → action still returns `{ok: true}` and the row is still upserted (with `pdfStoragePath: null`), and `uploadPlanObject` was still called — proving a PDF failure cannot lose the PNG.
  - `pdfPage: "abc"` → treated as absent (`pdfPage: null`), no throw.
  - delete: `removePlanPdf` rejecting does NOT prevent `deleteFloorPlan`'s row delete and both placement-clearing updates.

  In `PlanUploadZone.test.tsx`: choosing page 3 of a multi-page PDF sends FormData containing BOTH a `file` blob and a `pdf` blob, with `pdfPage` === `"2"` (0-based).

- [ ] **Step 2: Implement. GREEN.**
- [ ] **Step 3: Run named files + tsc, commit**

```bash
npx vitest run src/features/clients/planActions.test.ts
npx vitest run src/features/clients/PlanUploadZone.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/clients/PlanUploadZone.tsx src/features/clients/actions.ts src/features/locations/repository.ts src/features/clients/PlanUploadZone.test.tsx src/features/clients/planActions.test.ts
git commit -m "feat(clients): retain the source PDF and its page index at upload"
```

---

### Task 5: Extraction action

**Files:**
- Create: `src/features/clients/planExtractActions.ts`, `src/features/clients/planExtractActions.test.ts`

**Interfaces:**
- Consumes: `getFloorPlan` (`@/features/locations/repository`), `downloadPlanObject` (`./planStorage`), `extractPlanGeometry` (Task 3).
- Produces:
  - `type ExtractResult = { ok: true; walls: number; labels: number } | { ok: false; error: string }`
  - `extractPlanGeometryAction(floorId: string): Promise<ExtractResult>`

**Contract:** load the plan row; no row → `{ok:false,"Upload a plan first."}`; no `pdf_storage_path` → `{ok:false,"This plan has no source PDF."}`; download the PDF; extract using `pdf_page ?? 0`; write `wall_runs`, `plan_labels`, `geometry_extracted_at` via a new `saveFloorPlanGeometry(db, floorId, {walls, labels})` repository function; `revalidatePath("/clients")`. **Everything fallible sits INSIDE one try/catch** — `getFloorPlan` and `downloadPlanObject` both throw on error and must not escape.

- [ ] **Step 1: Tests RED** (module-mock every dependency; assert real recorded args):
  - happy path → `extractPlanGeometry` called with the downloaded bytes and `pdf_page` (use a NON-zero page, e.g. 2, to prove the stored index is honoured, not hardcoded); `saveFloorPlanGeometry` received the returned walls/labels; result reports their counts.
  - no plan row → `{ok:false}`, `downloadPlanObject` NOT called.
  - `pdf_storage_path` null → `{ok:false}`, `downloadPlanObject` NOT called.
  - `getFloorPlan` rejecting → resolves `{ok:false}` (assert with `await expect(...).resolves`, which fails if it rejects).
  - `extractPlanGeometry` rejecting → resolves `{ok:false}`, `saveFloorPlanGeometry` NOT called.
- [ ] **Step 2: Implement. GREEN.**
- [ ] **Step 3: Run named file + tsc, commit**

```bash
npx vitest run src/features/clients/planExtractActions.test.ts
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/clients/planExtractActions.ts src/features/clients/planExtractActions.test.ts src/features/locations/repository.ts
git commit -m "feat(clients): action to extract and persist plan geometry"
```

---

### Task 6: Wall snapping in the canvas

**Files:**
- Modify: `src/features/clients/FloorPlanCanvas.tsx`, `src/features/clients/FloorPlanCanvas.test.tsx`
- Modify: `src/features/clients/SiteDetail.tsx`, `src/app/clients/[clientCode]/[siteCode]/page.tsx`

**Interfaces:**
- Consumes: `WallRun` (Task 1).
- Produces: `FloorPlanCanvas` gains prop `wallRuns?: WallRun[]` (default `[]`), threaded from the page's plan row through `SiteDetail`.

**Contract:**

The existing chain is `snapPoint(n) = snapToVertex(n) ?? snapToEdge(n)`, with `SNAP_PX = 12`. It becomes:

```ts
function snapPoint(n: NormPoint): NormPoint | null {
  return snapToVertex(n) ?? snapToWallCorner(n) ?? snapToEdge(n) ?? snapToWallLine(n);
}
```

- `snapToWallCorner(n)` — nearest endpoint of any wall run within `SNAP_PX` screen px. Wall endpoints are where walls meet, so they outrank a point mid-line.
- `snapToWallLine(n)` — nearest point ON a wall run within `SNAP_PX` (standard point-to-segment projection, clamped to the segment).
- Existing room geometry keeps priority so rooms sharing a wall still meet exactly (the Slice B contract).
- Distances are computed in SCREEN pixels (multiply normalized deltas by `imgW * view.zoom` / `imgH * view.zoom`) so the snap radius feels constant at any zoom — matching how `snapToVertex` already works.
- A toggleable wall overlay: `IconButton` `data-testid="toggle-walls"`, icon `tabler:vector-triangle`, tip "Show walls", in the left toolbar stack after `fit-to-area`. When on, wall runs render inside the live `<g>` **before** rooms/pins (walls are context, not content) as `stroke="#0ea5e9"`, `strokeWidth={1 / view.zoom}`, `opacity={0.5}`, `data-testid="wall-overlay"`.

**Tests** (add to `FloorPlanCanvas.test.tsx`; pass `wallRuns` in the fixture):
- a trace click near a wall endpoint snaps EXACTLY to it (assert the committed polygon's vertex equals the wall endpoint).
- a trace click near a wall's middle snaps onto the line (perpendicular distance ≈ 0), not to an endpoint.
- an existing ROOM vertex within range still wins over a nearer wall corner — priority regression.
- a click far from any wall is unchanged (no snap).
- `wallRuns={[]}` behaves exactly as before — pure addition, no regression.
- the overlay renders only when toggled on.

- [ ] **Step 1: Tests RED.** — [ ] **Step 2: Implement. GREEN.** — [ ] **Step 3: named files + tsc, commit**

```bash
npx vitest run src/features/clients/FloorPlanCanvas.test.tsx
npx vitest run src/features/clients/SiteDetail.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/clients/FloorPlanCanvas.tsx src/features/clients/FloorPlanCanvas.test.tsx src/features/clients/SiteDetail.tsx "src/app/clients/[clientCode]/[siteCode]/page.tsx"
git commit -m "feat(clients): snap room tracing onto extracted PDF walls"
```

---

### Task 7: Vector plan rendering (no quality loss)

**Files:**
- Create: `src/features/clients/PlanVectorLayer.tsx`
- Modify: `src/features/clients/FloorPlanCanvas.tsx`, `src/features/clients/FloorPlanCanvas.test.tsx`
- Modify: `src/features/clients/SiteDetail.tsx`, `src/app/clients/[clientCode]/[siteCode]/page.tsx`

**Interfaces:**
- Produces: `PlanVectorLayer({ pdfUrl, pageIndex, imgW, imgH, zoom }: { pdfUrl: string; pageIndex: number; imgW: number; imgH: number; zoom: number })` — a client component rendering the PDF page into a `<canvas>` wrapped in `<foreignObject>`, re-rendering when the effective zoom changes materially.
- `FloorPlanCanvas` gains `pdfUrl?: string | null` and `pdfPage?: number | null`.

**Why:** the user's requirement — "no loss of quality or compression". A fixed 2600px PNG visibly interpolates past ~100% zoom. Rendering the PDF at the current zoom keeps the plan sharp at any magnification; the PNG becomes a fallback/thumbnail.

**Contract:**
- When `pdfUrl` is present, render `PlanVectorLayer` in place of the `<image>`; otherwise keep the existing `<image href={planUrl}>` exactly as-is (image uploads, and PDFs whose retention failed, must keep working).
- The canvas is sized `imgW × imgH` in plan coordinate space via `<foreignObject width={imgW} height={imgH}>` so **the coordinate model does not change** — pins, rooms, walls and snapping are untouched.
- Re-render is **debounced and bucketed**: only re-rasterise when `zoom` crosses a power-of-√2 bucket, capped at 4× device pixel ratio, and never more than once per 150ms. Re-rendering a 84k-path sheet on every wheel tick would be unusable.
- A render in flight is cancelled (`renderTask.cancel()`) when a newer one starts, and the component tolerates unmount mid-render without setting state.
- `pdfjs.GlobalWorkerOptions.workerSrc` is set the same way `planUpload.ts` already does it — reuse that exact pattern, do not invent a second worker setup.

**Tests** (jsdom cannot rasterise a PDF — test the wiring, not the pixels; mock `pdfjs-dist`):
- `pdfUrl` present → `PlanVectorLayer` rendered, no `<image>`.
- `pdfUrl` absent → `<image href={planUrl}>` rendered, no vector layer (regression guard for image-sourced plans).
- zoom changes within one bucket → no additional `page.render` call; crossing a bucket → exactly one more.
- unmount mid-render does not throw.

- [ ] **Step 1: Tests RED.** — [ ] **Step 2: Implement. GREEN.** — [ ] **Step 3: named files + tsc, commit**

```bash
npx vitest run src/features/clients/FloorPlanCanvas.test.tsx
npx vitest run src/features/clients/SiteDetail.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | command grep "error TS" | head
git add src/features/clients/PlanVectorLayer.tsx src/features/clients/FloorPlanCanvas.tsx src/features/clients/FloorPlanCanvas.test.tsx src/features/clients/SiteDetail.tsx "src/app/clients/[clientCode]/[siteCode]/page.tsx"
git commit -m "feat(clients): render plans as vector so zoom never loses quality"
```

---

### Task 8: Live browser verification

**Files:** none (verification only; fix forward into Tasks 4–7 files).

**Preconditions:** the CELLAR floor currently has a PNG-only plan uploaded before this slice, so it has no retained PDF. Re-upload `"/Users/reubensingh/Documents/QuickConnect/URI - Magnolia Gardens/Cellar.pdf"` through the UI to exercise the new path end-to-end. The two remaining rooms (`IT`, `WER`) hold racks and must survive.

- [ ] **Step 1: Restart the dev server clean** via the controller's preview tooling (never `npm run dev` in a shell). Stale Turbopack caches have previously reported phantom compile errors — a restart is required, not optional.
- [ ] **Step 2: Re-upload the Cellar PDF** to URI/HQ/CELLAR. Verify in the DB:
  ```bash
  docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "select source, pdf_page, pdf_storage_path is not null as has_pdf, jsonb_array_length(wall_runs) as walls, jsonb_array_length(plan_labels) as labels from floor_plans;"
  ```
  Expected: `source=pdf`, `has_pdf=t`, walls in the 800–1400 band, labels > 100.
- [ ] **Step 3: Toggle the wall overlay.** Confirm the blue walls sit ON the drawing's walls, including the **angled wing** — that is the regression the (θ,ρ) grouping exists to prevent.
- [ ] **Step 4: Trace a room with snapping.** Trace COMMUNITY ROOM; confirm clicks lock onto walls and corners. Save, reload, confirm the polygon persisted. Compare against the preserved baseline in `.superpowers/sdd/baseline/rooms-traced-baseline.json` — the traced outline should be visibly tighter to the walls than the hand-traced original.
- [ ] **Step 5: Quality check.** Zoom to 400%+ and confirm the plan stays sharp (vector), not pixellated. This is the user's explicit requirement.
- [ ] **Step 6: Regression check.** Confirm device discovery still works, the Slice A lists still render, and racks RK01/RK1 are intact.
- [ ] **Step 7: Report** measured wall count, whether the angled wing was covered, extraction wall-clock time at upload, and any filter tuning needed. Commit any fixes.

---

## Self-Review

**Spec coverage:** §3 schema → Task 1. §4 storage (both objects, delete removes both) → Tasks 3, 4. §5.1 coordinate contract → Task 3 (one viewport, `viewport.transform`). §5.2 path encoding → Task 3. §5.3/§5.4 stroke class + (θ,ρ) + tuned parameters → Tasks 2, 3. §5.6 labels → Task 3. §5.7 vector rendering → Task 7. §6 snapping chain + overlay → Task 6. §7 room labels in the UI → **NOT in this plan** — deliberately deferred; snapping is the value, and label markers can follow once walls are proven in use. §8 testing conventions → every task. §9 out-of-scope respected (no automatic rooms, no ML, no vendor).

**Placeholder scan:** none. Pure/server tasks carry full code; canvas tasks are contract-bound with exact test ids and priority rules, per the repo's established convention for `FloorPlanCanvas`.

**Type consistency:** `WallRun {x1,y1,x2,y2}` and `PlanLabel {text,x,y}` defined in Task 1, consumed by Tasks 2, 3, 6. `RawSeg`/`WallOpts`/`buildWallRuns`/`normalizeRuns`/`MAX_WALL_RUNS` (Task 2) consumed by Task 3. `uploadPlanPdf`/`removePlanPdf` (Task 3) consumed by Task 4. `extractPlanGeometry` (Task 3) consumed by Task 5. `saveFloorPlanGeometry` introduced in Task 5's contract and added to the repository there. `wallRuns` prop (Task 6) and `pdfUrl`/`pdfPage` props (Task 7) both threaded from the same page loader.

**Session lessons encoded:** (θ,ρ) grouping is called out in Global Constraints AND has its own regression test, because axis-aligned grouping is the single defect that cost 36 points; `docker exec -i` for heredocs; actions never throw (every fallible call inside try/catch, asserted with `.resolves`); real recorded arguments in action tests; non-first fixtures; explicit-filename vitest only; a restart-clean step before live verification.
