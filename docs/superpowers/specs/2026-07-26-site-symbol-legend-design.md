# Per-Site Symbol Legend (Slice E) — Design

## 1. Why this exists — measured, not assumed

Symbol discovery works: template matching finds every instance of a symbol, at the angles the
building actually uses (CP 9/10, GFI 13/14 on the real sheet). The weak link is **obtaining a clean
template**.

Picking a symbol from the plan body keeps dragging in its surroundings. Measured on the user's
telecom-outlet triangles:

| triangle | foreground neighbours within 4px | of those, >25px (wall/leader) |
|---|---|---|
| 7×17 | 7 | 2 |
| 12×18 | 10 | 2 |
| 7×17 | 15 | 2 |
| 7×4 | 16 | 2 |

The symbols are ~7×17px and **every one has a wall or leader line within 4 pixels**. No grouping
heuristic can isolate a symbol that small when something large always touches it. Three attempts
have already failed against this:

- proximity grouping → swallowed the adjacent `AC-C-n` tag (CP recall 9/10 → 5)
- excluding text glyphs → tag has a *drawn rectangle border*, so the group still bridged
- strict touch-only grouping → tag is joined by a *drawn leader*, so it still bridged, **and** it
  broke genuine multi-part symbols (card machine 27.3 → 12.2)

A "foreign-label" rule eventually got CP back to 9/10, but it is a heuristic fighting the drawing.

**In a legend, the same symbol is drawn alone on white**, with nothing touching it. That is the
structural fix: obtain templates where symbols are isolated by construction.

## 2. Decisions taken

| Decision | Choice |
|---|---|
| Source of templates | **A legend sheet uploaded per site** (PDF page or image). Symbols there are isolated |
| Scope of the library | **Per site.** Different architects use different conventions; the user was explicit that this varies by site |
| Picking on the legend | Same click-to-pick already built — but with no walls or leaders nearby, the existing grouping is sufficient |
| What is stored | The **normalized box** on the legend, not pixels. Re-derivable, tiny, and survives a better extractor later |
| Symbol → device type | Assigned by the user when defining the symbol. This is the semantic step a model gets wrong and a human gets right instantly |
| Matching | Unchanged — raster correlation at the building's `dominantAngles`. **No model involved** |
| Plan-body picking | **Kept.** The legend is the better path, not the only one; a site may have no legend |

## 3. The scale problem — the real design risk

A legend may be drawn at a **different scale** from the plan. A triangle 17px tall on the legend
could be 12px or 24px on the plan, and template correlation is not scale-invariant. Ignoring this
would silently produce zero matches, which would read as "the feature doesn't work".

**Do not brute-force scale per search.** Rotations already cost 2–4.5× (12 angles, 2.9s → 5.7s);
multiplying by a scale sweep is untenable.

**Calibrate once per legend instead.** When the first symbol from a legend is used against a floor:

1. Match it at a small ladder of scales (e.g. 0.7, 0.85, 1.0, 1.15, 1.4).
2. Keep the scale with the best aggregate score.
3. **Persist it** on the legend↔floor pair.
4. Every subsequent search from that legend reuses it — one scale, no sweep.

If no scale scores above threshold, report it plainly rather than returning noise: the legend and
plan may be unrelated sheets.

## 4. Schema — migration `0016_site_symbols.sql`

```sql
-- One legend sheet per site: where a site's symbols are DEFINED, isolated on white.
create table site_legends (
  id            uuid primary key default gen_random_uuid(),
  site_id       uuid not null references sites(id) on delete cascade,
  storage_path  text not null,                    -- the rendered PNG
  pdf_path      text,                             -- retained source, when a PDF was uploaded
  pdf_page      integer check (pdf_page is null or pdf_page >= 0),
  width_px      integer not null check (width_px > 0),
  height_px     integer not null check (height_px > 0),
  created_at    timestamptz not null default now(),
  unique (site_id)
);

-- A symbol defined on that legend, bound to a device type.
create table site_symbols (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references sites(id) on delete cascade,
  device_type_id uuid not null references device_types(id) on delete restrict,
  name           text not null default '',        -- e.g. "telecom outlet, half-shaded triangle"
  box            jsonb not null,                  -- {x,y,w,h} normalized 0..1 ON THE LEGEND
  created_at     timestamptz not null default now()
);
create index site_symbols_site_idx on site_symbols(site_id);

-- Scale calibration between a legend and one floor's plan (see §3).
alter table floor_plans add column legend_scale double precision
  check (legend_scale is null or legend_scale > 0);
```

`on delete restrict` on `device_type_id` is deliberate: deleting a device type that symbols depend
on should fail loudly rather than silently orphan them.

Every migration ends with the three blanket grant statements from `0001`'s tail, byte-identical.

## 5. Flow

**Defining symbols** (per site, once):
1. On the site page, upload a legend sheet — same conversion path as a floor plan (PDF page → PNG,
   PDF retained).
2. The legend renders in a picker view. Click a symbol → the existing `pickSymbolAction` grouping
   returns its bounds → assign a device type and an optional name → saved.
3. Repeat for each symbol. The library lists them with thumbnails.

**Using them** (per floor):
1. "Discover devices" lists the site's defined symbols alongside the existing device-type entries.
2. Choosing one runs the existing search — template extracted from the legend at the stored box,
   scaled by the calibrated factor, matched at the building's `dominantAngles`.
3. Results populate the existing proposal list. Accept/dismiss is unchanged.

Nothing downstream of matching changes: proposals, ghost pins, `ProposalPanel`, and the
place-vs-create-vs-duplicate decision layer are all reused as-is.

## 6. Testing

- **Pure**: scale calibration picks the best-scoring scale from a ladder and reports failure when
  none clears threshold. Template extraction from a stored normalized box round-trips.
- **Actions** DB-free with real recorded arguments: legend upload retains the PDF; symbol save
  clamps its box; discovery from a saved symbol passes the calibrated scale and the derived angles.
- **Live, and the acceptance bar**: define the half-shaded triangle from a legend and search a floor.
  **The current in-plan pick cannot isolate this symbol at all** — that is the case this slice exists
  to fix, so a measured recall against the plan's telecom outlets is the deliverable, not a nice-to-have.
- Tests run by EXPLICIT FILENAME only — `*.integration.test.ts` files here wipe the local database.

## 7. Out of scope

Auto-parsing a legend (OCR'ing its rows to guess symbol↔meaning) — the user assigns types in a few
clicks, and mis-parsing would be worse than not parsing. Sharing libraries across sites or clients
(explicitly per-site). Multi-page legends. Editing a saved symbol's box (delete and re-pick).

## 8. Open question for the builder

Whether the legend picker should reuse `FloorPlanCanvas` (pan/zoom/click already work, but it
carries a great deal of floor-plan-specific machinery) or be a much simpler dedicated view. Lean
simple: a legend needs pan, zoom, click and a highlight — not rooms, walls, racks or proposals.
