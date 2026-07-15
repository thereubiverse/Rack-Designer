# Rack patching — Slice 2a: connection endpoints (per-port far ends)

**Date:** 2026-07-14
**Status:** Design approved, ready for planning

**Scope:** Selecting a connection opens an editor in the right panel for the **far end** of each of
its two ports — what the run actually reaches out in the building (a camera, an access point, a data
outlet) or, for uplinks, a real switch/rack elsewhere on the site. Each endpoint is drawn
faceplate-style in a container and can be named.

## Relationship to the existing slice plan

The Slice 1 spec (`2026-07-14-rack-patching-slice-1-design.md`) decomposed patching into six slices,
where **Slice 2 "Building connections"** was to deliver keystone completion, cross-floor far ends,
complete/incomplete chains, and a Connection Overview, modelling far ends as *shared devices picked
out of the Location → Floor → Room → Rack hierarchy* (PatchDocs' model).

**This spec deliberately diverges** and is therefore numbered **2a**, not 2:

- Far ends are **described per port**, not shared entities. One physical 4-port outlet fed by four
  panel ports is described four times, once per port, with no link between them. This was chosen
  knowingly for speed; a shared far-end entity remains possible later and this model does not block it.
- **No cross-floor picker, no keystone/complete-incomplete chain states, no Connection Overview.**
  Those stay in Slice 2 proper.
- The one place a far end *is* a real reference is uplinks: a switch or rack elsewhere **on the same
  site** (see "Endpoint kinds").

## Decisions

- **An endpoint belongs to a PORT, not to a connection.** The horizontal cable out of `PP01/1` exists
  whether or not a patch cable is plugged into it. Selecting a connection is only the *route* to the
  editor; unplugging or re-patching the cable never destroys the endpoint.
- **Any rack port, either end, may own an endpoint.** Not restricted to patch-panel ports. The panel
  shows one editor card per end of the selected connection.
- **Endpoint types come from the existing `device_types` table, `category='floor'`** (Camera, Access
  Point, Access Control Panel, Telecommunications Outlet, ISP Uplink, Desktop, Laptop, Phone, Printer,
  Screen, 3D Printer). Already seeded and already user-extensible with custom types via Device Types
  settings; codes double as default ID prefixes (`CAM01`).
- **No new floor "Switch" type.** `device_types` has `UNIQUE (organization_id, code)` *global across
  categories*, and the rack Switch already owns `SW`; a second `SW` would make `SW01` ambiguous.
  Instead a switch far end is a **reference to the real `rack_device`**, whose type, name and
  faceplate are derived from it. `Rack` (`RK`) likewise drops out of the described list in favour of a
  real rack reference.
- **Outlets capture only the port the run lands on.** Pick the faceplate size so the drawing is right,
  then label just the landing port; the other ports render blank. Labelling every port would duplicate
  the same outlet's labels across each feeding panel port, where they could silently drift apart.
- **Every endpoint is drawn faceplate-style**, via the existing pure `renderFace` — not icons.

## Endpoint kinds

| Kind | Means | Payload | Drawn as |
|---|---|---|---|
| `described` | A far-end device described inline | `device_type_id` (floor), `name`, `port_count`, `landing_port_index`, `landing_port_label` | Built-in face for the type: `CAM`/`AP`/`ACP`/… = 1 RJ45; `TO` = the chosen 1/2/3/4/6 ports, landing port highlighted + labelled |
| `device` | A switch in another rack on this site | `target_rack_device_id` | The referenced device's **real face snapshot** |
| `rack` | Uplink to another rack on this site | `target_rack_id` | A small rack graphic with the rack's code |

`device`/`rack` store no type or name — both are derived from the referenced row, so they can never
drift out of sync with the thing they point at.

**The type select** lists: every `category='floor'` device type **except `RK`** (offered instead as
the `rack` kind, since an uplink is a real reference), then two built-in entries — *Switch (another
rack)* → `device`, and *Rack uplink* → `rack`.

**`port_count` is editable for `TO` only** (1/2/3/4/6). Every other described type uses its built-in
face's port count, which is 1; the field is not shown for them. `landing_port_index` is therefore
always 0 for single-port types, but `landing_port_label` stays editable for all of them — it is the
jack/outlet label the run terminates at.

**The `device` picker lists rack devices whose device type is Switch (`SW`)**, in racks *other than*
this one, on this site. (Widening it to any rack device is a one-line change if that proves too
strict in practice.)

## Architecture

Seven isolated components, mirroring Slice 1's split (table → pure ops → action → component):

1. **Migration `0007_port_endpoints.sql`** — the table, RLS `single_org_all`, grants (matching 0004–0006).
2. **`src/features/racks/endpointOps.ts`** (new, pure) — endpoint math + validation. No React, no I/O.
3. **`src/features/racks/endpointFaces.ts`** (new, pure) — built-in `Face` per floor type + port count.
4. **`src/features/racks/endpointsRepository.ts` + `saveEndpointsAction`** — load-by-rack and a
   reconcile save with server-side re-validation, mirroring `saveConnectionsAction`.
5. **Site-scope query** — the other racks in this site, and their Switch-type devices, via
   `room → floor → site`. Feeds both pickers and the server-side same-site check.
6. **`src/features/racks/ConnectionDetails.tsx`** (new) — the right panel; presentational + callbacks only.
7. **RackBuilder wiring** — `endpoints` joins the unified `RackState`, history, and autosave.

## Data model

```sql
CREATE TABLE port_endpoints (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rack_id            uuid NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  -- the rack port this endpoint hangs off (same identity `connections` uses)
  rack_device_id     uuid NOT NULL REFERENCES rack_devices(id) ON DELETE CASCADE,
  side               text NOT NULL CHECK (side IN ('front','back')),
  group_id           uuid NOT NULL,
  port_index         int  NOT NULL CHECK (port_index >= 0),

  kind               text NOT NULL CHECK (kind IN ('described','device','rack')),

  -- kind='described'
  device_type_id     uuid REFERENCES device_types(id) ON DELETE RESTRICT,
  name               text NOT NULL DEFAULT '',
  port_count         int  NOT NULL DEFAULT 1 CHECK (port_count IN (1,2,3,4,6)),
  landing_port_index int  NOT NULL DEFAULT 0,
  landing_port_label text NOT NULL DEFAULT '',

  -- kind='device' / kind='rack'
  target_rack_device_id uuid REFERENCES rack_devices(id) ON DELETE CASCADE,
  target_rack_id        uuid REFERENCES racks(id)        ON DELETE CASCADE,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (rack_device_id, side, group_id, port_index),
  CHECK (landing_port_index < port_count),
  CHECK (
    (kind='described' AND device_type_id IS NOT NULL AND target_rack_device_id IS NULL AND target_rack_id IS NULL)
 OR (kind='device'    AND target_rack_device_id IS NOT NULL AND device_type_id IS NULL AND target_rack_id IS NULL)
 OR (kind='rack'      AND target_rack_id IS NOT NULL AND device_type_id IS NULL AND target_rack_device_id IS NULL)
  )
);
```

**Port identity:** `{ rackDeviceId, side, groupId, portIndex }` — identical to `connections`, so the
same `PortRef` type and the same stability guarantees apply.

**Invariants** (enforced in `endpointOps` and **re-validated server-side** in `saveEndpointsAction`;
DB constraints are a backstop):

- **One endpoint per port** (unique index).
- `landing_port_index < port_count`; `port_count ∈ {1,2,3,4,6}` (CHECK).
- `described` → `device_type_id` must be `category='floor'` (not expressible as a CHECK: cross-table).
- `device`/`rack` → the target must be **on the same site** and **not this rack** (cross-table).

**Deletes:** `ON DELETE CASCADE` on the owning device/rack. `RESTRICT` on `device_type_id` so an
in-use type cannot be deleted (matching `device_templates`). **`CASCADE` on the targets** — deleting a
referenced far-end switch/rack removes the endpoint, on the grounds that an endpoint pointing at a
device that no longer exists is worse than losing the note.

## Types

```ts
type PortEndpoint =
  | { id: string; port: PortRef; kind: "described"; deviceTypeId: string; name: string;
      portCount: 1|2|3|4|6; landingPortIndex: number; landingPortLabel: string }
  | { id: string; port: PortRef; kind: "device"; targetRackDeviceId: string }
  | { id: string; port: PortRef; kind: "rack";   targetRackId: string };

endpointForPort(eps: PortEndpoint[], port: PortRef): PortEndpoint | null
upsertEndpoint(eps: PortEndpoint[], ep: PortEndpoint): PortEndpoint[]
removeEndpoint(eps: PortEndpoint[], id: string): PortEndpoint[]
validateEndpoint(ep: PortEndpoint, ctx: EndpointContext): string | null  // null = OK

faceForDescribed(typeCode: string, portCount: number): Face
```

`EndpointContext` carries what validation needs without I/O: the floor type ids, the ports present in
each device's snapshot, this rack's id, and the set of rack/device ids on this site.

## Data flow

**Load** — `src/app/racks/[id]/page.tsx` adds `listPortEndpoints(db, rackId)` and the site-scope query
to its existing parallel fan-out, passing both into `RackBuilder`.

**Edit** — select a connection → the sidebar renders `ConnectionDetails` for its two ports → an edit
fires a callback → `RackBuilder` runs `upsertEndpoint`/`removeEndpoint` and calls the existing
`commitState({ placements, connections, endpoints })`. That one path yields undo/redo (⌘Z spans all
three) and the 600 ms idempotent autosave through `saveEndpointsAction`, reusing the
Saving… / ✓ Saved / error chip.

Disconnecting a patch cable leaves endpoints untouched — they belong to the port.

## Error handling

- Server re-validation rejections (port absent from the snapshot, non-floor type, `landing >= count`,
  target off-site, target is this rack) return a reason; the existing error chip shows it, exactly as
  `validatePatch` does today.
- Deleting a device filters its endpoints client-side in the same `commitState` (mirroring the existing
  connection filter), with the DB cascade as backstop.
- Deleting an in-use `device_type` hits `RESTRICT`; the Device Types manager's existing in-use error
  already covers it.
- A port vanishing under a snapshot change is caught by re-validation, as with connections.

## Testing

- `endpointOps.test.ts` (pure, TDD) — one-per-port, landing < count, floor-only, same-site, not-this-rack.
- `endpointFaces.test.ts` (pure) — face shape per type code × port count 1/2/3/4/6.
- `ConnectionDetails.test.tsx` — both ends render; switching kind swaps the fields; edits fire callbacks;
  the correct face draws per kind.
- `endpoints.integration.test.ts` — reconcile save + each server-side rejection.
- Browser — set a camera endpoint + name, set a switch reference, confirm both faces, reload to prove
  persistence.

> **Test-run hazard:** `*.integration.test.ts` in this repo delete all `sites`, cascading to every
> rack. Run tests **by explicit filename only** — never a directory or glob (e.g. never
> `vitest run src/features/racks/`), which silently pulls the integration files in and empties the
> local DB.

## Out of scope

- Shared far-end entities (one outlet object fed by many ports) — Slice 2 proper.
- Cross-floor / cross-site far ends; the Location → Floor → Room → Rack picker.
- Keystone and complete/incomplete chain states; the Connection Overview panel.
- Port-level cross-rack references (a switch far end records the **device**, not a port — a port-level
  reference would be a second, parallel way to say "these two ports are joined" and could contradict
  the same-rack connection model).
- Per-connection colour/labels/length (Slice 3), VLANs (Slice 4), floor-plan parity (Slice 5),
  Connections table/export (Slice 6).
