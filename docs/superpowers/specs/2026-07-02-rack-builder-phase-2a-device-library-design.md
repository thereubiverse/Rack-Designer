# Phase 2a — Device Library & Rack Device Editor — Design Spec

**Date:** 2026-07-02
**Status:** Approved (design), pending implementation plan
**Author:** Reuben Singh (with Claude)
**Parent:** [2026-07-02-rack-builder-design.md](2026-07-02-rack-builder-design.md) · **Phase 2 of** the rack-builder beachhead

---

## 1. Context

Phase 1 (merged) delivered the location hierarchy, derived-naming engine, repository,
and a synced rack grid. Phase 2 adds the Device Library and the visual rack builder;
it is split into two shippable sub-phases:

- **Phase 2a (this spec): Device Library + Rack Device Editor** — author reusable
  device templates.
- **Phase 2b (later): Visual rack builder** — place library devices into racks.

The UX benchmark remains PATCHDOCS ("match then beat it"). Phase 2a was designed
against live mockups and validated by reproducing real devices (a 48-port 1U switch
and a custom 10.6″ multi-media device).

## 2. Scope

### In scope
- **Device Library** page (org-level, reusable across every site and client) with two
  tabs: **Rack Devices** and **Device Types**.
- **Rack Devices** tab: searchable/sortable table of custom device templates (Name,
  Brand, Type, Rack units, Actions), with a **Create** button.
- **Device Types** tab: managed list of device types (Switch, Router, …).
- **Rack Device Editor** modal (opened by Create / edit): author a device template —
  header fields, a Port Types + Elements palette, a faceplate grid, and Port
  Group / per-port settings.
- Reusable **brands** and **device types** reference lists (org-scoped).
- The custom **port-type icon set** (our own SVGs) + Tabler element icons.

### Out of scope (later)
- Placing devices into racks / instantiating concrete ports (Phase 2b).
- Connectivity, cabling, faceplate endpoint viewer, planned-vs-built, CSV, reports.
- Multi-tenant auth (data is org-scoped now; auth layers on later).

## 3. Information Architecture

- **Device Library** is a top-level nav item (org-level; templates & types are shared
  across all of an org's sites/clients).
- **Rack Devices tab** → "Custom Rack Devices" table (Name · Brand · Type · Rack
  units · Actions) + Search + **Create**. **Create** (or an Actions ▸ edit) opens the
  **Rack Device Editor** modal.
- **Device Types tab** → manage the org's device-type list.

## 4. Rack Device Editor

### 4.1 Header fields
- **Name** * (text)
- **Brand** (clearable combobox, from the org brand list; add-your-own)
- **Device type** * (combobox, from Device Types)
- **Rack units** (select: 1 RU, 2 RU, …)
- **Width (in)** (numeric) — the device **body** width in inches; drives the editable
  grid width.

### 4.2 Toolbar / palette
- **Port Types** palette: Copper, Fiber, SFP, USB-A, USB-C, HDMI, DP, VGA, PS/2, Audio.
- **Elements** palette: Text, Icon.
- Vertical "Port Types" / "Elements" labels are centered on their boxes.
- Right side, stacked: **Front / Back** toggle (top), **Rack Mounted** toggle (below).
- The palette **wraps responsively**; the whole editor reflows at narrow widths (fields
  → 2×2, palette wraps, toggles stack, footer buttons stack).

### 4.3 Faces
- Each device has **separate Front and Back faceplate layouts** (Front/Back toggle).
- All groups and elements are per-face.

### 4.4 Building port groups
- **Drag a Port Type onto the grid** → creates a **port group** (one port to start).
- **Edge chevrons** on the selection: a **›** circle on the right edge adds a **column**
  of ports; a **⌄** circle on the bottom edge adds a **row** of ports.
- **Spacing handle**: a small solid-blue circle at the **bottom-right corner** of the
  selection. Dragging it **spreads the ports/labels** apart — horizontal drag increases
  column spacing, vertical drag increases row spacing. Movement is **clamped with a hard
  static stop**: the last port can reach the grid's right/bottom edge but never past it
  (no pushing into the ears or off the device). The spacing limit is computed once on
  grab (smooth, non-choppy).
- **Selection box** wraps the group **including its port-number labels**.
- Default port spacing is tight; the handle only widens it.

### 4.5 Port Group Settings (group selected)
- **ID prefix** (text)
- **Counting Direction** (Top-to-bottom, Bottom-to-top, Left-to-right, Right-to-left)
- **Connector type** (depends on media — Copper: RJ45/RJ11/Keystone · Fiber:
  LC/SC/ST/MPO-MTP · SFP: SFP/SFP+/SFP28/QSFP/QSFP+ · others: single)
- **Delete port group**
- **No group-level Flip** — flipping is per-port (see 4.6).
- **Numbering is user-decided** — no forced scheme; the app may suggest a per-media
  prefix, but the user controls prefixes/start.

### 4.6 Per-port selection
- Clicking an individual port selects it: its **label and icon turn blue** (no box).
- The right panel shows the port's **name field** and a single **Flip** toggle
  (**vertical only**). Flipping rotates just the port glyph; the **number label stays in
  place**. Ports flip individually.

### 4.7 Elements
- **Text element:** drag onto the grid; settings = **content**, **Alignment**
  (Left/Center/Right), **Highlighted** toggle (renders as an inverted black label with
  white text). Resize handles **expand the text box**, not the font (font stays fixed;
  text aligns within the larger box).
- **Icon element:** drag onto the grid; **Select Icon** opens a searchable picker over a
  large open icon set (**Tabler Icons**, ~5000). Resize handles **scale the glyph**.
- Both are per-face, repositionable, deletable.

## 5. Rendering rules (the faceplate)

- **1U proportion:** the device is rendered at true rack proportion — the full mounting
  frame is **19″ wide** (the rail width) × **1.75″ per U** tall (`aspect ≈ 19 : 1.75×U`).
- **Rack-mount geometry (Rack Mounted on):**
  - The **outer frame = 19″** rail width; its outer edges are **locked** in place.
  - The **body (editable grid) = the Width(in) value**, **centered** in the frame.
  - The **ears fill the gap** between the body and the rails — so the **narrower the
    body, the wider the ears** (a 10.6″ body has large bridging ears on a 19″ frame).
  - **Screw holes** are pinned near the **outer edges** (rail positions) so they line up
    on the rack regardless of body width; hole count/spacing scales with rack units.
- **Rack Mounted off (stand-alone):** the ears are **removed** and the device **clips to
  the grid edges**; the editable grid stays the **same size** and **in place** (no
  reclaim/widen/shift).
- **FRONT / BACK** side label sits **beside the right ear**; the whole
  ear·grid·ear·label unit is **centered** in the window.
- **Ports:** every port cell is **uniform width**, and every port-type glyph is
  **normalized to the same rendered width** (connector-accurate but width-consistent).
- **Vertical centering:** a single-row group is **centered by its icon**; adding a row
  keeps the group centered by the icons; center is maintained when spacing changes.
- **Numbers:** tabular figures, placed above the top row / below the bottom row with
  clear separation from the glyph; labels sit inside the selection box.
- **Selection UI on top:** selection box, chevrons, and spacing handle render above the
  device and are never clipped. Handles are small, tidy circles.
- **Flipped ports:** glyph mirrored vertically; label unaffected.
- **Empty faceplate space is editable grid** — the user can drop ports anywhere (e.g. a
  console/USB port to the left of the main block).

## 6. Data model (extends the master model)

All tables carry `organization_id`.

- **`brands`**: id, organization_id, name.
- **`device_types`**: id, organization_id, name.
- **`device_templates`**:
  - id, organization_id, name, brand_id (nullable), device_type_id, `rack_units` (int),
    `width_in` (numeric), `rack_mounted` (bool), created_at, updated_at
  - `front_face jsonb`, `back_face jsonb` — each a **Face** (or null)
- **Face** (jsonb): `{ port_groups: PortGroup[], elements: Element[] }`
- **PortGroup**: `{ id, media, connector_type, id_prefix, counting_direction, rows,
  cols, grid_x, grid_y, col_spacing, row_spacing, port_overrides: { index → { name?,
  flipped? } } }`
- **Element**: `{ id, kind: 'text' | 'icon', grid_x, grid_y, w, h,
  text?: { content, alignment, highlighted }, icon?: { name } }`

Notes:
- A template is a **design-time authoring artifact**. When a device is **placed in a
  rack** (Phase 2b), it **instantiates concrete Port rows** from the template's groups
  (per the master data model: "instantiate concrete ports").
- `port_overrides` capture per-port name and per-port vertical flip.
- `media` ∈ copper, fiber, sfp, usb_a, usb_c, hdmi, dp, vga, ps2, audio.

## 7. Icons (asset)

- **Port-type icons (10):** our **own original SVGs**, connector-accurate and
  **width-normalized**; stored in-repo, `currentColor`-driven. Copper renders as an RJ45
  jack; SFP a solid cage; USB-A/C, HDMI, DP, VGA, PS/2, Audio, Fiber each their own
  glyph. Acceptance bar: **reads unmistakably as each connector** and all render at the
  same width.
- **Element icons (Text, Icon)** and the **icon-element picker** use **Tabler Icons**
  (open-source, MIT).

## 8. Visual style

Clean light theme, **Inter** typeface, blue primary (`#2563eb`), black-pill Front/Back
toggle, subtle borders and rounded cards — matching the benchmark's polish. The editor
is a modal over the Device Library page.

## 9. Architecture

Consistent with the master spec: **Next.js + Supabase**, org-scoped RLS-ready, **SVG**
for all faceplate rendering (data-bound, exportable). The faceplate is a pure function
of the template data (a `renderFace(face, { widthIn, rackUnits, rackMounted })`
component), reused later in Phase 2b's rack view. Feature module: `device-library/`
(template CRUD, editor, faceplate renderer, icon set, brands/types).

## 10. Error handling & edge cases

- Validation: Name and Device type required; Width(in) > 0; Rack units ≥ 1.
- Spacing clamp prevents ports overflowing the grid.
- Deleting a device type/brand in use: block or reassign (decide at plan time; default —
  block with a friendly message).
- A template with an empty face is valid (front-only or back-only devices).

## 11. Testing (TDD)

- **Unit (pure geometry/logic):** ear width = f(width_in, frame=19″); spacing-clamp max
  (last-port-at-edge); port numbering from counting direction + prefix; width
  normalization across media; face → renderable model.
- **Component:** drag a port type → group created; edge chevrons add column/row; spacing
  handle spreads + hard-stops; per-port select turns blue + vertical flip keeps label;
  Text element (content/align/highlight, box-resize-not-font); Icon element (pick +
  scale); Rack Mounted toggle drops ears and holds the grid; responsive reflow.
- **Integration:** template + brand + device-type CRUD against Supabase; front/back
  faces persist and round-trip.
- **Visual/asset:** port icons render at uniform width and match the reference bar.

## 12. Decomposition note

Phase 2a is itself sizable; the implementation plan may sequence it as: (1) data model +
brands/types + template CRUD list, (2) the SVG faceplate renderer + rack-mount geometry,
(3) the editor modal + palette + port-group build/spacing/flip, (4) Text/Icon elements +
icon picker. Each slice should be independently testable.
