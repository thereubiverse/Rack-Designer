# Rack Builder & Network Documentation — Design Spec

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plan
**Author:** Reuben Singh (with Claude)

---

## 1. Context & Purpose

The long-term vision is a platform for documenting and visualizing complex
network / data / security / access-control setups across many client sites — a
single place to design, build, plan, configure, diagnose, and document
networks, and to coordinate the construction (structured cabling) side with the
IT side.

That full vision is too large for one build. It decomposes into independent
subsystems (floor-plan management, structured infrastructure DB, construction
handoff, client portal, networks/IP, access control, diagnostics). This spec
covers the chosen **beachhead**: the **Rack Builder & Network Documentation
core**. Each remaining subsystem gets its own spec → plan → build cycle later.

**Reference product:** PATCHBOX's rack tool is the UX benchmark. Strategy is
"match then beat it" — rebuild its strong core (rack + port rendering, per-port
connection-path panel, structured naming convention) and add what it lacks:
graphical faceplates, planned-vs-as-built tracking, CSV import, and custom
report/label exports.

## 2. Scope

### In scope (this build)
- Location hierarchy: Site → Floor → Room (IDF/MDF/other) → Rack.
- Visual rack builder: drag devices from a palette onto rack units (U slots),
  Front/Back views, zoom, undo/redo.
- Device & patch-panel modeling with port-level faceplate rendering, backed by a
  reusable **Device Library** (templates).
- Full port-to-port connectivity with end-to-end path tracing (per-port panel).
- **Graphical wall-plate / faceplate endpoint viewer** (differentiator #1).
- **Planned vs as-built** state per rack with toggle + diff + install/verify
  marking (differentiator #2).
- Searchable/sortable data grid kept in sync with the visual.
- Three data-entry paths: CSV import, blank-list manual entry, visual-first.
- Auto-derived fixed-format naming convention (cable names are the exception —
  see §5).
- **Custom report exports + printable label sheets** (differentiator #3).
- Lightweight Activity Log (audit).

### Out of scope (later, separate specs)
- Multi-tenant authentication, roles, and billing.
- Floor-plan import & annotation.
- Networks / IP / logical configuration.
- Access-control subsystem.
- Diagnostics.
- Client-facing portal.

The data model is scoped with `organization_id` from day one so auth and
multi-tenancy layer on cleanly without a rewrite.

## 3. Architecture

- **Framework:** Next.js (App Router, TypeScript, React) — one app serving UI
  and API routes.
- **Data:** Supabase (PostgreSQL). Plain Postgres tables now; Row-Level Security
  policies written but scoped to a single default org, so enabling
  multi-tenancy is a configuration change later. Supabase Storage reserved for
  future floor-plan files.
- **Rendering:** **SVG** for racks, faceplates, and label sheets. Rationale:
  crisp at any zoom, data-bound to React, trivially exportable to PDF/PNG/print,
  inspectable/accessible. Rack scenes are small enough (hundreds of elements)
  that SVG performance is a non-issue.
- **State/data layer:** one normalized source of truth; the SVG builder and the
  data grid are both views/editors over it (edit in either, both update).
  TanStack Query for server sync; optimistic updates with undo/redo.
- **Module structure (feature-scoped, independently testable):** `locations/`,
  `racks/`, `devices/`, `connectivity/`, `endpoints/`, `import-export/`,
  `reports/`, each with its own data access, components, and tests,
  communicating through typed interfaces.

## 4. Data Model

Location hierarchy is the spine; other entities hang off it.

```
Organization (single default now, tenant-ready)
  └─ Site        code (HQ), name, address
      └─ Floor       code (28), name, order
          └─ Room        code (SL), name, type: MDF | IDF | other
              └─ Rack        code (RK001_M), height_U, front/back
                  └─ Device      code (D), type, start_U, height_U, side,
                  │              status: planned | installed | verified,
                  │              device_template_id
                  └─ Port        number (17), media (RJ45/fiber/...), side,
                                 row/col (for drawing), connector type
```

Cross-cutting entities:

- **Device Library (template):** reusable model definition — type, model name,
  U-height, and a **port layout map** (front/back). A placed Device is an
  instance of a template. Powers "customize devices and patch panels" once,
  reuse everywhere.
- **Cable Segment:** a physical cable between `port_A` and `port_B`, with type,
  length, color, and **label** (manually entered — see §5). Chained segments
  form a **Channel**, traversed as a graph to display the full end-to-end path
  (switch → panel → wall jack → device).
- **Faceplate / Endpoint (differentiator #1):** lives at a Room/wall location;
  has a plate type (gang size, 1/2/4/6-port) and position. **Its jacks are
  Ports**, identical to rack ports, so one connectivity engine traces both.
  Renders as a graphical plate (jack color/type + printed label + connection).
- **Activity Log:** who changed what, when.

Key model decisions:

1. **Ports are the universal connector.** Rack device ports and wall-jack ports
   are the same entity → a single connectivity/traversal engine.
2. **Planned vs as-built is a `status` field** (planned → installed → verified)
   on Devices and Cable Segments. "Planned" view shows everything; "As-built"
   shows installed/verified; the **diff** highlights planned-but-not-installed
   and installed-but-off-plan. One rack, two views, no duplicate records.
3. **Concurrency:** `updated_at` guard on writes; stale writes surface a
   "changed since you loaded" warning (full conflict-merge deferred).

## 5. Naming Convention

- Labels are **auto-derived, fixed-format**, composed from each hierarchy
  level's `code`: e.g. `HQ/28/SL/RK001_M/D/17`
  (`site/floor/room/rack/device/port`). Nothing is hand-typed for these levels,
  guaranteeing consistency.
- The convention is a single app-defined standard (the company's standard,
  applied to all clients). Making it configurable per-client is a documented
  future extension, deliberately out of scope now.
- **Exception — Cable Segment `label` is manually entered free-text** by
  default. The app may offer a one-click suggestion from the convention, but
  never forces it. This is required for matching a client's specified scheme and
  for documenting already-built sites where labels already exist in the field.
- **Existing-site override:** device/port/rack/room codes remain auto-derived;
  only cable names are free-text. (Considered but rejected: unlocking free-text
  on all labels — kept structural naming clean instead.)
- The convention drives three consumers: **CSV import keys**, **report
  exports**, and **printable label sheets**.

## 6. Workspace UI

Frame follows the PATCHBOX reference (validated as the "three-pane workbench"):

- **Left:** global navigation + tenant switcher (single tenant for now), and a
  **device palette** ("drag device to a rack unit to add it"): Patch Panel,
  Switch, Router, Firewall, Gateway, Server, UPS, Cable Manager, Rack Tray,
  Faceplate, Miscellaneous. Zoom, undo/redo, **Front/Back** toggle.
- **Center:** the **rack elevation** with U-numbers; devices rendered as real
  faceplates with numbered ports; cable runs routed visually. Selection
  highlights the device and its links.
- **Right:** per-item detail — the **per-port connection-path panel** (each port
  shows its full traced path, e.g. `→ HQ/28/SL/RK001_M/SW01/08`) and Notes.
- **Toolbar:** **Planned / As-built / Diff** segmented control; Import CSV;
  Export report; Label sheet.
- **Synced data grid:** a searchable/sortable table over the same data. Click a
  row → the device highlights in the rack, and vice-versa. Cable name is the one
  free-text column. This grid is what CSV import fills and what exports read.
- **Faceplate/endpoint viewer:** graphical wall plate (correct gang/port count,
  jack color/type, printed labels, per-jack connection); clicking a jack jumps
  to its full path.

## 7. Data Entry Paths

1. **CSV import** (see §8).
2. **Blank-list manual entry:** type rows into the grid; the visual populates.
3. **Visual-first:** drag devices onto the rack and map ports; the grid
   populates automatically.

All three write to the same normalized source of truth.

## 8. CSV Import (3-step wizard)

1. **Upload → column-map:** map CSV columns to fields (site/floor/room/rack/
   device codes, type, start-U, port #, connects-to path, cable name, status).
   Mappings savable as reusable presets.
2. **Validate → preview:** row-by-row preview with errors flagged — unknown
   device type, U out of range or overlapping, port already fully connected,
   unresolved connects-to path. **Transactional**: nothing is written until
   confirmed; no partial imports.
3. **Resolve → commit:** option to auto-create missing hierarchy; **merge by
   derived path** so re-importing updates rather than duplicates (idempotent).

## 9. Reports & Exports

Generated by reading the synced grid:

- **Port / patch schedule** (per rack or room).
- **Cable run list** (every segment: both ends + label + type/length).
- **Device inventory.**
- **Printable label sheets** (jacks, plates, cables) from the naming convention
  + free-text cable names.
- **Custom export:** column-picker + active filters → **CSV or PDF**.
- **Visual export:** rack elevation / faceplate → **PDF or PNG**.

## 10. Error Handling & Integrity

- **Import:** transactional, row-level error report, no partial writes.
- **Live edits:** block overlapping U placements; prevent invalid/duplicate
  port links and self-loops; flag orphaned cable ends.
- **Optimistic UI** with rollback on server rejection.
- **Audit:** every mutation recorded to the Activity Log.
- **Concurrency:** `updated_at` guard + "changed since you loaded" warning.

## 11. Testing Approach (TDD)

- **Unit:** path/label computation; channel graph traversal; planned-vs-built
  diff; CSV parse/validate/map; U-collision and port-link rules.
- **Integration:** CSV → DB → grid roundtrip; create device in SVG → grid
  reflects; status transitions.
- **Component / E2E:** drag device onto a U; link two ports; toggle
  Planned/As-built/Diff; render a faceplate; run an export.
- **Fixtures:** seed data mirroring the PATCHBOX example rack.

## 12. Future Extensions (explicitly deferred)

Multi-tenant auth/roles/billing · per-client configurable naming · floor-plan
import & annotation · networks/IP/logical config · access control · diagnostics
· client portal · full concurrent-edit conflict resolution.
