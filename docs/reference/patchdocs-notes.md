# PatchDocs reference notes

We are building on PatchDocs' concept (https://docs.patchdocs.io) but **tailored for an IT
company/MSP managing many clients** — device deployments, employees, cabling, installations,
consultations, and whole network infrastructures across multi-site customers. PatchDocs is
tailored to a company documenting *itself* (their multi-customer support is an admin add-on);
ours makes the client the primary axis. These notes summarise their documented system so our
features and docs follow a proven mental model — and record where we extend or diverge.
Sourced from their docs (read 2026-07-08): all Core Concepts, Features, and Administration pages.

## Our repositioning (the reason this product exists)

- **Their hierarchy:** Account → *Tenant (integrator add-on)* → Location → Floor → Room → Device.
- **Our hierarchy:** Account → **Client** (first-class, front of sidebar) → **Site** (their
  "Location") → Floor → Room → Device/Rack.
- One Client = one customer of the IT company: address, contacts, sites, and every piece of
  documentation under it. What their Tenants page treats as administration, we treat as the core
  product surface ("Clients" section), because the target user manages *many* clients daily.
- **Engagement scope varies per client** and the product must handle every phase of networking:
  some clients are cabling/racks/terminations/device-installations only; others are full lifecycle —
  construction-phase cabling → termination → installation → configuration → ongoing help desk.
- MSP-only concepts PatchDocs has no equivalent for (future roadmap): installations/jobs,
  consultations, **onboarding the client's employees** (their staff as documented users/contacts),
  per-client engagement scope/phase tracking, per-client reporting/handover.

## Resource hierarchy (their "Resource Types")

```
Account
└── Tenant  [integrator accounts only]        ⇒ OUR: Client
    └── Location                              ⇒ OUR: Site
        └── Floor        (one 2D plan each; not necessarily a literal storey)
            └── Room     (area on a floor; optional — implicit Room DEFAULT otherwise)
                ├── Device ──────────── Port ── Connection      (floor device)
                └── Rack   (a special floor device)
                    ├── Rack Device ─── Port ── Connection
                    └── Rack Tray
                        └── Tray Device ─ Port ── Connection
Global (per tenant): VLAN, WLAN — managed via Networks
```

- **Containers** (no ports): Account, Tenant, Location, Floor, Room, Rack, Rack Tray.
- **Connectable** (have ports): Device, Rack Device, Tray Device.
- **Ports**: wired (connector type: RJ45, LC, E2000, MPO…) or wireless (Client/Broadcast → WLAN).

## Name vs ID (their "Naming Scheme")

- **ID** — mandatory, short (≤10 chars, no spaces, uppercase convention), unique within parent.
  Nested IDs form the full path: `ACME/SING/27/MEET01/PR01/01`. Search + Connection Overview key.
  Tenant ID prefixes everything on integrator accounts (⇒ our Client code will).
- **Name** — optional human label; the migration home for legacy identifiers.
- Do/don't: short uppercase IDs, numeric floors, meaningful room IDs, one convention per account.

### Device-type ID prefixes ⇒ our Device Types "codes"

Each device type carries a **default ID prefix**; adding a device pre-fills `prefix + incrementing
number` (SW01, SW02…), overridable. Prefixes customisable + custom types creatable in the Device
Library. **Changing a prefix affects only newly added devices.**

Their standard lists (reference only — we keep our own rack list):
- Floor: ACP, AP, CAM, DP, TO, ISP, LP, PH, PR, 3DP, RK, SCR (matches ours exactly).
- Rack: CM, FW, MISC, PBX (Patchbox), PP, RT, TR (Rack Tray), TRD, SRV, SFP, SW, UPS.
- **Ours (rack):** Switch SW, Router RT, Firewall FW, Gateway GW, Patch Panel PP, Server SRV,
  UPS UPS, PDU PDU, KVM KVM, Cable Manager CM, Shelf/Tray ST, Other OTH.

## Device Library (their feature ≈ what we've built)

- **Device Types tab**: floor + rack types with default prefixes; customise; add custom types.
- **Custom rack device templates** via their Rack Device Editor: name, type, optional brand
  (remembered/deduped suggestions ≈ our BrandPicker), height **1–8 U** (ours: up to 60U),
  drag-drop ports/text/icons, independent Front/Back faces.
- **Port groups**: blocks sharing connector type, label prefix, one numbering sequence.
  Their face grid: two port rows per RU, whole-cell elements (ours is finer). Drag-to-multiply on
  placement; right handle=columns, bottom handle=rows; live numbering. Constraints: ≤99 ports/group,
  no overlaps, must fit face. First expansion sets counting direction from drag direction.
  Lone-in-its-columns group auto-centres vertically (ours too). **No undo** (explicit warning).
- **Numbering**: computed, never typed. Direction per group (top-to-bottom default = odd/even
  switch layout, or left-to-right). **Same prefix ⇒ one sequence** across groups left-to-right,
  Back continues after Front; different prefixes = independent sequences (P1–P24 + U1–U2).
  Prefix ≤4 chars.
- **Port names**: optional, ≤10 chars incl. prefix, unique per device across faces, auto-uppercase;
  face shows ≤5 chars + ellipsis; prefix change overflowing names prompts reset to numbers.
- **Text fields**: free text, left/centre/right, optional highlighted (inverted) style.
- **Icons**: icon picker, always square, 1×1–2×2 cells (ours: full Iconify, freer sizing,
  colour + opacity).
- **Deployed-template edits are destructive**: impact warning w/ affected devices + connection
  counts, downloadable PDF report, type-the-name confirm; rebuild deletes all connections, VLAN and
  SFP assignments on instances; instances that no longer fit their rack are dropped entirely.

## Rack Editor (their feature — our Phase 2b blueprint)

- Reached from Location View (select placed rack → pencil / "Configure rack").
- Three panels: **Settings Sidebar** (selected resource; autosaving), **Device Library Menu**
  (drag-drop palette), **Devices & Connections Panel** (bottom tabs: devices, connections, VLANs).
- Rack settings: notes, photos, dates, responsible person.
- Populate: drag from palette or click a free RU slot → picker popup.
- **Patching**: drag port→port to connect; select port → highlight whole connection; disconnect
  via context menu / Backspace.
- **Connection colours**: per-connection colour (presets or hex), carries across every hop, shown
  on ports/sidebar/panel lists.
- **Port states** (glanceable wiring status): solid blue = complete connection; light blue/dashed =
  incomplete; grey outline = unconnected; black filled patch-panel port = Building Connection in
  place ("keystone"); empty frame = no keystone.
- **Front/Back**: unrestricted use, but a rear port blocks mounting another device behind that RU.
- **VLAN assignment** per switch port via sidebar; VLANs tab highlights a VLAN's ports (amber icon
  = port in >1 VLAN).
- Outbound connections (rack device ↔ nearby floor device) via port context menu → Connection
  Configurator.
- Port renaming inline (unique per device, auto-uppercase; renames don't break connections).
- **Patchbox configurator**: per-slot cassette type (Copper/Fiber/Empty), cable type/length,
  colour or connector types; connected slots locked.
- Fit to width/height toggle, zoom, reset. **Autosave** with visible status + ⌘S manual trigger +
  leave-warning.

## Connections (core concept)

- **Building Connections** — permanent links / horizontal cabling (dashed orange). Terminate at
  TOs or patch panels. Must exist *before* user patching: they turn an empty patch-panel slot into
  a usable port (keystone metaphor). Managed via "Manage building connections" on a TO/patch panel
  (row per port; pick Location→Floor→Room→Rack→port of far end; cross-floor/location allowed).
- **User Connections** — user-maintainable patch cables (solid blue); drag-to-patch or plug icon.
- **Connection Overview** — end-to-end path of any connection, every hop by full resource ID
  (switch → patchbox cassette → patch panel → TO → AP). **Complete** = both ends reach an active
  device (passive hops in between don't matter); **incomplete** = one end dies at a passive hop.
  Complete/incomplete is a property of the whole connection; all its ports render in that state.
- Connections may span floors/locations/countries.

## Networks (VLANs & WLANs)

- Account/tenant-global; managed under Networks → VLANs / WLANs (add/edit/delete + notes).
- VLAN → assigned to switch ports in Rack Editor. WLAN → assigned to wireless ports (device in
  Location View: add wireless port → Connect → pick WLAN).

## Resources (their feature — account-wide tables)

Six tabs: Locations, Floors, Rooms, Devices (full inventory: manufacturer, model, serial,
warranty, responsible person…), Device Ports (VLAN/WLAN/connector/status), Device Connections
(full chains). Header filters, column show/hide, parent-scope filter, click-ID-to-jump,
CSV export (visible columns; page or all filtered rows). Use cases: inventory counts, warranty
planning, VLAN/WLAN audits, documentation-gap hunting, handover reports.
**MSP angle for ours: same tables but scoped/filtered per Client, and exports become client
handover/consultation deliverables.**

## Activity Log

Automatic, read-only audit of every create/update/delete on every resource incl. user invitations.
Entry: timestamp, action, resource type, resource (full path), user. Filters: date range, action,
resource type, resource, user (combinable). Use cases: post-incident "what changed", audit
accountability, onboarding oversight.

## Tenants (their System Integrator feature ⇒ our Clients)

- One tenant = one customer; owns Locations…WLANs; nothing leaks between tenants.
- Tenant: **ID** (short, uppercase, unique, prefixes the naming scheme, deletion token),
  **Name**, address (geocoded for Map View), contact person (documentation, not a login).
- **Tenant Switcher** at top of main menu (users only see tenants they have permission on).
- Only account-level Admins manage tenants. Deletion cascades everything; requires typing the ID;
  cannot delete the last tenant.
- Billing/subscription/rack licenses live at account level, pooled across tenants.
- **Ours differs:** Clients are the primary section (list/dashboard, not just a switcher);
  Sites live inside a Client; MSP workflows (jobs, consultations, staff) attach to Clients.

## Users & Permissions

- Two roles: **Reader** (account-wide read-only) and **Admin** (account-wide read + write on
  granted scopes). Read is global; **write is per-resource**, grantable at account / tenant /
  location / floor / room / single-device level; cascades downward only; multiple grants per user.
- Only account-level Admins invite users, manage billing, manage tenants.
- Unlimited users encouraged (shared logins undermine the audit trail).
- **Responsible Person** ≠ permissions: a documentation field on any resource; floor-level default
  inherits to new resources on it.
- Use-case scoping examples: electrician (Admin on specific floors → TOs + building connections),
  IT team (Admin at location level), tech team (Admin on rooms/devices), helpdesk (Reader).
- **MSP angle for ours:** grants per Client (technician sees only assigned clients), and
  client-staff logins scoped inside their own Client.

## Map / Location View (floor-plan editing)

- **Map View**: entry point; location cards + geocoded map; a Location = whatever is worth
  documenting independently (per building/store/hall; multiple can share an address). Creating one
  auto-creates a Ground Floor.
- **Location View**: floor-plan editor. Panels: Settings Sidebar, Devices Palette,
  Devices & Connections Panel. Floor settings: ID/name, floor-plan image upload, scale-to-real-
  world tool. Rooms drawn as rectangles/polygons (optional; else implicit DEFAULT room); devices
  inherit room ID in their path and re-path when moved. Devices dragged from palette or "+ Device"
  (ID pre-filled from type prefix). Ports managed per device in sidebar; same port-state colour
  key as Rack Editor.

## UI chrome (their "User Interface")

- **Main Menu** (left, collapsible ≡ / ⌘B): tenant switcher, infrastructure nav, Networks, Device
  Library, Resources, Activity Log, Settings, Billing, Report Issue. (Our sidebar mirrors this.)
- **Page Header breadcrumb** = current hierarchy position, clickable per level
  (`PBX-HQ → Floor 27 → MDF`) — worth adopting when Clients/Sites land.
- **Settings Sidebar** pattern: contextual details of selection, else current floor/rack; edits
  autosave immediately.

## Where we intentionally extend beyond their docs

- Editor: finer placement (sub-cell, vertical offsets, 6 label positions), per-port overrides
  (name, flip, label side, media/connector retype), multi-select everywhere, alt-drag duplicate,
  smart alignment/spacing guides (groups *and* icons), proportional/uniform multi-icon scaling,
  icon colour + opacity, full Iconify catalogue, discard-confirmation instead of "no undo".
- Devices table: search + sortable columns + pagination.
- Product: Client-first information architecture; MSP workflows (deployments, installations,
  consultations, employee assignment) that PatchDocs does not model.

## Roadmap implications (not yet built here)

1. **Clients** (their Tenants, elevated): client records (code/ID, name, address, contacts),
   client list + switcher, per-client scoping of everything below; typed-code cascade delete.
2. **Sites** (their Locations) under Clients; Floors + floor plans (upload, scale, rooms),
   Map View per client.
3. Racks + deploying templates (Devices Palette), destructive-rebuild semantics + impact report.
4. Connections: building vs user, patching UI, port states, connection colours, Connection
   Overview; Patchbox-style configurators.
5. Networks (VLAN/WLAN per client), SFP assignment.
6. Port naming + prefix-shared numbering sequences across groups/faces.
7. Resources tables + CSV exports (per client — handover deliverables).
8. Activity Log; Users & Permissions (per-client grants, responsible person).
9. Breadcrumb header navigation; context-aware docs via the top-bar notebook button.
