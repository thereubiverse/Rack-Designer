# PDF Wall Extraction & Snap-Assisted Tracing (Slice D) — Design

## 0. Where this sits — the floor-plans roadmap

| Slice | Delivers | Status |
|---|---|---|
| A | Floor tabs, floor/room CRUD, `floor_devices` inventory | **MERGED** (2026-07-22) |
| B | Plan upload + storage + manual mapping editor | **MERGED** (2026-07-23) |
| C | AI discovery: Gemini proposes rooms and device pins | **MERGED** (2026-07-25) |
| **D (this spec)** | Wall + label extraction from the source PDF; snap-assisted room tracing | designing |
| E | Port linkage: ports reference floor devices (was "Slice D" in the B/C specs) | later |
| F | Purpose-built ML room detection for RASTER-only plans | later, see §9 |

## 1. Why this slice exists — what Slice C measured

Slice C shipped AI room discovery. It does not work, and the reason is now established
empirically rather than suspected. Measured against ten hand-traced rooms on URI/HQ's CELLAR sheet:

| approach | mean best-IoU | rooms ≥0.5 | notes |
|---|---|---|---|
| Gemini, as first shipped | **0.408** | 4/10 | 96% of proposals were axis-aligned bounding boxes |
| Gemini + a prompt forbidding bounding boxes | **0.401** | 4/10 | **100%** rectangles — prompt engineering is a dead end |
| Gemini + crop to the drawing area | **0.549** | 6/10 | shipped; the only lever that moved |
| Classical flood-fill on the PNG | **~0.00** | 0/10 | leaks through doorways or traps in furniture |
| **PDF vector layer** | **exact** | — | it is the real geometry, not an estimate |

Three approaches are ruled out and must not be re-litigated: **prompt engineering**,
**morphology/flood-fill on the raster**, and (for PDF-backed plans) **any vision model at all**.

The decisive finding: `floor_plans.source = 'pdf'` for the real plan, and the source PDF is CAD
vector. A probe extracted **253,665 segments, 93% axis-aligned**, and a filtering spike reduced that
to **1,396 clean wall runs** with the title block and legend excluded automatically. Slice B
rasterises the upload to PNG and **discards the PDF**, throwing this away.

State-of-the-art purpose-built ML (RoomFormer, FloorplanVLM, HEAT) reports ~78–81% mIoU on clean
residential benchmarks. That is worse than exact, on harder data than ours, for more infrastructure.
ML is therefore scoped to raster-only plans (§9), not this slice.

## 2. Decisions taken

| Decision | Choice |
|---|---|
| Geometry source | **The PDF vector layer.** No vision model participates in geometry for PDF-backed plans |
| Retain the PDF? | **Yes** — stored alongside the PNG. Wall filtering is heuristic and WILL need tuning; retaining the source makes re-extraction free instead of requiring a re-upload |
| Where extraction runs | **Server-side**, using the `pdfjs-dist` legacy build (verified working under Node). Default is **at upload**; if measurement shows it delays the upload noticeably, it moves behind a lazy first-use path (§10.2). Either way `geometry_extracted_at` records that it ran, so the trigger can change without a schema change |
| Goal | **Snap-assisted tracing**, not automatic rooms. The user traces; every click locks onto a real wall line. Automatic room detection is explicitly deferred (§9) |
| Room labels | Extracted from the PDF **text layer** — exact strings at exact positions. For PDF-backed plans this REPLACES the Gemini room pass |
| Device discovery | **Untouched.** It works (type coercion was correct on real labels: TV→SCR, CR→ACP, unrecognised→TO) |
| Non-PDF plans | Current Slice C behaviour, unchanged. Nothing regresses |
| Third-party services | **None.** Archilogic was evaluated and deferred — it would solve room detection, but snapping does not need room detection, and a core-feature vendor dependency is a strategic risk for a product. Revisit only if automatic rooms are attempted and prove too hard |

## 3. Schema — migration `0015_plan_geometry.sql`

Five nullable columns on `floor_plans`. All null for image uploads, so every existing row stays
valid and no backfill is required.

```sql
alter table floor_plans add column pdf_storage_path      text;
alter table floor_plans add column pdf_page              integer check (pdf_page is null or pdf_page >= 0);
alter table floor_plans add column wall_runs             jsonb;
alter table floor_plans add column plan_labels           jsonb;
alter table floor_plans add column geometry_extracted_at timestamptz;
```

**`pdf_page` closes a real gap.** `PlanUploadZone.handlePageChosen(pageIndex)` currently renders a
chosen page but persists only the blob — the page number is lost. Without it, a retained multi-page
PDF cannot be re-extracted, because we would not know which sheet the PNG came from.

Every migration ends with the three blanket grant statements from `0001`'s tail, byte-identical.

## 4. Storage

- PNG stays at `{siteId}/{floorId}.png` (unchanged).
- PDF is added at `{siteId}/{floorId}.pdf`, same private `floor-plans` bucket, server-side writes.
- `uploadFloorPlanAction` accepts an optional second blob (`pdf`) plus `pdfPage`.
- `deleteFloorPlan` removes **both** objects, each best-effort in its own try/catch so a missing
  object cannot block the row and placement cleanup (the existing Slice B contract).

## 5. Extraction — `planGeometry.ts` (pure) + `planExtract.ts` (server)

### 5.1 The coordinate contract — the highest-risk detail

Wall coordinates must land in **exactly the normalized 0..1 space the PNG uses**, or every wall is
silently offset and snapping drags traces to the wrong place. Three transforms must be composed
correctly:

1. PDF user space → page space via the **CTM** (tracked across `save`/`restore`/`transform`).
2. PDF origin is **bottom-left**; the image origin is **top-left** — Y must be flipped.
3. The page may carry a **`/Rotate`** value; the PNG was rendered through pdf.js's viewport, which
   applies it. Extraction must use the same viewport, not raw page dimensions.

This gets a dedicated test with a hand-computed fixture, and a live check that an extracted wall
lies on a hand-traced room's edge.

### 5.2 pdf.js v6 path encoding (verified by probe)

`constructPath` args are `[paintOp, [flatArray], minMax]`, where the flat array interleaves local
opcodes with coordinates: **`0`=moveTo(2), `1`=lineTo(2), `2`=curveTo(6), `4`=closePath(0)**. Curves
keep only their endpoint — a floor plan's walls are straight, and curve interiors are furniture.

### 5.3 Stroke class is a better signal than geometry (probed 2026-07-25)

These PDFs carry **no optional content groups**, so layer-name filtering is unavailable. But stroke
colour and line width separate content classes cleanly, and far more meaningfully than orientation:

**On the REFLECTED-CEILING sheet** (probed first — NOT the user's working sheet type):

| class | count | what it actually is |
|---|---|---|
| grey `#aaaaaa`, thin | 186,961 | hatching / screened background fill |
| black, thin (<5) | 61,653 | architecture, ceiling grid, dimensions, leaders |
| black, heavy (≥5) | 5,051 | **light fixtures** — NOT walls |
| red `#ee1d24` | 52 | as-built markup annotations |

Two consequences:

1. **Dropping grey removes 74% of all geometry** on a principled basis, before any geometric
   heuristic runs. This should be the first filter stage.
2. **Class-to-meaning is INVERTED between sheet types — do not hardcode it.** On the user's actual
   ELECTRICAL sheet (`Cellar.pdf`) the mapping is the other way round: the architecture is screened
   back to **grey (#cdcdcd, #ababab — 75,886 segments) and CONTAINS THE WALLS**, while black
   (19,710) is the electrical content — devices, conduit, leaders. On the reflected-ceiling sheet
   grey was hatching and heavy black was light fixtures.

   The rule that generalises: **the screened-back class is the architectural base.** On any overlay
   discipline (electrical, mechanical, telecom, ceiling) the base building is greyed and the sheet's
   own subject is drawn prominently. Walls therefore live in the SCREENED class, not the prominent
   one. §5.4 confirms this empirically — grey-only extraction reaches 94.9% edge coverage.

### 5.4 TUNED against the real sheet (Cellar.pdf, 2026-07-25)

Measured on the user's actual drawing against the eleven hand-traced rooms preserved in
`.superpowers/sdd/baseline/`. Metric is **edge coverage**: the fraction of traced room-edge length
having an extracted wall run within tolerance. Coverage is what snapping needs — a missing wall
breaks the feature, whereas a spurious run is a minor annoyance.

| config | runs | cover @6px | @12px |
|---|---|---|---|
| orthogonal only, minLen 1.5% | 218 | 54.4% | 57.4% |
| **any angle**, minLen 1.5% | 496 | 90.6% | 95.7% |
| **any angle, minLen 1.0%, gap 6 — CHOSEN** | **1,013** | **94.9%** | **99.6%** |
| any angle, minLen 0.6% | 3,155 | 95.4% | 99.9% |

**The orthogonality filter was the single biggest defect — it cost 36 points of coverage.** This
building has a rotated wing, and axis-aligned filtering discarded every wall in it. Segments must be
grouped by their **infinite line (θ, ρ)** — Hough-style — never by axis plus position.

Chosen parameters: grey stroke class only, any angle, θ bucket 1°, ρ bucket ~0.6pt, merge gap 6pt,
minimum run length 1.0% of the sheet's long edge. Yields ~1,013 runs (~30KB JSON).

Known remaining false positives: stair treads and some hatching (many equally-spaced short parallel
runs). Harmless for snapping; a candidate for a later "regular repeating pattern" filter.

### 5.5 The filtering pipeline (pure, testable)

```
decode paths
  → keep orthogonal (|dx| or |dy| < 0.6pt)
  → detect drawing area  (occupancy grid, largest connected dense component)
  → keep segments inside it                      // drops title block, legend, notes
  → merge co-linear runs (same axis, position within 0.5pt, gaps ≤ 2pt)
  → drop runs shorter than 1.2% of the sheet's long edge
```

Measured on the CELLAR-adjacent sheet: 253,665 → 1,396 runs, drawing area 19% of the sheet.

Each stage is a pure function so the heuristic is tuned against fixtures, not by eye. `wall_runs` is
stored as `{ vertical: boolean, pos: number, start: number, end: number }[]` in normalized units —
compact (~1,400 runs ≈ 25KB JSON) and directly usable by the snapper without re-deriving anything.

### 5.6 Labels

`page.getTextContent()` gives items with a transform. Each becomes
`{ text, x, y }` normalized the same way. No OCR, no model, no transcription error.

## 5.7 Plan rendering must not lose quality (user requirement, 2026-07-25)

> "when a pdf of a floor plan is uploaded i dont want any loss of quality or compression"

Slice B renders the PDF to a **fixed 2600px PNG** and discards the vector. That is a real quality
loss: zooming past ~100% shows interpolation, and fine electrical symbols soften.

Since the PDF is being retained anyway (§2), the plan layer changes from a static `<image>` to a
**pdf.js-rendered canvas that re-renders at the current zoom** — the behaviour of any PDF viewer.
The plan then stays sharp at every magnification, and the PNG is demoted to a cheap thumbnail
rather than the source of truth.

Rejected alternative: rendering a much larger PNG (e.g. 10,000px). Still finite, and a dense CAD
sheet becomes a 20–50MB download.

This affects `FloorPlanCanvas`'s image layer only. The coordinate model is unchanged — normalized
0..1 over the page — so pins, rooms, walls and snapping are unaffected.

## 6. Snapping

The canvas already has `snapPoint(n) = snapToVertex(n) ?? snapToEdge(n)` over existing rooms, with
`SNAP_PX = 12`. It becomes:

```
snapToVertex        // existing room corner   — highest priority
  ?? snapToWallCorner  // intersection of two wall runs
  ?? snapToEdge        // point on an existing room's wall
  ?? snapToWallLine    // nearest point on a wall run
```

Existing room geometry keeps priority so rooms sharing a wall still meet exactly (the Slice B
contract). Wall **corners** outrank wall **lines** because a corner is the more valuable target.

**Performance:** ~1,400 runs scanned per `pointermove`. Because runs are axis-aligned and stored
by position, they bucket into a simple index by rounded coordinate; a naive scan is the fallback if
measurement shows it is unnecessary. This must be measured, not assumed.

**Visibility:** a toggleable faint wall overlay. Snapping to invisible geometry feels arbitrary, and
the overlay doubles as proof that extraction worked on a given sheet.

## 7. Room labels in the UI

For a PDF-backed plan, "Discover rooms" stops calling Gemini and instead drops markers at the
extracted label positions with exact names. Clicking a marker starts a trace with name and type
pre-filled. Instant, free, exact.

Plans without usable labels fall back to the Gemini pass unchanged.

## 8. Testing

- **Pure geometry** (`planGeometry.test.ts`): path decoding against a hand-built operator fixture;
  the CTM/Y-flip/rotation mapping with hand-computed expectations; co-linear merging; the drawing-area
  detector on a synthetic sheet with a title block; run-length filtering. `[0,0]` stays a valid
  coordinate (the Null Island rule).
- **Extraction action** DB-free with a faked storage layer, asserting real recorded arguments.
- **Snapping** unit-tested on the priority chain: an existing vertex beats a wall corner; a wall
  corner beats an existing edge; nothing within `SNAP_PX` returns null.
- **Live**: extract the real CELLAR sheet, overlay the walls, and confirm a traced vertex lands on a
  wall. Compare extracted walls against the hand-traced baseline preserved in
  `.superpowers/sdd/baseline/rooms-traced-baseline.json`.
- **NEVER run vitest against a directory or glob** — integration tests wipe the local DB.
  Explicit filenames only. Typecheck with `./node_modules/.bin/tsc --noEmit`.

## 9. Out of scope

**Automatic room polygons.** Building a planar graph from wall runs and detecting enclosed faces is
the "it just works" version and the obvious sequel, but doorways and layer noise are unsolved and it
would gate this slice's value behind the hardest part. Snap-assisted tracing delivers exact outlines
without it.

**ML for raster-only plans.** Scans and photos have no vector layer. A purpose-built model
(FloorplanVLM's wall-skeleton-first framing is the design to copy) is the right tool there — a
separate slice with its own inference infrastructure.

**Third-party digitisation** (Archilogic et al.) — deferred, see §2.

**DWG/DXF ingest.** Strictly better source data than PDF (explicit wall entities, layer names). Worth
asking clients to supply, and worth its own slice if they can.

## 10. Open questions for the builder

1. **BLOCKING: the real CELLAR PDF is required to tune the wall filter.** Everything probed so far
   ran against `As Built - Reflected Ceiling Cellar.pdf` — a *reflected ceiling* plan, the worst case
   for this filter (dominated by ceiling grid, and its heavy strokes are light fixtures). The uploaded
   sheet is *ELECTRICAL POWER — CELLAR PLAN (E-100P.00)*. Tuning stroke-class thresholds against an
   RCP would fit a sheet type the user does not actually work from. The coordinate mapping is proven
   and sheet-independent; the FILTER is not, and cannot be finished without the real file.
2. **Extraction cost at upload is unmeasured** on a 253k-segment sheet. If it is slow enough to hurt
   the upload, move it behind the same lazy path the signed URL already uses and show a one-time
   loading state.
3. One probed sheet (`As Built - Access Control…`) yielded only sparse fragments — either a
   markup-only overlay or an extractor gap. Extraction must degrade gracefully to the Gemini path
   rather than present an empty wall layer as success.
