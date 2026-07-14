# Rack patching — Slice 1: core connections & front-side patching

**Date:** 2026-07-14
**Status:** Design approved, ready for planning
**Scope:** The foundation slice of the rack-builder patching feature (Phase 2c).

## Context

The rack builder (Phase 2b) places device instances (`rack_devices`) into racks and renders
their faceplates via the pure `Faceplate` renderer. There is **no connection or port-identity
model yet** — ports are computed from `PortGroup`s by index (`layoutPortGroup` in
`src/domain/faceplate-geometry.ts`), and faces are looked up from the device **template** at
render time with no snapshot (`0004_rack_devices.sql` explicitly defers snapshot/rebuild
semantics "with connections in Phase 2c").

We studied PatchDocs' patching model in depth (hands-on walkthrough recorded in
`docs/reference/patchdocs-notes.md`, 2026-07-14). Its model is **two-tier**:

- **User connections** — front-side patch cables (switch ↔ patch panel), created by dragging
  port → port.
- **Building connections** — permanent horizontal cabling (patch-panel port → far-end port,
  possibly cross-floor), defined in a per-port table.

A chain is "complete" only when both exist and both ends terminate on active devices.

Patching decomposes into independent slices, each with its own spec → plan → build cycle:

| Slice | Delivers | Depends on |
|---|---|---|
| **1. Core connections + front patching** | Port identity, connection model, drag-to-patch in one rack, connected/unconnected states, disconnect, cable rendering, autosave | — |
| 2. Building connections | Keystone completion, cross-floor far ends, complete/incomplete chains, Connection Overview | 1 |
| 3. Metadata & bulk | Per-connection colour, cable labels/type/length, range/bulk patch, connector-mismatch validation | 1 |
| 4. VLANs | VLAN entities + per-switch-port assignment + highlight | 1 |
| 5. Outbound | Rack ↔ floor-device connections, floor-plan patching parity | 1, 2 |
| 6. Connections panel + export | From\|Via\|To table, filters, CSV client-handover export | 1, 2 |

**This spec covers Slice 1 only.** Slices 2–6 are explicitly out of scope.

## Decisions

- **Patch gesture:** drag port → port only (matches PatchDocs; no click/keyboard fallback in
  Slice 1).
- **Template-edit robustness:** snapshot a device's port layout onto the instance at placement.
  Patches stay stable; later template edits do not touch already-placed devices. A future
  "update placed device to latest template" is an explicit rebuild (not in Slice 1). This also
  resolves the "no snapshot" tension the codebase flagged.
- **Connection storage:** a dedicated `connections` table with typed FK endpoints (Approach A),
  both endpoints in the same rack. Building connections (Slice 2) are structurally different
  (per-port far-end, cross-floor) and will get their own table — we do not over-generalise now.
- **Face scope:** patching operates on the currently-shown face (Front *or* Back), both
  endpoints on that face. Front↔back cross-connections are deferred.

## Architecture

Five isolated components, each with one purpose:

1. **Migration `0006_connections.sql`** — snapshot columns on `rack_devices` + the `connections`
   table.
2. **`src/features/racks/connectionOps.ts`** (new, pure) — connection-list math. No React, no I/O;
   mirrors `rackOps.ts`.
3. **Repository + `saveConnectionsAction`** — persistence with server-side re-validation, mirroring
   `saveRackLayoutAction`.
4. **Patching overlay in `RackCanvas`** — computes port centres, draws cables, handles the drag
   gesture, selection, and disconnect.
5. **Snapshot-on-placement wiring** — the add-device path copies faces onto the instance;
   rendering reads from the snapshot (falling back to the template for un-backfilled rows).

## Data model

```sql
-- rack_devices gains a frozen copy of what was placed.
ALTER TABLE rack_devices
  ADD COLUMN front_face jsonb,
  ADD COLUMN back_face  jsonb,
  ADD COLUMN height_u   int;
-- One-time backfill from device_templates for existing rows.
-- Rendering uses COALESCE(snapshot, template) so nothing breaks mid-migration.

CREATE TABLE connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rack_id           uuid NOT NULL REFERENCES racks(id) ON DELETE CASCADE,
  a_rack_device_id  uuid NOT NULL REFERENCES rack_devices(id) ON DELETE CASCADE,
  a_side            text NOT NULL CHECK (a_side IN ('front','back')),
  a_group_id        uuid NOT NULL,
  a_port_index      int  NOT NULL CHECK (a_port_index >= 0),
  b_rack_device_id  uuid NOT NULL REFERENCES rack_devices(id) ON DELETE CASCADE,
  b_side            text NOT NULL CHECK (b_side IN ('front','back')),
  b_group_id        uuid NOT NULL,
  b_port_index      int  NOT NULL CHECK (b_port_index >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- RLS single_org_all policy + grants, matching 0004/0005.
-- A canonicalised unique index blocks exact duplicate edges (endpoint pair, order-independent).
```

**Port identity:** `{ rackDeviceId, side, groupId, portIndex }`. `portIndex` is the 0-based index
into the snapshot group (stable under label / number / VLAN changes; matches `portOverrides` keys
and `layoutPortGroup` indices). `groupId` is the `PortGroup.id` in the snapshot face.

**Invariants:**
- **One connection per port** — a port appears in at most one connection.
- **Same rack** — both endpoints reference `rack_devices` in the same `rack_id`.
- Enforced in `connectionOps` and **re-validated server-side** in `saveConnectionsAction`
  (consistent with the existing occupancy re-check). The DB unique index is a backstop against
  duplicate edges only; full port-exclusivity is application-enforced.

## Pure ops (`connectionOps.ts`)

```ts
type PortRef = { rackDeviceId: string; side: "front" | "back"; groupId: string; portIndex: number };
type Connection = { id: string; a: PortRef; b: PortRef };

samePort(x, y): boolean                       // identity equality
canonical(a, b): [PortRef, PortRef]           // order-independent endpoint pair
portConnection(conns, p): Connection | null   // the connection on a port, or null
isConnected(conns, p): boolean                // drives port state
portsOf(snapshotFace, rackDeviceId, side): PortRef[]  // enumerate valid ports for a face
validatePatch(conns, snapshots, a, b): string | null
   // rejects: same port; either port already connected; port absent from snapshot; different rack
addConnection(conns, a, b): Connection[]      // returns new list (+ generated id)
removeConnection(conns, id): Connection[]     // returns new list
portState(conns, p): "connected" | "unconnected"  // Slice-1 state set
```

No React. The overlay and the action consume these. `portState` returns only
`connected | unconnected` in Slice 1 (keystone / incomplete belong to Slice 2).

## Snapshot integration

- **On placement** (the "Insert device" path): copy the template's `front_face`, `back_face`, and
  height into the new `rack_device` row. The instance is thereafter self-contained.
- **On render**: `RackFrame` / `RackCanvas` read the face from the `rack_device` snapshot, falling
  back to the template only for un-backfilled legacy rows (`COALESCE`). Removes a template join
  from the hot render path.
- **Port centres**: `portCenters(rackDevice, face)` — for each group, `layoutPortGroup(group)`
  gives each port's `(x, y)` within the group; add the group origin + the device's `startU → y`
  offset + face x-origin → absolute canvas coords, then apply the canvas scale/pan transform. One
  helper feeds both cable drawing and drag hit-testing.

## Patching UX

**Drag gesture** (SVG overlay above the faceplates in `RackCanvas`):
- `pointerdown` on a port → enter patching drag; a rubber-band line follows the cursor from the
  source port centre.
- Hovered ports highlight valid / invalid (invalid = already-connected, or the source itself).
- `pointerup` on a valid target → `validatePatch` → `addConnection`, entering the autosave/undo
  history. Invalid target or empty space → cancel (rubber-band snaps away, no-op).

**Cable rendering:** orthogonal routing around the rack's **left edge** (matches PatchDocs; keeps
cables off the faceplates): port A → left-margin lane → target row → port B. Neutral blue default.
Per-connection colour and smarter bundling are Slice 3 — routing here is deliberately
dumb-but-predictable.

**Port states:** a connected port renders solid/filled; unconnected stays as the faceplate draws
it today. That is the entire Slice-1 state set.

**Selection & disconnect:**
- Click a connected port or its cable → select the connection → the whole run highlights **amber**.
- **Delete / Backspace** removes the selected connection (into undo history).
- The selected port's sidebar shows a minimal **Connection** line (`SW01/01 ↔ PP01/03`) with a
  disconnect affordance — not the full Connection-Overview chain (that is Slice 2).

**Face scope:** patching acts on the currently-shown face (Front *or* Back); both endpoints on
that face. The Front/Back toggle already exists.

**History & autosave:** patches and disconnects push onto the existing rack-builder undo/redo
history alongside placements; the autosave chip covers both.

## Error handling & edge cases

- **Port already connected** → `validatePatch` rejects; invalid drop-target; no-op on release.
- **Self-patch** (same port) → rejected.
- **Concurrent / stale writes** → `saveConnectionsAction` re-validates every edge server-side
  (ports still exist in the snapshot and are still unconnected) before committing, drops edges
  that no longer hold, and returns the reconciled set — same stance as `saveRackLayoutAction`.
- **Device deleted while patched** → FK `ON DELETE CASCADE` removes its connections.
- **Snapshot missing on a legacy row** → render falls back to the template; the placement path
  backfills the snapshot on first patch if needed.

## Testing

- **`connectionOps.test.ts`** (pure, exhaustive): validate / add / remove, one-per-port,
  self-patch, canonical equality, `isConnected`, `portsOf`, `portState`.
- **`portCenters` geometry test**: a known device + group yields expected absolute coords (guards
  the cable-anchor math).
- **Repository / action integration test**: insert/remove reconcile, server re-validation drops a
  stale edge, cascade-on-device-delete.
- **`RackCanvas` component test**: synthetic `PointerEvent` drag port → port creates a connection;
  drag to an occupied port is a no-op; Delete removes a selected connection.

## Success criteria

In a single rack, on the current face: drag a port to another port to create a cable; connected
ports render solid; select + Delete disconnects; connections persist across reload, respect
undo/redo, and one-cable-per-port holds.

## Out of scope (later slices)

Building connections, keystone / complete-incomplete states, per-connection colour, bulk/range
patching, connector-mismatch validation, VLANs, cross-face and cross-floor/outbound connections,
the Connections panel and CSV export.
