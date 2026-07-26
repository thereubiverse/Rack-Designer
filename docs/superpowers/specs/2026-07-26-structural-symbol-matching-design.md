# Structural Symbol Matching (Slice F) — Design

## 1. Why — measured, and it reverses an earlier conclusion

Symbol discovery has been raster correlation (`symbolMatch.matchSymbol`) since it was built. That
works for large, high-ink symbols (CP 9/10, GFI 13/14) and **cannot** work for the one the user needs
most — the half-shaded triangle that marks a telephone/data outlet. Measured against the real sheets:

| probe | result |
|---|---|
| legend template vs plan, plain NCC at the ONE verified triangle | 0.719 |
| E-102P hits >= 0.60 / >= 0.75 / >= 0.85 | 654 / 26 / **0** |
| 2600px -> 7800px raster | top score 0.823 -> 0.80 |
| masked NCC over template ink only | 0.598 — **worse** |

The true positive sits at 0.72 among hundreds of unrelated blobs at 0.60–0.83. No threshold separates
them, and neither scale nor resolution nor masking moves it.

**The reason is structural, not statistical.** The symbol is ~10px of anti-aliased ink drawn hard
against the wall it mounts on. NCC correlates the whole window, so the wall is inside the comparison.

**The geometry was in the PDF the whole time.** Three facts, each measured:

1. The symbol is **not one path**. Cellar has exactly ONE 2–3-segment small path in 83,023 paths.
   CAD emitted each triangle side as its own single-segment path — there are 1,005 of those.
   Every previous search looked *per path* and therefore found nothing.
2. The half-shaded triangle is **two overlapping triangles**: an 8-8-8 equilateral outline plus a
   4-7-8 right triangle that forms the filled half. This is why click-to-pick could never select
   "only the triangle" — there was never a single object to select.
3. Assembling segments **across** paths finds them exactly.

Result of doing so, verified by eye on montages and a full-quadrant overlay, not just by count:

| sheet | fg triangle parts | clustered symbols | shaded = telecom outlets |
|---|---|---|---|
| E-101P (First Floor) | 155 | 44 | **44** |
| E-102P (2nd–6th) | 96 | 28 | **28** |
| E-103P (Seventh) | 12 | 4 | **4** |
| Cellar | 68 | 23 | **20** |

A 9-tile montage of the shaded class is 9/9 real half-shaded triangles at four different rotations.
A full quadrant overlay of E-102P circles every visible one, circles nothing else, and correctly
leaves out the leader **arrowheads** near "ELECTRICAL SHAFT".

**Properties that make this a core engine rather than a heuristic:** exact (no score threshold),
rotation-invariant by construction, scale-invariant, and immune to adjacency — a wall touching the
triangle is simply a segment that fails to close a triple.

## 2. Decisions taken

| Decision | Choice |
|---|---|
| Matching basis | **Vector structure** assembled from `decodePlanPage` segments, not pixels |
| Relationship to NCC | **Both.** Structural runs first; NCC stays as the fallback for symbols that assemble no primitives. Deleting it would regress CP/GFI, which are measured working |
| User-facing flow | **Unchanged.** Discover devices → device type → click a symbol → proposals. Only the engine changes |
| Seed | The existing `pickSymbolAction` box. It is already cut from the PDF's own vector bounds, so it is a good seed even though it over-selects |
| Foreground filter | **Mandatory.** `!path.grey`. Measured: without it E-102P yields 122 "symbols" of which 89 are the screened-back layer's X-braced boxes |
| Fill variants | Classified from raster ink fraction at the centroid, so solid / half-shaded / hollow are distinguishable — the legend's own distinction between telephone/data and data-only |
| Legend (Slice E) | **Not needed for this.** The template was never the problem. Left as-is, unbuilt |

## 3. The model

Three primitive kinds, all derived from `decodePlanPage` output. Nothing new is parsed from the PDF.

**`Polygon`** — assembled from FOREGROUND segments of length 2.5–32px by endpoint chaining:
spatial-hash endpoints into 1.2px cells, then find closed chains of 3–6 segments whose joins fall
within 1.4px. Rejected below 4px² or above 200px² of area. Described rotation-invariantly by its
**sorted side-length multiset** (`8-8-8`, `4-7-8`).

**`Circle`** — a path with zero segments and a near-square bbox. pdf.js emits a circle as pure
curve operators, so it produces curve endpoints and no straight runs; `decodePlanPage` already grows
the bbox from those endpoints. Described by radius. (Cellar: 14 such small paths.)

**`Rect`** — a 4-segment closed path, described by its sorted side pair. Distinguished from a
triangle-with-`closePath` by whether one of its four segments has zero length; measured on Cellar,
40 of 133 small 4-segment paths are triangles wearing a rectangle's segment count.

A **symbol signature** is the multiset of primitives whose centroids fall inside the seed box, each
in its rotation-invariant description, plus the pairwise distances between their centroids (also
rotation-invariant). Matching is multiset equality within tolerance: **10% on lengths, 1.5px floor**,
so a 8-8-8 matches a 8.4-7.7-8.2 but not a 12-12-12.

**Clustering.** Parts within 4.5px of each other are one symbol — this is what merges the outline and
its shaded half into a single proposal rather than two.

Deliberately NOT included: hatch fill lines (they are what makes "shaded" shading, and matching them
would make every instance unique), and text glyphs (already excluded by `isTextGlyph`).

## 4. Code shape

New pure module **`src/features/clients/symbolStructure.ts`** — no I/O, testable without a database:

```ts
export type Primitive =
  | { kind: "polygon"; sides: number[]; cx: number; cy: number; r: number }
  | { kind: "circle"; radius: number; cx: number; cy: number; r: number }
  | { kind: "rect"; sides: [number, number]; cx: number; cy: number; r: number };

/** Every primitive on a page, from decodePlanPage's paths. Foreground only. */
export function extractPrimitives(paths: PlanPath[], opts?: PrimitiveOpts): Primitive[];

/** The signature of whatever the user picked: the primitives inside `box`, described invariantly. */
export function signatureFor(prims: Primitive[], box: Box): SymbolSignature | null;

/** Every location on the page whose primitives match that signature. Centres, in page pixels. */
export function findMatches(prims: Primitive[], sig: SymbolSignature, opts?: MatchOpts): StructHit[];

/** solid | half | hollow, from raster ink fraction at the centroid — the legend's own distinction. */
export function classifyFill(img: GreyImage, hit: StructHit): "solid" | "half" | "hollow";
```

`symbolActions.discoverSymbolsAction` gains a structural attempt before its existing NCC path.
Everything downstream is untouched: `DeviceProposal`, `nearestCode`, ghost pins, `ProposalPanel`,
and the place-vs-create-vs-duplicate layer all keep working as they do now.

`decodePlanPage` is already called by the pick; discovery currently only rasterises. It will now need
the paths too — the same single operator walk, which is why `planPaths.ts` exists.

**No migration.** Primitives are derived from the stored PDF on each search. If the ~1s assembly cost
proves to matter it can be cached into `floor_plans` later, but shipping a schema change to solve a
performance problem nobody has measured would be backwards.

## 5. Confidence

Structural hits are exact — there is no score to map. They report `high` confidence, except where the
signature matched with only one primitive (a bare circle, say), which is genuinely ambiguous and
reports `medium`. NCC-sourced hits keep their existing score-derived confidence, so the two engines
stay distinguishable in the proposal list.

## 6. Testing

- **Pure** (`symbolStructure.test.ts`), no DB, no PDF: endpoint chaining closes a triangle whose
  sides arrive as three separate paths and in arbitrary order; rejects a chain that fails to close by
  2px; the 10%/1.5px tolerance accepts 8.4-7.7-8.2 against 8-8-8 and rejects 12-12-12; side-length
  multisets are equal under rotation of the input; clustering merges two triangles 3px apart and
  keeps two 9px apart separate; a 4-segment path with a zero-length segment classifies as a polygon,
  not a rect; grey paths are excluded.
- **Action**, DB-free with recorded arguments: discovery returns structural proposals when the seed
  assembles primitives, and falls through to NCC when it does not.
- **Live, and the acceptance bar**: pick the half-shaded triangle on E-102P and get **28** proposals;
  E-101P **44**; E-103P **4**; Cellar **20** — with a rendered overlay inspected by eye, not a count
  taken on trust. Every number in §1 was obtained that way and is reproducible.
- **Regression**: CP and GFI recall on Cellar must not drop (9/10, 13/14). They route through NCC and
  should be untouched — this is the check that the fallback really is a fallback.
- Tests run by EXPLICIT FILENAME only — `*.integration.test.ts` files here wipe the local database.

## 7. Risks

**Tolerances are tuned on one architect's drawing set.** 1.2px hashing, 1.4px joins, 10% lengths,
4.5px clustering — all from Magnolia Gardens. A set that draws finer or coarser may need different
values. They belong in one named block at the top of the module, as `symbolActions`' pick constants
already are, so the first response to a bad sheet is obvious.

**Symbols with no straight edges** (a lone circle, an arc-only symbol) assemble one primitive or
none. That is exactly why NCC is kept rather than replaced.

**Assembly cost is unmeasured at the action level.** The probe assembled E-102P's 138,987 paths
inside a script that also rendered the page, in a few seconds total. Worth timing once in the action
before assuming it is free.

## 8. Out of scope

Auto-cataloguing every symbol on a sheet without a pick (the user picks in one click; guessing which
clusters are "symbols" is a harder problem with worse failure modes). The per-site legend (Slice E) —
superseded for this case, left unbuilt. Multi-page sheets. Curve-shape matching beyond circles.
