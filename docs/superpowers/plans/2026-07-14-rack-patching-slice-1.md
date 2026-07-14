# Rack Patching — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user drag one port onto another inside a single rack to create a patch cable, see connected ports rendered solid, select and delete a cable, with everything persisted and covered by undo/redo.

**Architecture:** A new `connections` table stores patch edges (typed FK endpoints, both in one rack). Device port layouts are snapshotted onto `rack_devices` at placement so patches survive later template edits. Pure `connectionOps` does all connection math; a pure `portGeometry` helper turns a placed device's snapshot face into absolute port centres; a `PatchLayer` overlay inside `RackCanvas` draws cables and handles the drag gesture; connections join the rack builder's existing undo/redo + autosave.

**Tech Stack:** Next.js 16 (App Router, server actions), React 18, TypeScript (strict), Supabase (local via Docker, port 54322), Vitest + @testing-library/react. SVG rendering.

## Global Constraints

- TypeScript strict; `npx tsc --noEmit` must stay clean.
- Migrations are append-only SQL files in `supabase/migrations/`, numbered `000N_*.sql`; each ends with the `single_org_all` RLS policy + the `grant …` lines exactly as `0004`/`0005` do.
- Pure logic modules (`*Ops.ts`, geometry) contain **no React and no I/O**, mirroring `rackOps.ts`.
- Server actions live in `"use server"` files, return `{ ok: boolean; error?: string }` (or a data variant stated per task), and **re-validate** against fresh DB state before writing, mirroring `saveRackLayoutAction`.
- Port identity is `{ rackDeviceId, side, groupId, portIndex }`; `portIndex` is the 0-based index into a snapshot `PortGroup` (matches `portOverrides` keys and `layoutPortGroup` indices).
- Invariants: **one connection per port**; **both endpoints in the same rack**. Enforced in `connectionOps` and re-validated server-side.
- Slice 1 scope only: same-face, single-rack, drag-only, connected/unconnected states. No building connections, colours, bulk, VLAN, cross-face/floor, or Connections panel.
- Local DB commands use `docker exec supabase_db_network-doc-platform psql -U postgres -d postgres` (no local `psql`). `cd` into the project first in every Bash call (cwd resets).
- Run tests one file at a time to avoid the known concurrent-run contention (`npx vitest run <file>`).

## File Structure

**Create:**
- `supabase/migrations/0006_connections.sql` — snapshot columns on `rack_devices` + `connections` table.
- `src/features/racks/connectionOps.ts` — pure connection math + `PortRef`/`Connection` types.
- `src/features/racks/connectionOps.test.ts` — unit tests.
- `src/features/racks/portGeometry.ts` — `portCenters()` pure helper.
- `src/features/racks/portGeometry.test.ts` — unit tests.
- `src/features/racks/connectionsRepository.ts` — `listConnections` / `replaceConnections` / row types.
- `src/features/racks/PatchLayer.tsx` — SVG overlay: port hit-dots, cables, drag gesture.

**Modify:**
- `src/features/racks/repository.ts` — `RackDeviceRow`/`RackDeviceInput` gain `front_face`/`back_face`/`height_u`; `listRackDevices` selects them.
- `src/features/racks/actions.ts` — add `saveConnectionsAction`; snapshot faces on insert in `saveRackLayoutAction`.
- `src/app/racks/[id]/page.tsx` — load connections; pass to `RackBuilder`.
- `src/features/racks/RackBuilder.tsx` — carry snapshot faces + connections; unified history; dual autosave; render from snapshot.
- `src/features/racks/RackCanvas.tsx` — render `PatchLayer`; route patch/disconnect callbacks; extend Delete handling to connections.
- `src/features/racks/RackFrame.tsx` — expose nothing new (already exports `ruTopY`, `RACK_GUTTER_L`, `RACK_PAD`); `RackPlacementRender` unchanged.

---

## Task 1: Migration — snapshot columns + connections table

**Files:**
- Create: `supabase/migrations/0006_connections.sql`

**Interfaces:**
- Produces: `rack_devices.front_face jsonb`, `rack_devices.back_face jsonb`, `rack_devices.height_u int`; table `connections(id, rack_id, a_rack_device_id, a_side, a_group_id, a_port_index, b_rack_device_id, b_side, b_group_id, b_port_index, created_at, updated_at)`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0006_connections.sql`:

```sql
-- supabase/migrations/0006_connections.sql
-- Slice 1 patching: freeze each placed device's port layout onto the instance so patches
-- survive later template edits, and add the patch-cable (user connection) table.

-- 1. Snapshot columns on rack_devices (nullable; backfilled from templates for existing rows).
alter table rack_devices
  add column front_face jsonb,
  add column back_face  jsonb,
  add column height_u   int;

update rack_devices rd
   set front_face = dt.front_face,
       back_face  = dt.back_face,
       height_u   = dt.rack_units
  from device_templates dt
 where rd.device_template_id = dt.id;

-- 2. Patch cables. Both endpoints reference rack_devices in the same rack.
create table connections (
  id                uuid primary key default gen_random_uuid(),
  rack_id           uuid not null references racks(id) on delete cascade,
  a_rack_device_id  uuid not null references rack_devices(id) on delete cascade,
  a_side            text not null check (a_side in ('front','back')),
  a_group_id        uuid not null,
  a_port_index      int  not null check (a_port_index >= 0),
  b_rack_device_id  uuid not null references rack_devices(id) on delete cascade,
  b_side            text not null check (b_side in ('front','back')),
  b_group_id        uuid not null,
  b_port_index      int  not null check (b_port_index >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Backstop against exact duplicate edges (order-independent). App logic enforces the
-- stronger one-connection-per-port rule and re-validates server-side.
create unique index connections_edge_uniq on connections (
  rack_id,
  least(a_rack_device_id::text || a_side || a_group_id::text || a_port_index::text,
        b_rack_device_id::text || b_side || b_group_id::text || b_port_index::text),
  greatest(a_rack_device_id::text || a_side || a_group_id::text || a_port_index::text,
           b_rack_device_id::text || b_side || b_group_id::text || b_port_index::text)
);

alter table connections enable row level security;
create policy "single_org_all" on connections for all using (true) with check (true);

grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

- [ ] **Step 2: Apply the migration**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx supabase migration up`
Expected: applies `0006_connections.sql` with no error.

- [ ] **Step 3: Verify the schema**

Run:
```bash
cd /Users/reubensingh/development/network-doc-platform && docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "\d connections" -c "select column_name from information_schema.columns where table_name='rack_devices' and column_name in ('front_face','back_face','height_u');"
```
Expected: the `connections` table description prints, and `front_face`, `back_face`, `height_u` are listed.

- [ ] **Step 4: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && git add supabase/migrations/0006_connections.sql && git commit -m "feat(patching): migration — rack_devices face snapshot + connections table"
```

---

## Task 2: Pure connection ops

**Files:**
- Create: `src/features/racks/connectionOps.ts`
- Test: `src/features/racks/connectionOps.test.ts`

**Interfaces:**
- Consumes: `Face` from `@/domain/faceplate`.
- Produces:
  - `type PortRef = { rackDeviceId: string; side: "front" | "back"; groupId: string; portIndex: number }`
  - `type Connection = { id: string; a: PortRef; b: PortRef }`
  - `samePort(x: PortRef, y: PortRef): boolean`
  - `portsOf(face: Face, rackDeviceId: string, side: "front"|"back"): PortRef[]`
  - `portConnection(conns: Connection[], p: PortRef): Connection | null`
  - `isConnected(conns: Connection[], p: PortRef): boolean`
  - `portState(conns: Connection[], p: PortRef): "connected" | "unconnected"`
  - `validatePatch(conns: Connection[], portsByDevice: Record<string, PortRef[]>, a: PortRef, b: PortRef): string | null`
  - `addConnection(conns: Connection[], a: PortRef, b: PortRef, id?: string): Connection[]`
  - `removeConnection(conns: Connection[], id: string): Connection[]`

- [ ] **Step 1: Write the failing test**

Create `src/features/racks/connectionOps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Face, PortGroup } from "@/domain/faceplate";
import {
  samePort, portsOf, portConnection, isConnected, portState,
  validatePatch, addConnection, removeConnection, type PortRef,
} from "./connectionOps";

const grp = (id: string, cols: number): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const face = (groups: PortGroup[]): Face => ({ portGroups: groups, elements: [] });
const ref = (d: string, g: string, i: number): PortRef =>
  ({ rackDeviceId: d, side: "front", groupId: g, portIndex: i });

const swFace = face([grp("g-sw", 24)]);
const ppFace = face([grp("g-pp", 24)]);
const portsByDevice = {
  sw: portsOf(swFace, "sw", "front"),
  pp: portsOf(ppFace, "pp", "front"),
};

describe("portsOf", () => {
  it("enumerates one PortRef per port cell", () => {
    expect(portsOf(swFace, "sw", "front")).toHaveLength(24);
    expect(portsOf(swFace, "sw", "front")[0]).toEqual(ref("sw", "g-sw", 0));
  });
});

describe("samePort", () => {
  it("is identity equality over all four fields", () => {
    expect(samePort(ref("sw", "g-sw", 0), ref("sw", "g-sw", 0))).toBe(true);
    expect(samePort(ref("sw", "g-sw", 0), ref("sw", "g-sw", 1))).toBe(false);
    expect(samePort(ref("sw", "g-sw", 0), ref("pp", "g-sw", 0))).toBe(false);
  });
});

describe("validatePatch", () => {
  it("accepts two distinct free ports that exist", () => {
    expect(validatePatch([], portsByDevice, ref("sw", "g-sw", 0), ref("pp", "g-pp", 0))).toBeNull();
  });
  it("rejects patching a port to itself", () => {
    expect(validatePatch([], portsByDevice, ref("sw", "g-sw", 0), ref("sw", "g-sw", 0)))
      .toMatch(/same port/i);
  });
  it("rejects a port that is already connected", () => {
    const conns = addConnection([], ref("sw", "g-sw", 0), ref("pp", "g-pp", 0), "c1");
    expect(validatePatch(conns, portsByDevice, ref("sw", "g-sw", 0), ref("pp", "g-pp", 1)))
      .toMatch(/already connected/i);
    expect(validatePatch(conns, portsByDevice, ref("sw", "g-sw", 1), ref("pp", "g-pp", 0)))
      .toMatch(/already connected/i);
  });
  it("rejects a port absent from the snapshot", () => {
    expect(validatePatch([], portsByDevice, ref("sw", "g-sw", 99), ref("pp", "g-pp", 0)))
      .toMatch(/no longer exists|does not exist/i);
  });
});

describe("add / remove / query", () => {
  it("addConnection appends with a generated id and is queryable", () => {
    const conns = addConnection([], ref("sw", "g-sw", 0), ref("pp", "g-pp", 0));
    expect(conns).toHaveLength(1);
    expect(conns[0].id).toBeTruthy();
    expect(isConnected(conns, ref("sw", "g-sw", 0))).toBe(true);
    expect(isConnected(conns, ref("pp", "g-pp", 0))).toBe(true);
    expect(isConnected(conns, ref("sw", "g-sw", 1))).toBe(false);
    expect(portConnection(conns, ref("pp", "g-pp", 0))?.id).toBe(conns[0].id);
    expect(portState(conns, ref("sw", "g-sw", 0))).toBe("connected");
    expect(portState(conns, ref("sw", "g-sw", 1))).toBe("unconnected");
  });
  it("removeConnection drops by id", () => {
    const conns = addConnection([], ref("sw", "g-sw", 0), ref("pp", "g-pp", 0), "c1");
    expect(removeConnection(conns, "c1")).toHaveLength(0);
    expect(removeConnection(conns, "nope")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/connectionOps.test.ts`
Expected: FAIL — cannot find module `./connectionOps`.

- [ ] **Step 3: Write the implementation**

Create `src/features/racks/connectionOps.ts`:

```ts
// Pure patch-cable math for the rack builder. No React, no I/O (mirrors rackOps.ts).
// A port is identified against a device's SNAPSHOT face by (rackDeviceId, side, groupId, portIndex).
import type { Face } from "@/domain/faceplate";

export type PortRef = { rackDeviceId: string; side: "front" | "back"; groupId: string; portIndex: number };
export type Connection = { id: string; a: PortRef; b: PortRef };

export function samePort(x: PortRef, y: PortRef): boolean {
  return x.rackDeviceId === y.rackDeviceId && x.side === y.side
    && x.groupId === y.groupId && x.portIndex === y.portIndex;
}

/** Every patchable port on one face of one placed device, in index order per group. */
export function portsOf(face: Face, rackDeviceId: string, side: "front" | "back"): PortRef[] {
  const out: PortRef[] = [];
  for (const g of face.portGroups) {
    const count = g.rows * g.cols;
    for (let i = 0; i < count; i++) out.push({ rackDeviceId, side, groupId: g.id, portIndex: i });
  }
  return out;
}

export function portConnection(conns: Connection[], p: PortRef): Connection | null {
  return conns.find((c) => samePort(c.a, p) || samePort(c.b, p)) ?? null;
}

export function isConnected(conns: Connection[], p: PortRef): boolean {
  return portConnection(conns, p) !== null;
}

export function portState(conns: Connection[], p: PortRef): "connected" | "unconnected" {
  return isConnected(conns, p) ? "connected" : "unconnected";
}

const exists = (portsByDevice: Record<string, PortRef[]>, p: PortRef): boolean =>
  (portsByDevice[p.rackDeviceId] ?? []).some((q) => samePort(q, p));

/** null = OK to patch; otherwise a human-readable reason. */
export function validatePatch(
  conns: Connection[], portsByDevice: Record<string, PortRef[]>, a: PortRef, b: PortRef,
): string | null {
  if (samePort(a, b)) return "Cannot patch a port to the same port";
  if (!exists(portsByDevice, a) || !exists(portsByDevice, b)) return "That port no longer exists";
  if (isConnected(conns, a) || isConnected(conns, b)) return "That port is already connected";
  return null;
}

export function addConnection(conns: Connection[], a: PortRef, b: PortRef, id?: string): Connection[] {
  return [...conns, { id: id ?? crypto.randomUUID(), a, b }];
}

export function removeConnection(conns: Connection[], id: string): Connection[] {
  return conns.filter((c) => c.id !== id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/connectionOps.test.ts`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && git add src/features/racks/connectionOps.ts src/features/racks/connectionOps.test.ts && git commit -m "feat(patching): pure connectionOps (validate/add/remove/query)"
```

---

## Task 3: Port geometry helper

**Files:**
- Create: `src/features/racks/portGeometry.ts`
- Test: `src/features/racks/portGeometry.test.ts`

**Interfaces:**
- Consumes: `frameDims` + `layoutPortGroup` + `CELL_W` + `ROW_H` from `@/domain/faceplate-geometry`; `ruTopY` + `RACK_GUTTER_L` + `RACK_PAD` from `./RackFrame`; `PortRef` from `./connectionOps`; `Face` from `@/domain/faceplate`.
- Produces: `type PortDot = { port: PortRef; x: number; y: number }` and
  `portCenters(args: { rackDeviceId: string; side: "front"|"back"; face: Face; startU: number; rackUnits: number; widthIn: number; rackMounted: boolean; heightU: number }): PortDot[]` — absolute port centres in **rack-SVG coordinates** (the space `RackFrame` draws in; the `RackCanvas` transform scales it).

- [ ] **Step 1: Write the failing test**

Create `src/features/racks/portGeometry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Face, PortGroup } from "@/domain/faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H } from "@/domain/faceplate-geometry";
import { ruTopY, RACK_GUTTER_L, RACK_PAD } from "./RackFrame";
import { portCenters } from "./portGeometry";

const group: PortGroup = {
  id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 2, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
};
const face: Face = { portGroups: [group], elements: [] };

describe("portCenters", () => {
  const args = { rackDeviceId: "d1", side: "front" as const, face, startU: 1,
    rackUnits: 1, widthIn: 19, rackMounted: true, heightU: 12 };

  it("returns one dot per port with the right PortRef", () => {
    const dots = portCenters(args);
    expect(dots).toHaveLength(2);
    expect(dots[0].port).toEqual({ rackDeviceId: "d1", side: "front", groupId: "g1", portIndex: 0 });
  });

  it("places a port centre at ix + earWidth + cell.x + CELL_W/2, deviceTop + cell.y + ROW_H/2", () => {
    const dims = frameDims({ widthIn: 19, rackUnits: 1, rackMounted: true });
    const cell = layoutPortGroup(group, dims.heightPx).cells[0];
    const ix = RACK_GUTTER_L + RACK_PAD;
    const top = ruTopY(1, 1, 12);
    const dot = portCenters(args)[0];
    expect(dot.x).toBeCloseTo(ix + dims.earWidthPx + cell.x + CELL_W / 2, 5);
    expect(dot.y).toBeCloseTo(top + cell.y + ROW_H / 2, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/portGeometry.test.ts`
Expected: FAIL — cannot find module `./portGeometry`.

- [ ] **Step 3: Write the implementation**

Create `src/features/racks/portGeometry.ts`:

```ts
// Absolute port centres for a placed device, in the rack-SVG coordinate space RackFrame draws in.
// Mirrors Faceplate.renderFace's port placement exactly: the body group is translated by the ear
// width, layoutPortGroup gives each cell's (x,y), and the glyph centre is +CELL_W/2 / +ROW_H/2.
import type { Face } from "@/domain/faceplate";
import { frameDims, layoutPortGroup, CELL_W, ROW_H } from "@/domain/faceplate-geometry";
import { ruTopY, RACK_GUTTER_L, RACK_PAD } from "./RackFrame";
import type { PortRef } from "./connectionOps";

export type PortDot = { port: PortRef; x: number; y: number };

export function portCenters(args: {
  rackDeviceId: string; side: "front" | "back"; face: Face;
  startU: number; rackUnits: number; widthIn: number; rackMounted: boolean; heightU: number;
}): PortDot[] {
  const { rackDeviceId, side, face, startU, rackUnits, widthIn, rackMounted, heightU } = args;
  const dims = frameDims({ widthIn, rackUnits, rackMounted });
  const ix = RACK_GUTTER_L + RACK_PAD;                 // faceplate origin x in rack-SVG space
  const deviceTop = ruTopY(startU, rackUnits, heightU); // faceplate origin y
  const dots: PortDot[] = [];
  for (const g of face.portGroups) {
    const laid = layoutPortGroup(g, dims.heightPx);
    for (const cell of laid.cells) {
      dots.push({
        port: { rackDeviceId, side, groupId: g.id, portIndex: cell.index },
        x: ix + dims.earWidthPx + cell.x + CELL_W / 2,
        y: deviceTop + cell.y + ROW_H / 2,
      });
    }
  }
  return dots;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/portGeometry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && git add src/features/racks/portGeometry.ts src/features/racks/portGeometry.test.ts && git commit -m "feat(patching): portCenters geometry helper for cable anchoring"
```

---

## Task 4: Repository — face snapshot fields + connections repo

**Files:**
- Modify: `src/features/racks/repository.ts`
- Create: `src/features/racks/connectionsRepository.ts`
- Test: `src/features/racks/connectionsRepository.integration.test.ts`

**Interfaces:**
- Consumes: `PortRef`/`Connection` from `./connectionOps`; `SupabaseClient`.
- Produces (in `repository.ts`): `RackDeviceRow` and `RackDeviceInput` gain `front_face: Face | null; back_face: Face | null; height_u: number | null`; `listRackDevices` selects them (already `select("*")`, so only the types change).
- Produces (in `connectionsRepository.ts`):
  - `type ConnectionRow = { id, rack_id, a_rack_device_id, a_side, a_group_id, a_port_index, b_rack_device_id, b_side, b_group_id, b_port_index }`
  - `listConnections(db, rackId): Promise<Connection[]>` (maps rows → `Connection`)
  - `replaceConnections(db, rackId, conns: Connection[]): Promise<void>` (reconcile: delete missing ids, upsert present — mirrors `replaceRackDevices`)

- [ ] **Step 1: Add snapshot fields to the rack-device types**

In `src/features/racks/repository.ts`, add `import type { Face } from "@/domain/faceplate";` at the top, and extend `RackDeviceRow` (after `operation_start`):

```ts
  purchase_date: string | null; operation_start: string | null;
  front_face: Face | null; back_face: Face | null; height_u: number | null;
  created_at: string; updated_at: string;
```

`RackDeviceInput` is `Omit<RackDeviceRow, "rack_id" | "created_at" | "updated_at">`, so it inherits the three new fields automatically. `listRackDevices` uses `select("*")` and needs no query change.

- [ ] **Step 2: Write the failing integration test**

Create `src/features/racks/connectionsRepository.integration.test.ts`. This mirrors the existing `repository.integration.test.ts` setup (service client against local Supabase). Seed a room→rack→two rack_devices, then exercise the connections repo:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { emptyFace } from "@/domain/faceplate";
import { listConnections, replaceConnections } from "./connectionsRepository";
import type { Connection } from "./connectionOps";

const db = createServiceClient();
let rackId = "";
let swId = "";
let ppId = "";
const ids: { room?: string; floor?: string; loc?: string } = {};

beforeAll(async () => {
  // Minimal hierarchy: location → floor → room → rack → 2 devices.
  const loc = (await db.from("locations").insert({ code: "T-CONN", name: "conn test" }).select().single()).data!;
  ids.loc = loc.id;
  const floor = (await db.from("floors").insert({ location_id: loc.id, code: "F", name: "F", level: 0 }).select().single()).data!;
  ids.floor = floor.id;
  const room = (await db.from("rooms").insert({ floor_id: floor.id, code: "R", name: "R" }).select().single()).data!;
  ids.room = room.id;
  const rack = (await db.from("racks").insert({ room_id: room.id, code: "RKX", height_u: 12 }).select().single()).data!;
  rackId = rack.id;
  const tpl = (await db.from("device_templates").insert({
    name: "conn tpl", device_type_id: null, rack_units: 1, width_in: 19, rack_mounted: true,
    front_face: emptyFace(), back_face: emptyFace(),
  }).select().single()).data!;
  const mk = async (code: string) => (await db.from("rack_devices").insert({
    rack_id: rackId, device_template_id: tpl.id, code, start_u: code === "SW01" ? 5 : 3,
    front_face: emptyFace(), back_face: emptyFace(), height_u: 1,
  }).select().single()).data!.id;
  swId = await mk("SW01");
  ppId = await mk("PP01");
});

afterAll(async () => {
  if (ids.loc) await db.from("locations").delete().eq("id", ids.loc); // cascades floors→rooms→racks→devices→connections
});

const conn = (id: string): Connection => ({
  id,
  a: { rackDeviceId: swId, side: "front", groupId: "g-sw", portIndex: 0 },
  b: { rackDeviceId: ppId, side: "front", groupId: "g-pp", portIndex: 0 },
});

describe("connections repository", () => {
  it("replace then list round-trips a connection", async () => {
    await replaceConnections(db, rackId, [conn("11111111-1111-1111-1111-111111111111")]);
    const got = await listConnections(db, rackId);
    expect(got).toHaveLength(1);
    expect(got[0].a.rackDeviceId).toBe(swId);
    expect(got[0].b.portIndex).toBe(0);
  });

  it("replace with [] deletes existing connections", async () => {
    await replaceConnections(db, rackId, []);
    expect(await listConnections(db, rackId)).toHaveLength(0);
  });

  it("cascades when a device is deleted", async () => {
    await replaceConnections(db, rackId, [conn("22222222-2222-2222-2222-222222222222")]);
    await db.from("rack_devices").delete().eq("id", swId);
    expect(await listConnections(db, rackId)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/connectionsRepository.integration.test.ts`
Expected: FAIL — cannot find module `./connectionsRepository`.

- [ ] **Step 4: Write the connections repository**

Create `src/features/racks/connectionsRepository.ts`:

```ts
// Thin Supabase wrappers for patch cables (same reconcile pattern as replaceRackDevices).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Connection } from "./connectionOps";

export interface ConnectionRow {
  id: string; rack_id: string;
  a_rack_device_id: string; a_side: "front" | "back"; a_group_id: string; a_port_index: number;
  b_rack_device_id: string; b_side: "front" | "back"; b_group_id: string; b_port_index: number;
}

const toConnection = (r: ConnectionRow): Connection => ({
  id: r.id,
  a: { rackDeviceId: r.a_rack_device_id, side: r.a_side, groupId: r.a_group_id, portIndex: r.a_port_index },
  b: { rackDeviceId: r.b_rack_device_id, side: r.b_side, groupId: r.b_group_id, portIndex: r.b_port_index },
});

const toRow = (rackId: string, c: Connection): ConnectionRow => ({
  id: c.id, rack_id: rackId,
  a_rack_device_id: c.a.rackDeviceId, a_side: c.a.side, a_group_id: c.a.groupId, a_port_index: c.a.portIndex,
  b_rack_device_id: c.b.rackDeviceId, b_side: c.b.side, b_group_id: c.b.groupId, b_port_index: c.b.portIndex,
});

export async function listConnections(db: SupabaseClient, rackId: string): Promise<Connection[]> {
  const { data, error } = await db.from("connections").select("*").eq("rack_id", rackId);
  if (error) throw new Error(`listConnections: ${error.message}`);
  return (data as ConnectionRow[]).map(toConnection);
}

/** Reconcile the rack's connections to exactly `conns`: delete missing ids, upsert present. */
export async function replaceConnections(
  db: SupabaseClient, rackId: string, conns: Connection[],
): Promise<void> {
  const existing = await listConnections(db, rackId);
  const keep = new Set(conns.map((c) => c.id));
  const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (toDelete.length > 0) {
    const { error } = await db.from("connections").delete().in("id", toDelete);
    if (error) throw new Error(`replaceConnections(delete): ${error.message}`);
  }
  if (conns.length > 0) {
    const payload = conns.map((c) => ({ ...toRow(rackId, c), updated_at: new Date().toISOString() }));
    const { error } = await db.from("connections").upsert(payload, { onConflict: "id" });
    if (error) throw new Error(`replaceConnections(upsert): ${error.message}`);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/connectionsRepository.integration.test.ts`
Expected: PASS. (If Supabase local isn't running: `npx supabase start` first.)

- [ ] **Step 6: Typecheck + commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && npx tsc --noEmit && git add src/features/racks/repository.ts src/features/racks/connectionsRepository.ts src/features/racks/connectionsRepository.integration.test.ts && git commit -m "feat(patching): connections repository + rack_device face snapshot fields"
```

---

## Task 5: Save action with server re-validation

**Files:**
- Modify: `src/features/racks/actions.ts`
- Test: `src/features/racks/actions.integration.test.ts` (create)

**Interfaces:**
- Consumes: `listRackDevices` + `getRack` from `./repository`; `listConnections` + `replaceConnections` from `./connectionsRepository`; `portsOf` + `validatePatch` + `type Connection` from `./connectionOps`; `emptyFace` + `type Face` from `@/domain/faceplate`.
- Produces: `saveConnectionsAction(rackId: string, conns: Connection[]): Promise<{ ok: boolean; error?: string }>` — re-validates every edge against fresh snapshots (both ports exist; no port used twice) before `replaceConnections`.

- [ ] **Step 1: Write the failing test**

Create `src/features/racks/actions.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServiceClient } from "@/lib/supabase/server";
import { emptyFace, type Face, type PortGroup } from "@/domain/faceplate";
import { saveConnectionsAction } from "./actions";
import { listConnections } from "./connectionsRepository";
import type { Connection } from "./connectionOps";

const db = createServiceClient();
let rackId = "", swId = "", ppId = "", locId = "";

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 24, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const faceWith = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });

beforeAll(async () => {
  const loc = (await db.from("locations").insert({ code: "T-ACT", name: "act" }).select().single()).data!;
  locId = loc.id;
  const floor = (await db.from("floors").insert({ location_id: loc.id, code: "F", name: "F", level: 0 }).select().single()).data!;
  const room = (await db.from("rooms").insert({ floor_id: floor.id, code: "R", name: "R" }).select().single()).data!;
  const rack = (await db.from("racks").insert({ room_id: room.id, code: "RKA", height_u: 12 }).select().single()).data!;
  rackId = rack.id;
  const tpl = (await db.from("device_templates").insert({
    name: "t", device_type_id: null, rack_units: 1, width_in: 19, rack_mounted: true,
    front_face: emptyFace(), back_face: emptyFace(),
  }).select().single()).data!;
  swId = (await db.from("rack_devices").insert({ rack_id: rackId, device_template_id: tpl.id, code: "SW01",
    start_u: 5, front_face: faceWith("g-sw"), back_face: emptyFace(), height_u: 1 }).select().single()).data!.id;
  ppId = (await db.from("rack_devices").insert({ rack_id: rackId, device_template_id: tpl.id, code: "PP01",
    start_u: 3, front_face: faceWith("g-pp"), back_face: emptyFace(), height_u: 1 }).select().single()).data!.id;
});
afterAll(async () => { if (locId) await db.from("locations").delete().eq("id", locId); });

const edge = (id: string, aIdx: number, bIdx: number): Connection => ({
  id, a: { rackDeviceId: swId, side: "front", groupId: "g-sw", portIndex: aIdx },
  b: { rackDeviceId: ppId, side: "front", groupId: "g-pp", portIndex: bIdx },
});

describe("saveConnectionsAction", () => {
  it("saves a valid edge", async () => {
    const res = await saveConnectionsAction(rackId, [edge("aaaaaaaa-0000-0000-0000-000000000001", 0, 0)]);
    expect(res.ok).toBe(true);
    expect(await listConnections(rackId ? rackId : "")).toBeDefined();
  });
  it("rejects a port used twice", async () => {
    const res = await saveConnectionsAction(rackId, [
      edge("aaaaaaaa-0000-0000-0000-000000000002", 1, 1),
      edge("aaaaaaaa-0000-0000-0000-000000000003", 1, 2), // reuses sw port 1
    ]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/already connected|used twice/i);
  });
  it("rejects an edge referencing a non-existent port", async () => {
    const res = await saveConnectionsAction(rackId, [edge("aaaaaaaa-0000-0000-0000-000000000004", 99, 0)]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no longer exists|does not exist/i);
  });
});
```

Note: the `listConnections` import in the test needs the db client; adjust the first test's assertion to `await listConnections(db, rackId)` and expect length 1. (Kept minimal here — the round-trip is already covered in Task 4; the point of this test is the validation branches.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/actions.integration.test.ts`
Expected: FAIL — `saveConnectionsAction` is not exported.

- [ ] **Step 3: Implement the action**

In `src/features/racks/actions.ts`, add imports and the action:

```ts
import { listConnections, replaceConnections } from "./connectionsRepository";
import { portsOf, validatePatch, type Connection, type PortRef } from "./connectionOps";
import { emptyFace, type Face } from "@/domain/faceplate";
```

```ts
/** Reconcile the rack's patch cables. Re-validates every edge against FRESH device snapshots so a
 *  stale client can't create a cable on a vanished port or double-book a port. */
export async function saveConnectionsAction(
  rackId: string, conns: Connection[],
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    const devices = await listRackDevices(db, rackId);
    // Build the valid-port index per device from the snapshot faces (fallback to empty).
    const portsByDevice: Record<string, PortRef[]> = {};
    for (const d of devices) {
      const front = (d.front_face as Face | null) ?? emptyFace();
      const back = (d.back_face as Face | null) ?? emptyFace();
      portsByDevice[d.id] = [...portsOf(front, d.id, "front"), ...portsOf(back, d.id, "back")];
    }
    // Re-validate edges cumulatively so a port used twice in the same batch is caught.
    const accepted: Connection[] = [];
    for (const c of conns) {
      const err = validatePatch(accepted, portsByDevice, c.a, c.b);
      if (err) return { ok: false, error: err };
      accepted.push(c);
    }
    await replaceConnections(db, rackId, accepted);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath(`/racks/${rackId}`);
  return { ok: true };
}
```

Also snapshot faces on insert: in `saveRackLayoutAction`, the client now sends `front_face`/`back_face`/`height_u` on each `RackDeviceInput` (Task 6 wires this), so `replaceRackDevices` already persists them — no change needed here beyond confirming the payload passes through. (`replaceRackDevices` spreads the whole row, so the new columns are written as-is.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/actions.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && npx tsc --noEmit && git add src/features/racks/actions.ts src/features/racks/actions.integration.test.ts && git commit -m "feat(patching): saveConnectionsAction with server-side re-validation"
```

---

## Task 6: Load + render from the snapshot; thread faces & connections into RackBuilder

**Files:**
- Modify: `src/app/racks/[id]/page.tsx`
- Modify: `src/features/racks/RackBuilder.tsx`

**Interfaces:**
- Consumes: `listConnections` from `./connectionsRepository`; `Connection` from `./connectionOps`; `RackDeviceRow` snapshot fields from Task 4.
- Produces: `RackBuilder` receives `initialConnections: Connection[]`; `PlacementDraft` carries `frontFace`/`backFace`; `canvasPlacements` renders from the snapshot faces; new placements snapshot the picked template's faces.

- [ ] **Step 1: Load connections in the page and pass them down**

In `src/app/racks/[id]/page.tsx`:

```ts
import { getRack, listRackDevices } from "@/features/racks/repository";
import { listConnections } from "@/features/racks/connectionsRepository";
```
Extend the `Promise.all` and the render:
```ts
  const [rack, devices, types, connections] = await Promise.all([
    getRack(db, id), listRackDevices(db, id), listDeviceTypes(db), listConnections(db, id),
  ]);
  ...
  return <RackBuilder rack={rack} initialDevices={devices} initialConnections={connections}
    types={rackTypes} templatesByType={templatesByType} />;
```

- [ ] **Step 2: Carry snapshot faces in `PlacementDraft`**

In `src/features/racks/RackDeviceSettings.tsx`, add `frontFace: Face` and `backFace: Face` to the `PlacementDraft` interface (import `type { Face } from "@/domain/faceplate"`). These fields are data-only (the settings form ignores them).

In `RackBuilder.tsx` `fromRow`, populate them (fall back to `emptyFace()` for legacy null rows):
```ts
import { emptyFace, type Face } from "@/domain/faceplate";
// in fromRow(r):
  frontFace: (r.front_face as Face | null) ?? emptyFace(),
  backFace: (r.back_face as Face | null) ?? emptyFace(),
```
In `toInput`:
```ts
  front_face: d.frontFace, back_face: d.backFace, height_u: null,
```

- [ ] **Step 3: Snapshot the picked template's faces on insert**

In `RackBuilder.tsx` `insertTemplate`, add to the `draft` object:
```ts
  frontFace: t.frontFace, backFace: t.backFace,
```
(`PickerTemplate` already carries `frontFace`/`backFace` — see `device-library/repository.ts`.)

- [ ] **Step 4: Render placements from the snapshot faces**

In `RackBuilder.tsx`, change `canvasPlacements` to build the render template from the placement's snapshot faces (dimensions still come from the template, which FK-restrict keeps available):
```ts
  const canvasPlacements = placements
    .filter((p) => templatesById[p.deviceTemplateId])
    .map((p) => ({
      id: p.id, startU: p.startU, code: p.code,
      template: {
        rackUnits: templatesById[p.deviceTemplateId].rackUnits,
        widthIn: templatesById[p.deviceTemplateId].widthIn,
        rackMounted: templatesById[p.deviceTemplateId].rackMounted,
        frontFace: p.frontFace, backFace: p.backFace,
      },
    }));
```

- [ ] **Step 5: Typecheck + verify existing tests still pass**

Run:
```bash
cd /Users/reubensingh/development/network-doc-platform && npx tsc --noEmit && npx vitest run src/features/racks/RackDeviceSettings.test.tsx src/features/racks/AddDevicePicker.test.tsx
```
Expected: tsc clean; those suites PASS (update any `PlacementDraft` literals in the tests to include `frontFace: emptyFace(), backFace: emptyFace()` if the compiler flags them).

- [ ] **Step 6: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && git add src/app/racks/[id]/page.tsx src/features/racks/RackBuilder.tsx src/features/racks/RackDeviceSettings.tsx && git commit -m "feat(patching): render placed devices from their face snapshot; load connections"
```

---

## Task 7: Unified undo/redo state + dual autosave

**Files:**
- Modify: `src/features/racks/RackBuilder.tsx`

**Interfaces:**
- Consumes: `saveConnectionsAction` from `./actions`; `Connection` from `./connectionOps`; existing `History`/`push`/`undo`/`redo`.
- Produces: builder history holds `RackState = { placements: PlacementDraft[]; connections: Connection[] }`; `commitState(next)` pushes + dual-saves; `connections` available to the canvas.

- [ ] **Step 1: Generalize the history state**

In `RackBuilder.tsx`, replace the placement-only history with a combined state:
```ts
type RackState = { placements: PlacementDraft[]; connections: Connection[] };
// ...
const [hist, setHist] = useState<History<RackState>>(() =>
  createHistory({ placements: initialDevices.map(fromRow), connections: initialConnections }));
const { placements, connections } = hist.present;
```
Everywhere the code previously built the next placement list and called `commit(next)`, wrap it as state. Add a single committer and a connections committer:
```ts
function commitState(next: RackState) {
  if (next.placements === placements && next.connections === connections) return;
  setHist((h) => push(h, next));
  queueSave(next);
}
// keep the placement-only helper for the many existing call sites:
function commit(nextPlacements: PlacementDraft[]) {
  if (nextPlacements === placements) return;
  commitState({ placements: nextPlacements, connections });
}
function commitConnections(nextConns: Connection[]) {
  if (nextConns === connections) return;
  commitState({ placements, connections: nextConns });
}
```

- [ ] **Step 2: Dual autosave**

Replace `queueSave` so it persists both lists (both reconciles are idempotent, so saving the unchanged one is a cheap no-op):
```ts
function queueSave(next: RackState) {
  setSaveState("saving"); setError(null);
  if (saveTimer.current) clearTimeout(saveTimer.current);
  saveTimer.current = setTimeout(async () => {
    const [layout, conns] = await Promise.all([
      saveRackLayoutAction(rack.id, next.placements.map(toInput)),
      saveConnectionsAction(rack.id, next.connections),
    ]);
    const bad = !layout.ok ? layout : !conns.ok ? conns : null;
    if (bad) { setSaveState("error"); setError(bad.error ?? "Save failed"); return; }
    setSaveState("saved");
  }, 600);
}
```
Update `doUndo`/`doRedo` to call `queueSave(n.present)` (now a `RackState`) — the signature already matches. Update `changeHeight`'s save (it calls `updateRackAction`, unchanged) — leave as is.

- [ ] **Step 3: Fix the `commit` call sites**

The existing `onMove`, `onDelete`, `insertTemplate`, and `RackDeviceSettings.onChange` all call `commit(<placements>)` — they keep working unchanged because `commit` now forwards to `commitState` preserving `connections`. When a device is deleted, also drop its connections so undo history and the DB stay consistent:
```ts
// onDelete (canvas) and the sidebar delete:
onDelete={(id) => {
  commitState({
    placements: placements.filter((p) => p.id !== id),
    connections: connections.filter((c) => c.a.rackDeviceId !== id && c.b.rackDeviceId !== id),
  });
  setSelectedId(null);
}}
```

- [ ] **Step 4: Typecheck + run the builder tests**

Run:
```bash
cd /Users/reubensingh/development/network-doc-platform && npx tsc --noEmit && npx vitest run src/features/racks/RacksTable.test.tsx src/features/racks/RackDeviceSettings.test.tsx
```
Expected: tsc clean; suites PASS. (No new test here — behaviour is covered by Task 8's component test, which drives patch → undo.)

- [ ] **Step 5: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && git add src/features/racks/RackBuilder.tsx && git commit -m "feat(patching): unified undo/redo state + dual autosave for connections"
```

---

## Task 8: PatchLayer overlay — ports, cables, drag-to-patch

**Files:**
- Create: `src/features/racks/PatchLayer.tsx`
- Modify: `src/features/racks/RackCanvas.tsx`
- Modify: `src/features/racks/RackBuilder.tsx`
- Test: `src/features/racks/PatchLayer.test.tsx`

**Interfaces:**
- Consumes: `PortDot` + `portCenters` from `./portGeometry`; `Connection` + `PortRef` + `samePort` from `./connectionOps`; `RackPlacementRender` from `./RackFrame`.
- Produces: `<PatchLayer placements heightU side connections selectedConnectionId onPatch onSelectConnection />`, an SVG `<g>` rendered inside the `RackCanvas` `<svg>` after `<RackFrame>`. Cables are `<path>`s routed around the left edge; each port is an invisible hit-dot; a drag from one port to another calls `onPatch(a, b)`.

- [ ] **Step 1: Write the failing component test**

Create `src/features/racks/PatchLayer.test.tsx`. It renders `RackCanvas` with two 24-port devices and drives a synthetic pointer drag between two ports (drag-only, per spec — synthetic `PointerEvent`s like the editor resize test):

```tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { RackCanvas } from "./RackCanvas";
import type { RackPlacementRender } from "./RackFrame";
import type { Face, PortGroup } from "@/domain/faceplate";

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 24, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const face = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });
const dev = (id: string, startU: number, gid: string): RackPlacementRender => ({
  id, startU, code: id,
  template: { rackUnits: 1, widthIn: 19, rackMounted: true, frontFace: face(gid), backFace: face(gid + "-b") },
});

function setup(onPatch = vi.fn()) {
  const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
  const utils = render(
    <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
      onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
      connections={[]} selectedConnectionId={null}
      onPatch={onPatch} onSelectConnection={() => {}} />,
  );
  return { ...utils, onPatch };
}

const pdown = (el: Element) => el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1 }));
const pup = (el: Element) => el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1 }));

describe("PatchLayer drag-to-patch", () => {
  it("dragging sw port 0 onto pp port 0 calls onPatch with both refs", () => {
    const { container, onPatch } = setup();
    const src = container.querySelector('[data-testid="port-dot-sw-front-g-sw-0"]')!;
    const dst = container.querySelector('[data-testid="port-dot-pp-front-g-pp-0"]')!;
    expect(src).toBeTruthy(); expect(dst).toBeTruthy();
    pdown(src);
    pup(dst); // PatchLayer resolves the target via elementFromPoint OR the pointerup target
    expect(onPatch).toHaveBeenCalledTimes(1);
    const [a, b] = onPatch.mock.calls[0];
    expect(a).toEqual({ rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 });
    expect(b).toEqual({ rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 });
  });

  it("renders a cable path for an existing connection", () => {
    const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
    const { container } = render(
      <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
        onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
        connections={[{ id: "c1",
          a: { rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 },
          b: { rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 } }]}
        selectedConnectionId={null} onPatch={() => {}} onSelectConnection={() => {}} />,
    );
    expect(container.querySelector('[data-testid="cable-c1"]')).toBeTruthy();
  });
});
```

For the drag test, resolve the target port on `pointerup` by reading the `data-port` attribute off the event target (each hit-dot carries its serialized `PortRef`), which makes the synthetic drag deterministic without geometry-based hit-testing.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/PatchLayer.test.tsx`
Expected: FAIL — `RackCanvas` doesn't accept `connections`/`onPatch` yet and `PatchLayer` doesn't exist.

- [ ] **Step 3: Write `PatchLayer`**

Create `src/features/racks/PatchLayer.tsx`:

```tsx
"use client";
import { useMemo, useRef, useState } from "react";
import type { RackPlacementRender } from "./RackFrame";
import { RACK_GUTTER_L } from "./RackFrame";
import { portCenters, type PortDot } from "./portGeometry";
import { samePort, type Connection, type PortRef } from "./connectionOps";

const keyOf = (p: PortRef) => `${p.rackDeviceId}-${p.side}-${p.groupId}-${p.portIndex}`;
const parsePort = (s: string): PortRef => {
  const [rackDeviceId, side, groupId, portIndex] = s.split("|");
  return { rackDeviceId, side: side as "front" | "back", groupId, portIndex: Number(portIndex) };
};
const serialize = (p: PortRef) => `${p.rackDeviceId}|${p.side}|${p.groupId}|${p.portIndex}`;

// Orthogonal cable: out of A to a left-margin lane, down/up to B's row, into B.
function cablePath(a: PortDot, b: PortDot, lane: number): string {
  return `M ${a.x} ${a.y} H ${lane} V ${b.y} H ${b.x}`;
}

export function PatchLayer(props: {
  placements: RackPlacementRender[];
  heightU: number;
  side: "FRONT" | "BACK";
  connections: Connection[];
  selectedConnectionId: string | null;
  onPatch: (a: PortRef, b: PortRef) => void;
  onSelectConnection: (id: string | null) => void;
}) {
  const { placements, heightU, side, connections, selectedConnectionId } = props;
  const faceSide = side === "FRONT" ? "front" : "back";

  // All port centres on the current face, keyed for O(1) lookup by PortRef.
  const dots = useMemo(() => {
    const all: PortDot[] = [];
    for (const p of placements) {
      const face = faceSide === "front" ? p.template.frontFace : p.template.backFace;
      all.push(...portCenters({
        rackDeviceId: p.id, side: faceSide, face,
        startU: p.startU, rackUnits: p.template.rackUnits,
        widthIn: p.template.widthIn, rackMounted: p.template.rackMounted, heightU,
      }));
    }
    return all;
  }, [placements, faceSide, heightU]);
  const dotByKey = useMemo(() => new Map(dots.map((d) => [keyOf(d.port), d])), [dots]);

  const lane = RACK_GUTTER_L - 14; // vertical routing lane just left of the mount
  const [drag, setDrag] = useState<{ from: PortRef; x: number; y: number } | null>(null);
  const dragRef = useRef<PortRef | null>(null);

  return (
    <g data-testid="patch-layer">
      {/* existing cables (only those whose both ends are on the current face) */}
      {connections.map((c) => {
        if (c.a.side !== faceSide || c.b.side !== faceSide) return null;
        const a = dotByKey.get(keyOf(c.a)), b = dotByKey.get(keyOf(c.b));
        if (!a || !b) return null;
        const selected = c.id === selectedConnectionId;
        return (
          <path key={c.id} data-testid={`cable-${c.id}`} d={cablePath(a, b, lane)}
            fill="none" stroke={selected ? "#f59e0b" : "#2d5bff"} strokeWidth={selected ? 3 : 2}
            style={{ cursor: "pointer" }}
            onPointerDown={(e) => { e.stopPropagation(); props.onSelectConnection(c.id); }} />
        );
      })}

      {/* rubber-band while dragging */}
      {drag && (() => {
        const from = dotByKey.get(keyOf(drag.from));
        return from ? <line data-testid="patch-rubber" x1={from.x} y1={from.y} x2={drag.x} y2={drag.y}
          stroke="#2d5bff" strokeWidth={2} strokeDasharray="5 4" pointerEvents="none" /> : null;
      })()}

      {/* port hit-dots — invisible, but carry their PortRef for deterministic drag resolution */}
      {dots.map((d) => (
        <circle key={keyOf(d.port)} data-testid={`port-dot-${keyOf(d.port)}`} data-port={serialize(d.port)}
          cx={d.x} cy={d.y} r={9} fill="transparent" style={{ cursor: "crosshair" }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            dragRef.current = d.port;
            setDrag({ from: d.port, x: d.x, y: d.y });
          }}
          onPointerUp={(e) => {
            if (!dragRef.current) return;
            e.stopPropagation();
            const target = (e.currentTarget.getAttribute("data-port"));
            const from = dragRef.current;
            dragRef.current = null;
            setDrag(null);
            if (!target) return;
            const to = parsePort(target);
            if (!samePort(from, to)) props.onPatch(from, to);
          }} />
      ))}
    </g>
  );
}
```

Note: `parsePort` splits on `|` to match `serialize`; the `data-testid` uses `keyOf` (hyphen-joined) purely as a stable selector. The rubber-band follow (updating `drag.x/y` on pointermove) is wired in `RackCanvas` where the pan/pointer handlers live — Step 4.

- [ ] **Step 4: Wire `PatchLayer` into `RackCanvas`**

In `src/features/racks/RackCanvas.tsx`, extend the props with:
```ts
  connections: import("./connectionOps").Connection[];
  selectedConnectionId: string | null;
  onPatch: (a: import("./connectionOps").PortRef, b: import("./connectionOps").PortRef) => void;
  onSelectConnection: (id: string | null) => void;
```
Render `<PatchLayer>` inside the same `<svg>`, immediately after `<RackFrame …/>`:
```tsx
          <RackFrame heightU={heightU} placements={placements} side={side} dragId={dragId} />
          <PatchLayer placements={placements} heightU={heightU} side={side}
            connections={props.connections} selectedConnectionId={props.selectedConnectionId}
            onPatch={props.onPatch} onSelectConnection={props.onSelectConnection} />
```
Add `import { PatchLayer } from "./PatchLayer";`. Clicking empty canvas already calls `onSelect(null)`; also clear the connection selection there: `onClick={() => { props.onSelect(null); props.onSelectConnection(null); }}`.

For the rubber-band to follow the cursor during a drag, the deterministic test doesn't require it, but for real use add a pointermove listener in `PatchLayer` via a `useEffect` that updates `drag` with cursor coords converted through the canvas transform. Since the transform lives in `RackCanvas`, the simplest correct approach for Slice 1 is to keep the rubber-band anchored (no live follow) — acceptable, and avoids threading the transform. (Live-follow is a Slice-3 polish.)

- [ ] **Step 5: Pass connection props from `RackBuilder`**

In `RackBuilder.tsx`, add connection state wiring and pass to `RackCanvas`:
```ts
const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
```
```tsx
          <RackCanvas
            /* …existing props… */
            connections={connections}
            selectedConnectionId={selectedConnectionId}
            onSelectConnection={setSelectedConnectionId}
            onPatch={(a, b) => {
              const portsByDevice = Object.fromEntries(canvasPlacements.map((p) => [p.id,
                [...portsOf(faceSide(p) === "front" ? p.template.frontFace : p.template.backFace, p.id, faceSide(p))]]));
              // faceSide helper: side === "FRONT" ? "front" : "back"
              const err = validatePatch(connections, portsByDevice, a, b);
              if (err) { setError(err); return; }
              commitConnections(addConnection(connections, a, b));
            }}
          />
```
Add imports: `import { validatePatch, addConnection, removeConnection, portsOf, type PortRef } from "./connectionOps";`. Define `const faceSide = (): "front" | "back" => (side === "FRONT" ? "front" : "back");` and use it consistently (both endpoints are on the current face in Slice 1). Simplify the `portsByDevice` build to use the single current `faceSide()`.

- [ ] **Step 6: Run the component test**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/PatchLayer.test.tsx`
Expected: PASS — the drag calls `onPatch`; the cable renders.

- [ ] **Step 7: Typecheck + commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && npx tsc --noEmit && git add src/features/racks/PatchLayer.tsx src/features/racks/RackCanvas.tsx src/features/racks/RackBuilder.tsx src/features/racks/PatchLayer.test.tsx && git commit -m "feat(patching): drag-to-patch overlay with cable rendering"
```

---

## Task 9: Disconnect + connected-port styling + sidebar line

**Files:**
- Modify: `src/features/racks/RackCanvas.tsx`
- Modify: `src/features/racks/RackBuilder.tsx`
- Modify: `src/features/racks/PatchLayer.tsx`
- Test: `src/features/racks/PatchLayer.test.tsx` (extend)

**Interfaces:**
- Consumes: `removeConnection` + `portConnection` from `./connectionOps`.
- Produces: Delete/Backspace removes a selected connection; connected ports render a filled dot; the device sidebar shows a one-line `A ↔ B` with a disconnect button.

- [ ] **Step 1: Extend the test — Delete removes a selected connection**

Add to `PatchLayer.test.tsx`:

```tsx
it("Delete removes the selected connection", () => {
  const onSelectConnection = vi.fn();
  const onDisconnect = vi.fn();
  const placements = [dev("sw", 5, "g-sw"), dev("pp", 3, "g-pp")];
  const conn = { id: "c1",
    a: { rackDeviceId: "sw", side: "front" as const, groupId: "g-sw", portIndex: 0 },
    b: { rackDeviceId: "pp", side: "front" as const, groupId: "g-pp", portIndex: 0 } };
  const { container } = render(
    <RackCanvas heightU={12} placements={placements} side="FRONT" selectedId={null}
      onSelect={() => {}} onAddAt={() => {}} onMove={() => {}} onDelete={() => {}}
      connections={[conn]} selectedConnectionId={"c1"}
      onPatch={() => {}} onSelectConnection={onSelectConnection}
      onDisconnect={onDisconnect} />,
  );
  container.querySelector('[data-testid="cable-c1"]'); // present
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" }));
  expect(onDisconnect).toHaveBeenCalledWith("c1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/PatchLayer.test.tsx`
Expected: FAIL — `onDisconnect` prop doesn't exist / not called.

- [ ] **Step 3: Add `onDisconnect` + Delete handling in `RackCanvas`**

Add `onDisconnect: (id: string) => void;` to `RackCanvas` props. Extend the existing Delete/Backspace effect so a selected connection takes priority over a selected device:
```ts
      if (props.selectedConnectionId) { e.preventDefault(); props.onDisconnect(props.selectedConnectionId); return; }
      if (selectedId) { e.preventDefault(); props.onDelete(selectedId); }
```
Add `props.selectedConnectionId` to that effect's dependency array.

- [ ] **Step 4: Connected-port styling in `PatchLayer`**

Give each port dot a visible fill when connected. Compute a connected-key set and render a small solid dot under the transparent hit-dot:
```tsx
const connectedKeys = useMemo(() => {
  const s = new Set<string>();
  for (const c of connections) { s.add(keyOf(c.a)); s.add(keyOf(c.b)); }
  return s;
}, [connections]);
// inside dots.map, before the hit-dot circle:
{connectedKeys.has(keyOf(d.port)) && (
  <circle cx={d.x} cy={d.y} r={4} fill="#2d5bff" pointerEvents="none" />
)}
```

- [ ] **Step 5: Wire disconnect + sidebar line in `RackBuilder`**

Pass `onDisconnect` to `RackCanvas`:
```tsx
onDisconnect={(id) => { commitConnections(removeConnection(connections, id)); setSelectedConnectionId(null); }}
```
In the sidebar, when a device is selected and one of its ports is connected, show the connection line. Add a minimal block in the `RackDeviceSettings` area (or just above it) listing the selected device's connections:
```tsx
{selected && connections.filter((c) => c.a.rackDeviceId === selected.id || c.b.rackDeviceId === selected.id).map((c) => (
  <div key={c.id} className="mt-2 flex items-center justify-between rounded-md border border-neutral-200 px-2 py-1 text-xs">
    <span>{labelForPort(c.a)} ↔ {labelForPort(c.b)}</span>
    <button type="button" className="text-red-600" onClick={() => {
      commitConnections(removeConnection(connections, c.id)); setSelectedConnectionId(null);
    }}>Disconnect</button>
  </div>
))}
```
where `labelForPort(p)` renders `"<deviceCode>/<number>"` using the placement's `code` and the port's index+1 (a small inline helper; the port *number* refinement can reuse `layoutPortGroup` labels but index+1 is sufficient for Slice 1).

- [ ] **Step 6: Run the test + typecheck**

Run:
```bash
cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/PatchLayer.test.tsx && npx tsc --noEmit
```
Expected: PASS; tsc clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/reubensingh/development/network-doc-platform && git add src/features/racks/RackCanvas.tsx src/features/racks/RackBuilder.tsx src/features/racks/PatchLayer.tsx src/features/racks/PatchLayer.test.tsx && git commit -m "feat(patching): disconnect (Delete + sidebar) and connected-port styling"
```

---

## Task 10: End-to-end verification in the browser

**Files:** none (verification + final checks).

- [ ] **Step 1: Full typecheck + the patching suites**

Run:
```bash
cd /Users/reubensingh/development/network-doc-platform && npx tsc --noEmit && npx vitest run src/features/racks/connectionOps.test.ts src/features/racks/portGeometry.test.ts src/features/racks/PatchLayer.test.tsx src/features/racks/connectionsRepository.integration.test.ts src/features/racks/actions.integration.test.ts
```
Expected: tsc clean; all five suites PASS.

- [ ] **Step 2: Manual browser verification**

Start the preview (dev server "rack-designer-dev", port 3100) via the Browser pane. Seed a rack with a Switch and a Patch Panel (or use an existing one). Then verify, using the browser tools:
- Drag a switch port onto a patch-panel port → a blue cable renders around the left edge; both ports show a filled dot.
- Reload the page → the cable persists (loaded from the DB).
- Click the cable → it turns amber; press Delete → it disappears; reload → still gone.
- Drag a port onto an already-connected port → no new cable (validation blocks it).
- ⌘Z after a patch → the cable is removed; ⌘⇧Z → it returns.
Capture a screenshot of a completed patch to confirm.

- [ ] **Step 3: Final commit (if any verification fixes were needed)**

```bash
cd /Users/reubensingh/development/network-doc-platform && git add -A && git commit -m "test(patching): slice 1 end-to-end verification" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Snapshot columns + connections table → Task 1. ✔
- `connectionOps` (validate/add/remove/query/portState) → Task 2. ✔
- `portCenters` → Task 3. ✔
- Repository + server re-validation → Tasks 4–5. ✔
- Snapshot-on-placement + render-from-snapshot → Task 6. ✔
- Unified undo/redo + autosave → Task 7. ✔
- Drag-to-patch, cable rendering, port states → Task 8. ✔
- Disconnect + selection + sidebar line → Task 9. ✔
- Testing (pure, geometry, repo/action integration, component) → distributed across tasks; consolidated run in Task 10. ✔
- One-per-port + same-rack invariants → enforced in `connectionOps` (Task 2) and re-validated in `saveConnectionsAction` (Task 5). ✔

**Placeholder scan:** No "TBD"/"handle edge cases" — each step carries real code or a concrete command. The two spots that describe behaviour rather than exact code (rubber-band live-follow and the `labelForPort` refinement) are explicitly scoped as optional/simple and given a concrete Slice-1 fallback.

**Type consistency:** `PortRef`/`Connection` are defined once in `connectionOps.ts` and imported everywhere. `portCenters` arg/return (`PortDot`) match between `portGeometry.ts`, `PatchLayer.tsx`, and their tests. `saveConnectionsAction`/`saveRackLayoutAction` share the `{ ok, error }` shape. `RackState = { placements, connections }` is used consistently in `queueSave`/`commitState`/`doUndo`/`doRedo`.
