# Connection Endpoints (Slice 2a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selecting a connection opens an editor in the right panel for the far end of each of its two ports — a described device (camera/AP/ACP/outlet) or a reference to a real switch/rack elsewhere on the site — each drawn faceplate-style and nameable.

**Architecture:** A new `port_endpoints` table keyed by the same `PortRef` identity `connections` uses; an endpoint belongs to a **port**, so it survives re-patching. Three kinds (`described` | `device` | `rack`) as a discriminated union. Pure ops + pure face builder (no React/IO, TDD), a repository + server action that re-validates against fresh snapshots, a presentational sidebar panel, and RackBuilder wiring that folds `endpoints` into the existing unified `RackState` history + autosave. Mirrors Slice 1's split exactly.

**Tech Stack:** Next.js 16 (Turbopack), React 18, TypeScript strict, Supabase (local via Docker), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-14-connection-endpoints-design.md`

## Global Constraints

- **NEVER run vitest against a directory or glob.** Two files wipe the whole local DB —
  `src/features/racks/repository.integration.test.ts:27` and
  `src/features/locations/repository.integration.test.ts:22` both run
  `db.from("sites").delete().neq("id", "000…")`, deleting **all** sites and cascading to every
  floor/room/rack/device/connection. `npx vitest run src/features/racks/` silently includes the first
  one. Run tests **by explicit filename only**, e.g.
  `npx vitest run src/features/racks/endpointOps.test.ts`.
  (`actions.integration.test.ts` and `connectionsRepository.integration.test.ts` are safe: they seed
  their own site and delete only that one with `.eq("id", ids.site)`. The new endpoints integration
  test in Task 10 MUST follow that scoped pattern, never the `.neq` one.)
- Run all commands from the project root: `/Users/reubensingh/development/network-doc-platform`. The Bash cwd resets between calls — `cd` first.
- Typecheck with `./node_modules/.bin/tsc --noEmit` (bare `npx tsc` resolves to the wrong package).
- Branch: `patch-visuals-hover`. Commit after every task.
- An endpoint belongs to a PORT, never to a connection. Disconnecting a cable must not delete endpoints.
- `device`/`rack` endpoints store **no** type or name — both derive from the referenced row.
- The type select excludes the `RK` floor type (uplinks are a real reference). `port_count` is editable for `TO` only; all other described types are single-port.
- Local Supabase has no `psql` binary — use `docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres`.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0007_port_endpoints.sql` (create) | The `port_endpoints` table, constraints, RLS, grants |
| `src/features/racks/endpointOps.ts` (create) | Pure endpoint types + math + validation |
| `src/features/racks/endpointOps.test.ts` (create) | Unit tests for the above |
| `src/features/racks/endpointFaces.ts` (create) | Pure: built-in `Face` for a described endpoint |
| `src/features/racks/endpointFaces.test.ts` (create) | Unit tests for the above |
| `src/features/racks/endpointsRepository.ts` (create) | Supabase list/reconcile for `port_endpoints` |
| `src/features/racks/siteScope.ts` (create) | Site-scoped racks + Switch devices (room→floor→site) |
| `src/features/racks/actions.ts` (modify) | Add `saveEndpointsAction` |
| `src/features/racks/EndpointFaceView.tsx` (create) | Draws one endpoint face per kind |
| `src/features/racks/ConnectionDetails.tsx` (create) | The right-panel editor (presentational) |
| `src/features/racks/ConnectionDetails.test.tsx` (create) | Component tests |
| `src/features/racks/RackBuilder.tsx` (modify) | `endpoints` in `RackState`, 3rd autosave, render the panel |
| `src/app/racks/[id]/page.tsx` (modify) | Load endpoints + site scope |
| `src/features/racks/endpoints.integration.test.ts` (create) | DB-backed action tests |

---

### Task 1: Migration — `port_endpoints` table

**Files:**
- Create: `supabase/migrations/0007_port_endpoints.sql`

**Interfaces:**
- Consumes: existing `racks`, `rack_devices`, `device_types` tables.
- Produces: table `port_endpoints` with columns `id, rack_id, rack_device_id, side, group_id, port_index, kind, device_type_id, name, port_count, landing_port_index, landing_port_label, target_rack_device_id, target_rack_id, created_at, updated_at`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0007_port_endpoints.sql`:

```sql
-- supabase/migrations/0007_port_endpoints.sql
-- Slice 2a: the far end of a run leaving a rack port. An endpoint belongs to a PORT (not to a
-- patch cable), so it survives unplugging/re-patching.

create table port_endpoints (
  id                 uuid primary key default gen_random_uuid(),
  rack_id            uuid not null references racks(id) on delete cascade,
  -- the rack port this endpoint hangs off (same identity `connections` uses)
  rack_device_id     uuid not null references rack_devices(id) on delete cascade,
  side               text not null check (side in ('front','back')),
  group_id           uuid not null,
  port_index         int  not null check (port_index >= 0),

  kind               text not null check (kind in ('described','device','rack')),

  -- kind='described'
  device_type_id     uuid references device_types(id) on delete restrict,
  name               text not null default '',
  port_count         int  not null default 1 check (port_count in (1,2,3,4,6)),
  landing_port_index int  not null default 0 check (landing_port_index >= 0),
  landing_port_label text not null default '',

  -- kind='device' / kind='rack'
  target_rack_device_id uuid references rack_devices(id) on delete cascade,
  target_rack_id        uuid references racks(id)        on delete cascade,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint port_endpoints_port_uniq unique (rack_device_id, side, group_id, port_index),
  constraint port_endpoints_landing_ck check (landing_port_index < port_count),
  constraint port_endpoints_kind_ck check (
    (kind='described' and device_type_id is not null and target_rack_device_id is null and target_rack_id is null)
 or (kind='device'    and target_rack_device_id is not null and device_type_id is null and target_rack_id is null)
 or (kind='rack'      and target_rack_id is not null and device_type_id is null and target_rack_device_id is null)
  )
);

alter table port_endpoints enable row level security;
create policy "single_org_all" on port_endpoints for all using (true) with check (true);

grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

- [ ] **Step 2: Apply it**

```bash
cd /Users/reubensingh/development/network-doc-platform
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0007_port_endpoints.sql
```

Expected: `CREATE TABLE`, `ALTER TABLE`, `CREATE POLICY`, two `GRANT`.

- [ ] **Step 3: Verify the constraints actually bite**

```bash
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "
  insert into port_endpoints (rack_id, rack_device_id, side, group_id, port_index, kind, target_rack_id)
  values (gen_random_uuid(), gen_random_uuid(), 'front', gen_random_uuid(), 0, 'described', gen_random_uuid());"
```

Expected: FAIL — `new row for relation "port_endpoints" violates check constraint "port_endpoints_kind_ck"` (a `described` row must carry `device_type_id`, not `target_rack_id`). This proves the kind CHECK works. (The FK on `rack_id` would also reject it; the CHECK is evaluated first.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0007_port_endpoints.sql
git commit -m "feat(endpoints): add port_endpoints table"
```

---

### Task 2: Pure `endpointOps.ts`

**Files:**
- Create: `src/features/racks/endpointOps.ts`
- Test: `src/features/racks/endpointOps.test.ts`

**Interfaces:**
- Consumes: `PortRef`, `samePort` from `./connectionOps`.
- Produces:
  ```ts
  type OutletPortCount = 1 | 2 | 3 | 4 | 6
  const OUTLET_PORT_COUNTS: OutletPortCount[]
  type PortEndpoint =
    | { id: string; port: PortRef; kind: "described"; deviceTypeId: string; name: string;
        portCount: OutletPortCount; landingPortIndex: number; landingPortLabel: string }
    | { id: string; port: PortRef; kind: "device"; targetRackDeviceId: string }
    | { id: string; port: PortRef; kind: "rack"; targetRackId: string }
  interface EndpointContext { floorTypeIds: Set<string>; portsByDevice: Record<string, PortRef[]>;
    thisRackId: string; siteRackIds: Set<string>; siteSwitchDeviceIds: Set<string> }
  endpointForPort(eps, p): PortEndpoint | null
  upsertEndpoint(eps, ep): PortEndpoint[]
  removeEndpoint(eps, id): PortEndpoint[]
  validateEndpoint(ep, ctx): string | null
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/features/racks/endpointOps.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  endpointForPort, upsertEndpoint, removeEndpoint, validateEndpoint,
  type PortEndpoint, type EndpointContext,
} from "./endpointOps";
import type { PortRef } from "./connectionOps";

const p = (i: number): PortRef => ({ rackDeviceId: "pp", side: "front", groupId: "g", portIndex: i });
const described = (id: string, port: PortRef, over: Partial<Extract<PortEndpoint, { kind: "described" }>> = {}): PortEndpoint => ({
  id, port, kind: "described", deviceTypeId: "cam", name: "CAM01",
  portCount: 1, landingPortIndex: 0, landingPortLabel: "", ...over,
});

const ctx: EndpointContext = {
  floorTypeIds: new Set(["cam", "to"]),
  portsByDevice: { pp: [p(0), p(1), p(2)] },
  thisRackId: "rack-1",
  siteRackIds: new Set(["rack-2"]),          // OTHER racks on this site
  siteSwitchDeviceIds: new Set(["sw-in-rack-2"]),
};

describe("endpointOps", () => {
  it("finds an endpoint by its port", () => {
    const eps = [described("e1", p(0)), described("e2", p(1))];
    expect(endpointForPort(eps, p(1))?.id).toBe("e2");
    expect(endpointForPort(eps, p(2))).toBeNull();
  });

  it("upsert replaces the endpoint on a port rather than duplicating it", () => {
    const eps = upsertEndpoint([described("e1", p(0))], described("e2", p(0), { name: "CAM02" }));
    expect(eps).toHaveLength(1);
    expect(eps[0].id).toBe("e2");
  });

  it("upsert appends when the port has no endpoint yet", () => {
    expect(upsertEndpoint([described("e1", p(0))], described("e2", p(1)))).toHaveLength(2);
  });

  it("removes by id", () => {
    expect(removeEndpoint([described("e1", p(0)), described("e2", p(1))], "e1").map((e) => e.id)).toEqual(["e2"]);
  });

  it("rejects an endpoint on a port that does not exist", () => {
    expect(validateEndpoint(described("e", p(9)), ctx)).toBe("That port no longer exists");
  });

  it("rejects a described endpoint whose type is not a floor type", () => {
    expect(validateEndpoint(described("e", p(0), { deviceTypeId: "rack-switch" }), ctx))
      .toBe("That endpoint type is not a floor device type");
  });

  it("rejects a landing port off the faceplate", () => {
    expect(validateEndpoint(described("e", p(0), { deviceTypeId: "to", portCount: 4, landingPortIndex: 4 }), ctx))
      .toBe("That port is not on the faceplate");
  });

  it("accepts a valid described endpoint", () => {
    expect(validateEndpoint(described("e", p(0), { deviceTypeId: "to", portCount: 4, landingPortIndex: 3 }), ctx)).toBeNull();
  });

  it("rejects a device endpoint that is not a switch on this site", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "device", targetRackDeviceId: "sw-elsewhere" };
    expect(validateEndpoint(ep, ctx)).toBe("Pick a switch in another rack on this site");
  });

  it("accepts a device endpoint targeting a site switch", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "device", targetRackDeviceId: "sw-in-rack-2" };
    expect(validateEndpoint(ep, ctx)).toBeNull();
  });

  it("rejects a rack uplink to this same rack", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "rack", targetRackId: "rack-1" };
    expect(validateEndpoint(ep, ctx)).toBe("An uplink must target a different rack");
  });

  it("rejects a rack uplink off this site", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "rack", targetRackId: "rack-99" };
    expect(validateEndpoint(ep, ctx)).toBe("Pick a rack on this site");
  });

  it("accepts a rack uplink to another rack on this site", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "rack", targetRackId: "rack-2" };
    expect(validateEndpoint(ep, ctx)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx vitest run src/features/racks/endpointOps.test.ts`
Expected: FAIL — `Failed to resolve import "./endpointOps"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/racks/endpointOps.ts`:

```ts
// Pure far-end math for rack ports. No React, no I/O (mirrors connectionOps.ts).
// An endpoint belongs to a PORT, so it survives unplugging/re-patching the cable.
import { samePort, type PortRef } from "./connectionOps";

export type OutletPortCount = 1 | 2 | 3 | 4 | 6;
export const OUTLET_PORT_COUNTS: OutletPortCount[] = [1, 2, 3, 4, 6];

export type PortEndpoint =
  | { id: string; port: PortRef; kind: "described"; deviceTypeId: string; name: string;
      portCount: OutletPortCount; landingPortIndex: number; landingPortLabel: string }
  | { id: string; port: PortRef; kind: "device"; targetRackDeviceId: string }
  | { id: string; port: PortRef; kind: "rack"; targetRackId: string };

/** Everything validation needs, with no I/O — the action builds this from fresh rows. */
export interface EndpointContext {
  floorTypeIds: Set<string>;                 // device_types with category='floor'
  portsByDevice: Record<string, PortRef[]>;  // valid ports per device in THIS rack (from snapshots)
  thisRackId: string;
  siteRackIds: Set<string>;                  // OTHER racks on this site
  siteSwitchDeviceIds: Set<string>;          // Switch-type devices in those other racks
}

export function endpointForPort(eps: PortEndpoint[], p: PortRef): PortEndpoint | null {
  return eps.find((e) => samePort(e.port, p)) ?? null;
}

/** One endpoint per port: replace the port's endpoint if it has one, else append. */
export function upsertEndpoint(eps: PortEndpoint[], ep: PortEndpoint): PortEndpoint[] {
  const i = eps.findIndex((e) => samePort(e.port, ep.port));
  if (i === -1) return [...eps, ep];
  const next = [...eps];
  next[i] = ep;
  return next;
}

export function removeEndpoint(eps: PortEndpoint[], id: string): PortEndpoint[] {
  return eps.filter((e) => e.id !== id);
}

/** null = OK to save; otherwise a human-readable reason. */
export function validateEndpoint(ep: PortEndpoint, ctx: EndpointContext): string | null {
  const ports = ctx.portsByDevice[ep.port.rackDeviceId] ?? [];
  if (!ports.some((q) => samePort(q, ep.port))) return "That port no longer exists";

  if (ep.kind === "described") {
    if (!ctx.floorTypeIds.has(ep.deviceTypeId)) return "That endpoint type is not a floor device type";
    if (!OUTLET_PORT_COUNTS.includes(ep.portCount)) return "An outlet must have 1, 2, 3, 4 or 6 ports";
    if (ep.landingPortIndex < 0 || ep.landingPortIndex >= ep.portCount) return "That port is not on the faceplate";
    return null;
  }
  if (ep.kind === "device") {
    // siteSwitchDeviceIds already excludes this rack, so "another rack" holds by construction.
    if (!ctx.siteSwitchDeviceIds.has(ep.targetRackDeviceId)) return "Pick a switch in another rack on this site";
    return null;
  }
  if (ep.targetRackId === ctx.thisRackId) return "An uplink must target a different rack";
  if (!ctx.siteRackIds.has(ep.targetRackId)) return "Pick a rack on this site";
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/features/racks/endpointOps.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/racks/endpointOps.ts src/features/racks/endpointOps.test.ts
git commit -m "feat(endpoints): pure endpointOps with validation"
```

---

### Task 3: Pure `endpointFaces.ts`

**Files:**
- Create: `src/features/racks/endpointFaces.ts`
- Test: `src/features/racks/endpointFaces.test.ts`

**Interfaces:**
- Consumes: `Face`, `PortGroup` from `@/domain/faceplate`.
- Produces:
  ```ts
  const OUTLET_TYPE_CODE = "TO"
  const ENDPOINT_GROUP_ID = "endpoint-face"
  faceForDescribed(args: { typeCode: string; portCount: number;
                           landingPortIndex: number; landingPortLabel: string }): Face
  ```

> Note: this refines the spec's shorthand `faceForDescribed(typeCode, portCount)` to a single args object so the landing port's label rides along — the face is what carries it into `renderFace`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/racks/endpointFaces.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { faceForDescribed, ENDPOINT_GROUP_ID } from "./endpointFaces";

describe("endpointFaces", () => {
  it("gives a single-port face to a non-outlet type regardless of portCount", () => {
    const f = faceForDescribed({ typeCode: "CAM", portCount: 4, landingPortIndex: 0, landingPortLabel: "" });
    expect(f.portGroups).toHaveLength(1);
    expect(f.portGroups[0].cols).toBe(1);
    expect(f.portGroups[0].rows).toBe(1);
  });

  it("gives an outlet the port count it was asked for", () => {
    for (const n of [1, 2, 3, 4, 6]) {
      const f = faceForDescribed({ typeCode: "TO", portCount: n, landingPortIndex: 0, landingPortLabel: "" });
      expect(f.portGroups[0].cols).toBe(n);
    }
  });

  it("labels the landing port with the endpoint label", () => {
    const f = faceForDescribed({ typeCode: "TO", portCount: 4, landingPortIndex: 2, landingPortLabel: "Desk A" });
    expect(f.portGroups[0].portOverrides[2]).toEqual({ name: "Desk A" });
  });

  it("leaves ports unlabelled when no endpoint label is set", () => {
    const f = faceForDescribed({ typeCode: "TO", portCount: 4, landingPortIndex: 2, landingPortLabel: "" });
    expect(f.portGroups[0].portOverrides).toEqual({});
  });

  it("uses a stable group id so highlights can target it", () => {
    const f = faceForDescribed({ typeCode: "CAM", portCount: 1, landingPortIndex: 0, landingPortLabel: "" });
    expect(f.portGroups[0].id).toBe(ENDPOINT_GROUP_ID);
  });

  it("has no free-floating elements", () => {
    expect(faceForDescribed({ typeCode: "CAM", portCount: 1, landingPortIndex: 0, landingPortLabel: "" }).elements).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/racks/endpointFaces.test.ts`
Expected: FAIL — `Failed to resolve import "./endpointFaces"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/racks/endpointFaces.ts`:

```ts
// Built-in faces for DESCRIBED endpoints. Pure: returns a real Face, so the existing renderFace
// draws a far end exactly like any other device face — no second renderer.
import type { Face, PortGroup } from "@/domain/faceplate";

/** Telecommunications Outlet — the only described type with a user-chosen port count. */
export const OUTLET_TYPE_CODE = "TO";
/** Stable group id: the face is transient (never persisted) and highlights target this id. */
export const ENDPOINT_GROUP_ID = "endpoint-face";

/** One row of RJ45 keystones: `portCount` wide for an outlet, otherwise a single port. */
export function faceForDescribed(args: {
  typeCode: string; portCount: number; landingPortIndex: number; landingPortLabel: string;
}): Face {
  const cols = args.typeCode === OUTLET_TYPE_CODE ? args.portCount : 1;
  const portOverrides: PortGroup["portOverrides"] = {};
  if (args.landingPortLabel !== "") portOverrides[args.landingPortIndex] = { name: args.landingPortLabel };
  const group: PortGroup = {
    id: ENDPOINT_GROUP_ID, media: "copper", connectorType: "Keystone", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides,
  };
  return { portGroups: [group], elements: [] };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/features/racks/endpointFaces.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/racks/endpointFaces.ts src/features/racks/endpointFaces.test.ts
git commit -m "feat(endpoints): built-in faces for described endpoints"
```

---

### Task 4: `endpointsRepository.ts`

**Files:**
- Create: `src/features/racks/endpointsRepository.ts`

**Interfaces:**
- Consumes: `PortEndpoint`, `OutletPortCount` from `./endpointOps`.
- Produces:
  ```ts
  interface PortEndpointRow { id; rack_id; rack_device_id; side; group_id; port_index; kind;
    device_type_id; name; port_count; landing_port_index; landing_port_label;
    target_rack_device_id; target_rack_id }
  listPortEndpoints(db: SupabaseClient, rackId: string): Promise<PortEndpoint[]>
  replacePortEndpoints(db: SupabaseClient, rackId: string, eps: PortEndpoint[]): Promise<void>
  ```

This mirrors `connectionsRepository.ts` exactly; it is exercised by Task 10's integration test (a unit test here would only assert a Supabase mock).

- [ ] **Step 1: Write the implementation**

Create `src/features/racks/endpointsRepository.ts`:

```ts
// Thin Supabase wrappers for port endpoints (same reconcile pattern as replaceConnections).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PortEndpoint, OutletPortCount } from "./endpointOps";

export interface PortEndpointRow {
  id: string; rack_id: string;
  rack_device_id: string; side: "front" | "back"; group_id: string; port_index: number;
  kind: "described" | "device" | "rack";
  device_type_id: string | null; name: string; port_count: number;
  landing_port_index: number; landing_port_label: string;
  target_rack_device_id: string | null; target_rack_id: string | null;
}

const toEndpoint = (r: PortEndpointRow): PortEndpoint => {
  const port = { rackDeviceId: r.rack_device_id, side: r.side, groupId: r.group_id, portIndex: r.port_index };
  if (r.kind === "device") return { id: r.id, port, kind: "device", targetRackDeviceId: r.target_rack_device_id! };
  if (r.kind === "rack") return { id: r.id, port, kind: "rack", targetRackId: r.target_rack_id! };
  return {
    id: r.id, port, kind: "described", deviceTypeId: r.device_type_id!, name: r.name,
    portCount: r.port_count as OutletPortCount,
    landingPortIndex: r.landing_port_index, landingPortLabel: r.landing_port_label,
  };
};

/** Unused columns are written as their DB defaults so the kind CHECK constraint holds. */
const toRow = (rackId: string, e: PortEndpoint): PortEndpointRow => ({
  id: e.id, rack_id: rackId,
  rack_device_id: e.port.rackDeviceId, side: e.port.side, group_id: e.port.groupId, port_index: e.port.portIndex,
  kind: e.kind,
  device_type_id: e.kind === "described" ? e.deviceTypeId : null,
  name: e.kind === "described" ? e.name : "",
  port_count: e.kind === "described" ? e.portCount : 1,
  landing_port_index: e.kind === "described" ? e.landingPortIndex : 0,
  landing_port_label: e.kind === "described" ? e.landingPortLabel : "",
  target_rack_device_id: e.kind === "device" ? e.targetRackDeviceId : null,
  target_rack_id: e.kind === "rack" ? e.targetRackId : null,
});

export async function listPortEndpoints(db: SupabaseClient, rackId: string): Promise<PortEndpoint[]> {
  const { data, error } = await db.from("port_endpoints").select("*").eq("rack_id", rackId);
  if (error) throw new Error(`listPortEndpoints: ${error.message}`);
  return (data as PortEndpointRow[]).map(toEndpoint);
}

/** Reconcile the rack's endpoints to exactly `eps`: delete missing ids, upsert present. */
export async function replacePortEndpoints(
  db: SupabaseClient, rackId: string, eps: PortEndpoint[],
): Promise<void> {
  const existing = await listPortEndpoints(db, rackId);
  const keep = new Set(eps.map((e) => e.id));
  const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (toDelete.length > 0) {
    const { error } = await db.from("port_endpoints").delete().in("id", toDelete);
    if (error) throw new Error(`replacePortEndpoints(delete): ${error.message}`);
  }
  if (eps.length > 0) {
    const payload = eps.map((e) => ({ ...toRow(rackId, e), updated_at: new Date().toISOString() }));
    const { error } = await db.from("port_endpoints").upsert(payload, { onConflict: "id" });
    if (error) throw new Error(`replacePortEndpoints(upsert): ${error.message}`);
  }
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/racks/endpointsRepository.ts
git commit -m "feat(endpoints): port_endpoints repository"
```

---

### Task 5: `siteScope.ts` — racks + switches on this site

**Files:**
- Create: `src/features/racks/siteScope.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  interface SiteRackTarget { id: string; code: string }
  interface SiteSwitchTarget { id: string; code: string; rackId: string; rackCode: string;
                               frontFace: Face | null; heightU: number | null }
  interface SiteScope { racks: SiteRackTarget[]; switches: SiteSwitchTarget[] }
  listSiteScope(db: SupabaseClient, rackId: string): Promise<SiteScope>
  ```

`racks` and `switches` **exclude this rack**, so "another rack" holds by construction. Switch faces ride along so `ConnectionDetails` can draw a `device` endpoint's real faceplate without another round trip.

- [ ] **Step 1: Write the implementation**

Create `src/features/racks/siteScope.ts`:

```ts
// The other racks on this rack's site, and the Switch-type devices inside them. Walks
// rack -> room -> floor -> site with plain queries (one round trip per hop is fine at this scale,
// matching the rack page's existing per-type template fan-out).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Face } from "@/domain/faceplate";

export interface SiteRackTarget { id: string; code: string }
export interface SiteSwitchTarget {
  id: string; code: string; rackId: string; rackCode: string;
  frontFace: Face | null; heightU: number | null;
}
export interface SiteScope { racks: SiteRackTarget[]; switches: SiteSwitchTarget[] }

const EMPTY: SiteScope = { racks: [], switches: [] };

export async function listSiteScope(db: SupabaseClient, rackId: string): Promise<SiteScope> {
  const { data: rack, error: e1 } = await db.from("racks").select("id, room_id").eq("id", rackId).single();
  if (e1) throw new Error(`listSiteScope(rack): ${e1.message}`);
  const { data: room, error: e2 } = await db.from("rooms").select("id, floor_id").eq("id", rack.room_id).single();
  if (e2) throw new Error(`listSiteScope(room): ${e2.message}`);
  const { data: floor, error: e3 } = await db.from("floors").select("id, site_id").eq("id", room.floor_id).single();
  if (e3) throw new Error(`listSiteScope(floor): ${e3.message}`);

  // site -> floors -> rooms -> racks
  const { data: floors, error: e4 } = await db.from("floors").select("id").eq("site_id", floor.site_id);
  if (e4) throw new Error(`listSiteScope(floors): ${e4.message}`);
  if (floors.length === 0) return EMPTY;
  const { data: rooms, error: e5 } = await db.from("rooms").select("id").in("floor_id", floors.map((f) => f.id));
  if (e5) throw new Error(`listSiteScope(rooms): ${e5.message}`);
  if (rooms.length === 0) return EMPTY;
  const { data: racks, error: e6 } = await db.from("racks").select("id, code").in("room_id", rooms.map((r) => r.id));
  if (e6) throw new Error(`listSiteScope(racks): ${e6.message}`);

  const others: SiteRackTarget[] = racks.filter((r) => r.id !== rackId).map((r) => ({ id: r.id, code: r.code }));
  if (others.length === 0) return { racks: [], switches: [] };

  // Switch-type templates -> the devices in those other racks that use them.
  const { data: swType, error: e7 } = await db.from("device_types")
    .select("id").eq("category", "rack").eq("code", "SW").maybeSingle();
  if (e7) throw new Error(`listSiteScope(swType): ${e7.message}`);
  if (!swType) return { racks: others, switches: [] };

  const { data: tpls, error: e8 } = await db.from("device_templates").select("id").eq("device_type_id", swType.id);
  if (e8) throw new Error(`listSiteScope(templates): ${e8.message}`);
  if (tpls.length === 0) return { racks: others, switches: [] };

  const { data: devs, error: e9 } = await db.from("rack_devices")
    .select("id, code, rack_id, front_face, height_u")
    .in("rack_id", others.map((r) => r.id))
    .in("device_template_id", tpls.map((t) => t.id));
  if (e9) throw new Error(`listSiteScope(devices): ${e9.message}`);

  const rackCode = Object.fromEntries(others.map((r) => [r.id, r.code]));
  const switches: SiteSwitchTarget[] = devs.map((d) => ({
    id: d.id, code: d.code, rackId: d.rack_id, rackCode: rackCode[d.rack_id] ?? "?",
    frontFace: (d.front_face as Face | null) ?? null, heightU: d.height_u,
  }));
  return { racks: others, switches };
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/racks/siteScope.ts
git commit -m "feat(endpoints): site-scope query for rack/switch targets"
```

---

### Task 6: `saveEndpointsAction`

**Files:**
- Modify: `src/features/racks/actions.ts` (append after `saveConnectionsAction`, ~line 80)

**Interfaces:**
- Consumes: `listPortEndpoints`/`replacePortEndpoints` (Task 4), `listSiteScope` (Task 5), `validateEndpoint`/`PortEndpoint`/`EndpointContext` (Task 2), existing `listRackDevices`, `portsOf`, `emptyFace`.
- Produces: `saveEndpointsAction(rackId: string, eps: PortEndpoint[]): Promise<{ ok: boolean; error?: string }>`

- [ ] **Step 1: Add the imports**

In `src/features/racks/actions.ts`, extend the existing import block:

```ts
import { replacePortEndpoints } from "./endpointsRepository";
import { validateEndpoint, type PortEndpoint, type EndpointContext } from "./endpointOps";
import { listSiteScope } from "./siteScope";
import { listDeviceTypes } from "@/features/device-library/repository";
```

- [ ] **Step 2: Append the action**

Add at the end of `src/features/racks/actions.ts`:

```ts
/** Reconcile the rack's port endpoints. Re-validates every endpoint against FRESH device
 *  snapshots, floor types and site scope so a stale client can't attach a far end to a vanished
 *  port, use a non-floor type, or point at a rack/switch off this site. */
export async function saveEndpointsAction(
  rackId: string, eps: PortEndpoint[],
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    const [devices, types, scope] = await Promise.all([
      listRackDevices(db, rackId), listDeviceTypes(db), listSiteScope(db, rackId),
    ]);
    const portsByDevice: Record<string, PortRef[]> = {};
    for (const d of devices) {
      const front = (d.front_face as Face | null) ?? emptyFace();
      const back = (d.back_face as Face | null) ?? emptyFace();
      portsByDevice[d.id] = [...portsOf(front, d.id, "front"), ...portsOf(back, d.id, "back")];
    }
    const ctx: EndpointContext = {
      floorTypeIds: new Set(types.filter((t) => t.category === "floor").map((t) => t.id)),
      portsByDevice,
      thisRackId: rackId,
      siteRackIds: new Set(scope.racks.map((r) => r.id)),
      siteSwitchDeviceIds: new Set(scope.switches.map((s) => s.id)),
    };
    // One endpoint per port, checked across the batch (the DB unique index is the backstop).
    const seen = new Set<string>();
    for (const ep of eps) {
      const key = `${ep.port.rackDeviceId}|${ep.port.side}|${ep.port.groupId}|${ep.port.portIndex}`;
      if (seen.has(key)) return { ok: false, error: "That port already has an endpoint" };
      seen.add(key);
      const err = validateEndpoint(ep, ctx);
      if (err) return { ok: false, error: err };
    }
    await replacePortEndpoints(db, rackId, eps);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath(`/racks/${rackId}`);
  return { ok: true };
}
```

- [ ] **Step 3: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/racks/actions.ts
git commit -m "feat(endpoints): saveEndpointsAction with server re-validation"
```

---

### Task 7: `EndpointFaceView.tsx` — draw one endpoint

**Files:**
- Create: `src/features/racks/EndpointFaceView.tsx`

**Interfaces:**
- Consumes: `faceForDescribed`/`ENDPOINT_GROUP_ID` (Task 3), `SiteSwitchTarget` (Task 5), existing `renderFace`, `frameDims`, `CELL_W`, `PX_PER_IN`.
- Produces:
  ```tsx
  <EndpointFaceView kind="described" typeCode portCount landingPortIndex landingPortLabel />
  <EndpointFaceView kind="device" target={SiteSwitchTarget} />
  <EndpointFaceView kind="rack" rackCode={string} />
  ```
  A `data-testid="endpoint-face"` wrapper in every case.

- [ ] **Step 1: Write the implementation**

Create `src/features/racks/EndpointFaceView.tsx`:

```tsx
"use client";
// The endpoint visualisation. Every kind draws faceplate-style through the existing pure
// renderFace — a described endpoint via its built-in face, a switch via its REAL snapshot face.
import { renderFace } from "@/features/device-library/faceplate/Faceplate";
import { frameDims, CELL_W, PX_PER_IN } from "@/domain/faceplate-geometry";
import type { Face } from "@/domain/faceplate";
import { faceForDescribed, ENDPOINT_GROUP_ID } from "./endpointFaces";
import type { SiteSwitchTarget } from "./siteScope";

const BLUE = "#1a55d8";

function FaceSvg({ face, widthIn, rackUnits, rackMounted, highlightIndex }: {
  face: Face;
  widthIn: number; rackUnits: number; rackMounted: boolean; highlightIndex?: number;
}) {
  const opts = { widthIn, rackUnits, rackMounted };
  const dims = frameDims(opts);
  const highlight = highlightIndex === undefined
    ? undefined
    : [{ groupId: ENDPOINT_GROUP_ID, portIndex: highlightIndex, color: BLUE }];
  return (
    <svg data-testid="endpoint-face" viewBox={`0 0 ${dims.frameWidthPx} ${dims.heightPx}`}
      className="h-auto w-full" preserveAspectRatio="xMidYMid meet">
      {renderFace(face, opts, highlight)}
    </svg>
  );
}

export type EndpointFaceViewProps =
  | { kind: "described"; typeCode: string; portCount: number; landingPortIndex: number; landingPortLabel: string }
  | { kind: "device"; target: SiteSwitchTarget }
  | { kind: "rack"; rackCode: string };

export function EndpointFaceView(props: EndpointFaceViewProps) {
  if (props.kind === "described") {
    const face = faceForDescribed(props);
    const cols = face.portGroups[0].cols;
    // Just wide enough for the ports, with a port's width of margin each side.
    const widthIn = ((cols + 2) * CELL_W) / PX_PER_IN;
    return <FaceSvg face={face} widthIn={widthIn} rackUnits={1} rackMounted={false}
      highlightIndex={props.landingPortIndex} />;
  }
  if (props.kind === "device") {
    const { target } = props;
    if (!target.frontFace) {
      return <div data-testid="endpoint-face" className="rounded border border-neutral-200 p-3 text-xs text-neutral-500">
        {target.rackCode}/{target.code} — no face recorded
      </div>;
    }
    return <FaceSvg face={target.frontFace} widthIn={19} rackUnits={target.heightU ?? 1} rackMounted />;
  }
  // kind === "rack" — a small rack outline with its code.
  return (
    <svg data-testid="endpoint-face" viewBox="0 0 120 90" className="h-auto w-full">
      <rect x={8} y={4} width={104} height={82} rx={4} fill="none" stroke="#3f3f46" strokeWidth={2} />
      <rect x={18} y={12} width={10} height={66} fill="#a3a3a3" />
      <rect x={92} y={12} width={10} height={66} fill="#a3a3a3" />
      <text x={60} y={50} textAnchor="middle" dominantBaseline="central"
        fontSize={18} fontWeight={600} fill="#3f3f46">{props.rackCode}</text>
    </svg>
  );
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/racks/EndpointFaceView.tsx
git commit -m "feat(endpoints): endpoint face visualisation"
```

---

### Task 8: `ConnectionDetails.tsx` — the right panel

**Files:**
- Create: `src/features/racks/ConnectionDetails.tsx`
- Test: `src/features/racks/ConnectionDetails.test.tsx`

**Interfaces:**
- Consumes: `PortEndpoint`/`endpointForPort`/`OUTLET_PORT_COUNTS`/`OutletPortCount` (Task 2), `OUTLET_TYPE_CODE` (Task 3), `SiteScope` (Task 5), `EndpointFaceView` (Task 7), `Connection`/`PortRef` from `./connectionOps`, `DeviceTypeRow` from `@/features/device-library/repository`.
- Produces:
  ```tsx
  <ConnectionDetails connection endpoints floorTypes siteScope portLabel onChange onRemove />
  ```
  Presentational only — all state lives in RackBuilder.

- [ ] **Step 1: Write the failing tests**

Create `src/features/racks/ConnectionDetails.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionDetails } from "./ConnectionDetails";
import type { Connection, PortRef } from "./connectionOps";
import type { PortEndpoint } from "./endpointOps";
import type { DeviceTypeRow } from "@/features/device-library/repository";

const a: PortRef = { rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 };
const b: PortRef = { rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 };
const conn: Connection = { id: "c1", a, b };

const t = (id: string, code: string, name: string): DeviceTypeRow => ({
  id, organization_id: "o", name, created_at: "", category: "floor", code, is_standard: true,
});
const floorTypes = [t("cam", "CAM", "Camera"), t("to", "TO", "Telecommunications Outlet"), t("rk", "RK", "Rack")];
const siteScope = {
  racks: [{ id: "rack-2", code: "RK02" }],
  switches: [{ id: "sw-2", code: "SW01", rackId: "rack-2", rackCode: "RK02", frontFace: null, heightU: 1 }],
};
const base = {
  connection: conn, endpoints: [] as PortEndpoint[], floorTypes, siteScope,
  portLabel: (p: PortRef) => `${p.rackDeviceId.toUpperCase()}/${p.portIndex + 1}`,
  onChange: vi.fn(), onRemove: vi.fn(),
};

describe("ConnectionDetails", () => {
  it("shows the run and one editor per end", () => {
    render(<ConnectionDetails {...base} />);
    expect(screen.getByText("SW/1 ↔ PP/1")).toBeTruthy();
    expect(screen.getByTestId("endpoint-editor-sw-front-g-sw-0")).toBeTruthy();
    expect(screen.getByTestId("endpoint-editor-pp-front-g-pp-0")).toBeTruthy();
  });

  it("omits the RK floor type from the select (an uplink is a real reference instead)", () => {
    render(<ConnectionDetails {...base} />);
    const sel = screen.getByTestId("endpoint-type-pp-front-g-pp-0") as HTMLSelectElement;
    const values = [...sel.options].map((o) => o.value);
    expect(values).toContain("described:cam");
    expect(values).not.toContain("described:rk");
    expect(values).toContain("device");
    expect(values).toContain("rack");
  });

  it("choosing a described type emits a described endpoint", () => {
    const onChange = vi.fn();
    render(<ConnectionDetails {...base} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-type-pp-front-g-pp-0"), { target: { value: "described:cam" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    expect(ep.kind).toBe("described");
    expect(ep.port).toEqual(b);
    if (ep.kind === "described") expect(ep.deviceTypeId).toBe("cam");
  });

  it("shows the port-count select for an outlet only", () => {
    const outlet: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "to",
      name: "OUT-12", portCount: 4, landingPortIndex: 1, landingPortLabel: "Desk A" };
    const { rerender } = render(<ConnectionDetails {...base} endpoints={[outlet]} />);
    expect(screen.queryByTestId("endpoint-portcount-pp-front-g-pp-0")).toBeTruthy();

    const cam: PortEndpoint = { ...outlet, deviceTypeId: "cam", portCount: 1, landingPortIndex: 0 };
    rerender(<ConnectionDetails {...base} endpoints={[cam]} />);
    expect(screen.queryByTestId("endpoint-portcount-pp-front-g-pp-0")).toBeNull();
  });

  it("editing the device name emits the updated endpoint", () => {
    const onChange = vi.fn();
    const cam: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "cam",
      name: "", portCount: 1, landingPortIndex: 0, landingPortLabel: "" };
    render(<ConnectionDetails {...base} endpoints={[cam]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-name-pp-front-g-pp-0"), { target: { value: "CAM01" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    if (ep.kind === "described") expect(ep.name).toBe("CAM01");
  });

  it("a switch endpoint lists site switches and emits a device endpoint", () => {
    const onChange = vi.fn();
    render(<ConnectionDetails {...base} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-type-pp-front-g-pp-0"), { target: { value: "device" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    expect(ep.kind).toBe("device");
    if (ep.kind === "device") expect(ep.targetRackDeviceId).toBe("sw-2");
  });

  it("renders a face for a set endpoint and removes on click", () => {
    const onRemove = vi.fn();
    const cam: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "cam",
      name: "CAM01", portCount: 1, landingPortIndex: 0, landingPortLabel: "" };
    render(<ConnectionDetails {...base} endpoints={[cam]} onRemove={onRemove} />);
    expect(screen.getAllByTestId("endpoint-face").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("endpoint-remove-pp-front-g-pp-0"));
    expect(onRemove).toHaveBeenCalledWith("e1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/features/racks/ConnectionDetails.test.tsx`
Expected: FAIL — `Failed to resolve import "./ConnectionDetails"`.

- [ ] **Step 3: Write the implementation**

Create `src/features/racks/ConnectionDetails.tsx`:

```tsx
"use client";
// Right panel for a selected connection: one far-end editor per end. Presentational — every edit
// is emitted upward; RackBuilder owns the state, history and autosave.
import type { Connection, PortRef } from "./connectionOps";
import { endpointForPort, OUTLET_PORT_COUNTS, type OutletPortCount, type PortEndpoint } from "./endpointOps";
import { OUTLET_TYPE_CODE } from "./endpointFaces";
import type { SiteScope } from "./siteScope";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import { EndpointFaceView } from "./EndpointFaceView";

const keyOf = (p: PortRef) => `${p.rackDeviceId}-${p.side}-${p.groupId}-${p.portIndex}`;
/** An uplink is a real rack reference, so the RK floor type never appears as a described type. */
const RACK_TYPE_CODE = "RK";

export function ConnectionDetails(props: {
  connection: Connection;
  endpoints: PortEndpoint[];
  floorTypes: DeviceTypeRow[];
  siteScope: SiteScope;
  portLabel: (p: PortRef) => string;
  onChange: (ep: PortEndpoint) => void;
  onRemove: (id: string) => void;
}) {
  const { connection, portLabel } = props;
  return (
    <div data-testid="connection-details">
      <h3 className="text-sm font-semibold text-neutral-900">Connection</h3>
      <p className="mt-1 text-xs text-neutral-500">{portLabel(connection.a)} ↔ {portLabel(connection.b)}</p>
      {[connection.a, connection.b].map((port) => (
        <EndpointEditor key={keyOf(port)} port={port} {...props} />
      ))}
    </div>
  );
}

function EndpointEditor({ port, endpoints, floorTypes, siteScope, portLabel, onChange, onRemove }: {
  port: PortRef;
  endpoints: PortEndpoint[];
  floorTypes: DeviceTypeRow[];
  siteScope: SiteScope;
  portLabel: (p: PortRef) => string;
  onChange: (ep: PortEndpoint) => void;
  onRemove: (id: string) => void;
}) {
  const k = keyOf(port);
  const ep = endpointForPort(endpoints, port);
  const describedTypes = floorTypes.filter((t) => t.code !== RACK_TYPE_CODE);
  const typeById = Object.fromEntries(floorTypes.map((t) => [t.id, t]));
  const selectValue = !ep ? "" : ep.kind === "described" ? `described:${ep.deviceTypeId}` : ep.kind;

  function pickKind(value: string) {
    const id = ep?.id ?? crypto.randomUUID();
    if (value === "") { if (ep) onRemove(ep.id); return; }
    if (value === "device") {
      const first = siteScope.switches[0];
      if (!first) return;
      onChange({ id, port, kind: "device", targetRackDeviceId: first.id });
      return;
    }
    if (value === "rack") {
      const first = siteScope.racks[0];
      if (!first) return;
      onChange({ id, port, kind: "rack", targetRackId: first.id });
      return;
    }
    const deviceTypeId = value.slice("described:".length);
    onChange({ id, port, kind: "described", deviceTypeId, name: "",
      portCount: 1, landingPortIndex: 0, landingPortLabel: "" });
  }

  const isOutlet = ep?.kind === "described" && typeById[ep.deviceTypeId]?.code === OUTLET_TYPE_CODE;

  return (
    <div data-testid={`endpoint-editor-${k}`} className="mt-3 rounded-lg border border-neutral-200 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-900">{portLabel(port)}</span>
        {ep && (
          <button type="button" data-testid={`endpoint-remove-${k}`} className="text-xs text-red-600"
            onClick={() => onRemove(ep.id)}>Remove</button>
        )}
      </div>

      <select data-testid={`endpoint-type-${k}`} value={selectValue}
        onChange={(e) => pickKind(e.target.value)}
        className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm">
        <option value="">No endpoint</option>
        {describedTypes.map((t) => <option key={t.id} value={`described:${t.id}`}>{t.name}</option>)}
        <option value="device">Switch (another rack)</option>
        <option value="rack">Rack uplink</option>
      </select>

      {ep?.kind === "described" && (
        <>
          <input data-testid={`endpoint-name-${k}`} value={ep.name} placeholder="Device name"
            onChange={(e) => onChange({ ...ep, name: e.target.value })}
            className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm" />
          {isOutlet && (
            <div className="mt-2 flex gap-2">
              <select data-testid={`endpoint-portcount-${k}`} value={ep.portCount}
                onChange={(e) => {
                  const portCount = Number(e.target.value) as OutletPortCount;
                  onChange({ ...ep, portCount, landingPortIndex: Math.min(ep.landingPortIndex, portCount - 1) });
                }}
                className="w-1/2 rounded-md border border-neutral-300 px-2 py-1 text-sm">
                {OUTLET_PORT_COUNTS.map((n) => <option key={n} value={n}>{n} port</option>)}
              </select>
              <select data-testid={`endpoint-landing-${k}`} value={ep.landingPortIndex}
                onChange={(e) => onChange({ ...ep, landingPortIndex: Number(e.target.value) })}
                className="w-1/2 rounded-md border border-neutral-300 px-2 py-1 text-sm">
                {Array.from({ length: ep.portCount }, (_, i) => <option key={i} value={i}>Port {i + 1}</option>)}
              </select>
            </div>
          )}
          <input data-testid={`endpoint-label-${k}`} value={ep.landingPortLabel} placeholder="Endpoint label"
            onChange={(e) => onChange({ ...ep, landingPortLabel: e.target.value })}
            className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm" />
        </>
      )}

      {ep?.kind === "device" && (
        <select data-testid={`endpoint-switch-${k}`} value={ep.targetRackDeviceId}
          onChange={(e) => onChange({ ...ep, targetRackDeviceId: e.target.value })}
          className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm">
          {siteScope.switches.map((s) => <option key={s.id} value={s.id}>{s.rackCode}/{s.code}</option>)}
        </select>
      )}

      {ep?.kind === "rack" && (
        <select data-testid={`endpoint-rack-${k}`} value={ep.targetRackId}
          onChange={(e) => onChange({ ...ep, targetRackId: e.target.value })}
          className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm">
          {siteScope.racks.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
        </select>
      )}

      {ep && (
        <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-2">
          {ep.kind === "described" && (
            <EndpointFaceView kind="described" typeCode={typeById[ep.deviceTypeId]?.code ?? ""}
              portCount={ep.portCount} landingPortIndex={ep.landingPortIndex} landingPortLabel={ep.landingPortLabel} />
          )}
          {ep.kind === "device" && (() => {
            const target = siteScope.switches.find((s) => s.id === ep.targetRackDeviceId);
            return target ? <EndpointFaceView kind="device" target={target} /> : null;
          })()}
          {ep.kind === "rack" && (() => {
            const target = siteScope.racks.find((r) => r.id === ep.targetRackId);
            return target ? <EndpointFaceView kind="rack" rackCode={target.code} /> : null;
          })()}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/features/racks/ConnectionDetails.test.tsx`
Expected: PASS — 7 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/racks/ConnectionDetails.tsx src/features/racks/ConnectionDetails.test.tsx
git commit -m "feat(endpoints): connection details panel"
```

---

### Task 9: Wire into RackBuilder and the page

**Files:**
- Modify: `src/app/racks/[id]/page.tsx`
- Modify: `src/features/racks/RackBuilder.tsx` (RackState ~line 36; props ~line 38; queueSave ~line 85; commit helpers ~line 101; onDelete ~line 228; sidebar ~line 274)

**Interfaces:**
- Consumes: `listPortEndpoints` (Task 4), `listSiteScope`/`SiteScope` (Task 5), `saveEndpointsAction` (Task 6), `ConnectionDetails` (Task 8), `upsertEndpoint`/`removeEndpoint`/`PortEndpoint` (Task 2).
- Produces: endpoints persisted through the existing history + autosave; the panel visible when a connection is selected.

- [ ] **Step 1: Load endpoints + site scope on the page**

Replace the body of `src/app/racks/[id]/page.tsx`:

```tsx
import { createServiceClient } from "@/lib/supabase/server";
import { getRack, listRackDevices } from "@/features/racks/repository";
import { listConnections } from "@/features/racks/connectionsRepository";
import { listPortEndpoints } from "@/features/racks/endpointsRepository";
import { listSiteScope } from "@/features/racks/siteScope";
import { listDeviceTypes, listTemplatesForType } from "@/features/device-library/repository";
import { RackBuilder } from "@/features/racks/RackBuilder";

export const dynamic = "force-dynamic";

export default async function RackBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceClient();
  const [rack, devices, types, connections, endpoints, siteScope] = await Promise.all([
    getRack(db, id), listRackDevices(db, id), listDeviceTypes(db), listConnections(db, id),
    listPortEndpoints(db, id), listSiteScope(db, id),
  ]);
  const rackTypes = types.filter((t) => t.category === "rack");
  const floorTypes = types.filter((t) => t.category === "floor");
  // All templates for all rack types, keyed by type — one round trip per type is fine at this scale.
  const templatesByType = Object.fromEntries(
    await Promise.all(rackTypes.map(async (t) => [t.id, await listTemplatesForType(db, t.id)])),
  );
  return <RackBuilder rack={rack} initialDevices={devices} initialConnections={connections}
    initialEndpoints={endpoints} siteScope={siteScope} floorTypes={floorTypes}
    types={rackTypes} templatesByType={templatesByType} />;
}
```

- [ ] **Step 2: Add the imports and props in RackBuilder**

In `src/features/racks/RackBuilder.tsx`, add to the imports:

```ts
import { saveEndpointsAction } from "./actions";
import { upsertEndpoint, removeEndpoint, type PortEndpoint } from "./endpointOps";
import type { SiteScope } from "./siteScope";
import { ConnectionDetails } from "./ConnectionDetails";
```

(`saveEndpointsAction` joins the existing `./actions` import — merge, don't duplicate the line.)

- [ ] **Step 3: Fold endpoints into RackState and the props**

Replace the `RackState` type and the component signature/first lines (~lines 36–47):

```ts
type RackState = { placements: PlacementDraft[]; connections: Connection[]; endpoints: PortEndpoint[] };

export function RackBuilder({ rack, initialDevices, initialConnections, initialEndpoints, siteScope, floorTypes, types, templatesByType }: {
  rack: RackRow;
  initialDevices: RackDeviceRow[];
  initialConnections: Connection[];
  initialEndpoints: PortEndpoint[];
  siteScope: SiteScope;
  floorTypes: DeviceTypeRow[];
  types: DeviceTypeRow[];
  templatesByType: Record<string, PickerTemplate[]>;
}) {
  const [hist, setHist] = useState<History<RackState>>(() =>
    createHistory({ placements: initialDevices.map(fromRow), connections: initialConnections, endpoints: initialEndpoints }));
  const { placements, connections, endpoints } = hist.present;
```

- [ ] **Step 4: Save endpoints alongside the other two**

Replace `queueSave` (~line 85) and the commit helpers (~lines 101–114):

```ts
  function queueSave(next: RackState) {
    setSaveState("saving"); setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const [layout, conns, eps] = await Promise.all([
        saveRackLayoutAction(rack.id, next.placements.map(toInput)),
        saveConnectionsAction(rack.id, next.connections),
        saveEndpointsAction(rack.id, next.endpoints),
      ]);
      const bad = !layout.ok ? layout : !conns.ok ? conns : !eps.ok ? eps : null;
      if (bad) { setSaveState("error"); setError(bad.error ?? "Save failed"); return; }
      setSaveState("saved");
    }, 600);
  }
  // Skip the history push (and the save) when the patch didn't actually change anything — a
  // same-value edit (e.g. re-selecting the current status) would otherwise create a dead undo
  // step that visibly does nothing when the user hits ⌘Z.
  function commitState(next: RackState) {
    if (next.placements === placements && next.connections === connections && next.endpoints === endpoints) return;
    setHist((h) => push(h, next));
    queueSave(next);
  }
  // Keep the placement-only helper for the many existing call sites.
  function commit(nextPlacements: PlacementDraft[]) {
    if (nextPlacements === placements) return;
    commitState({ placements: nextPlacements, connections, endpoints });
  }
  function commitConnections(nextConns: Connection[]) {
    if (nextConns === connections) return;
    commitState({ placements, connections: nextConns, endpoints });
  }
  function commitEndpoints(nextEps: PortEndpoint[]) {
    if (nextEps === endpoints) return;
    commitState({ placements, connections, endpoints: nextEps });
  }
```

- [ ] **Step 5: Drop a deleted device's endpoints too**

There are two `onDelete`-style call sites that filter connections (the `RackCanvas` `onDelete` prop ~line 228 and the sidebar's `onDelete` ~line 265). In **both**, add the endpoint filter to the `commitState` call. Drop endpoints hanging off the deleted device's ports, AND any `device` endpoint elsewhere in this rack that pointed AT it:

```ts
              commitState({
                placements: placements.filter((p) => p.id !== id),
                connections: connections.filter((c) => c.a.rackDeviceId !== id && c.b.rackDeviceId !== id),
                endpoints: endpoints.filter((e) =>
                  e.port.rackDeviceId !== id && !(e.kind === "device" && e.targetRackDeviceId === id)),
              });
```

The `e.kind === "device"` guard is required, not optional: `targetRackDeviceId` exists only on the `device` member of the union, so `e.targetRackDeviceId !== id` alone does not typecheck.

At the **sidebar** call site the variable is `selected.id`, not `id` — substitute it in all three filters there.

- [ ] **Step 6: Render the panel when a connection is selected**

In the sidebar block (~line 274), insert before the `{!selected && (<RackSettings .../>)}` line:

```tsx
        {!selected && selectedConnectionId && (() => {
          const c = connections.find((x) => x.id === selectedConnectionId);
          return c ? (
            <ConnectionDetails
              connection={c}
              endpoints={endpoints}
              floorTypes={floorTypes}
              siteScope={siteScope}
              portLabel={labelForPort}
              onChange={(ep) => commitEndpoints(upsertEndpoint(endpoints, ep))}
              onRemove={(id) => commitEndpoints(removeEndpoint(endpoints, id))}
            />
          ) : null;
        })()}
```

And change the rack-settings fallback so it doesn't show at the same time:

```tsx
        {!selected && !selectedConnectionId && (
          <RackSettings rack={rack} minHeight={minHeight} heightU={heightU} onHeightChange={changeHeight} />
        )}
```

- [ ] **Step 7: Typecheck and run the DB-free tests**

```bash
./node_modules/.bin/tsc --noEmit
npx vitest run src/features/racks/endpointOps.test.ts src/features/racks/endpointFaces.test.ts src/features/racks/ConnectionDetails.test.tsx src/features/racks/PatchLayer.test.tsx src/features/racks/RackCanvas.test.tsx src/features/racks/RackFrame.test.tsx src/features/racks/portGeometry.test.ts src/features/racks/connectionOps.test.ts
```

Expected: all PASS. (Named files only — never the directory.)

- [ ] **Step 8: Commit**

```bash
git add src/app/racks/\[id\]/page.tsx src/features/racks/RackBuilder.tsx
git commit -m "feat(endpoints): wire endpoints into RackBuilder state, autosave and sidebar"
```

---

### Task 10: Integration test + browser verification

**Files:**
- Create: `src/features/racks/endpoints.integration.test.ts`

**Interfaces:**
- Consumes: `saveEndpointsAction` (Task 6), `listPortEndpoints` (Task 4).
- Produces: proof the action persists and rejects correctly against a real DB.

> **This test MUST be scoped** — seed its own site and delete only that site in `afterAll`
> (`.eq("id", ids.site)`), exactly like `actions.integration.test.ts`. Never use
> `.delete().neq(...)`, which is what makes `repository.integration.test.ts` wipe the whole DB.
> Scoped means running it by filename leaves the user's seeded rack intact.

- [ ] **Step 1: Write the integration test**

Create `src/features/racks/endpoints.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The action calls next/cache's revalidatePath, which throws "static generation store missing"
// outside a real Next.js request context. Stub it — test infrastructure only, it doesn't touch
// the validation/persistence under test. (Same reason as actions.integration.test.ts.)
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createServiceClient } from "@/lib/supabase/server";
import { emptyFace, type Face, type PortGroup } from "@/domain/faceplate";
import { getDefaultOrganization } from "@/features/locations/repository";
import { listDeviceTypes } from "@/features/device-library/repository";
import { saveEndpointsAction } from "./actions";
import { listPortEndpoints } from "./endpointsRepository";
import type { PortEndpoint } from "./endpointOps";

const db = createServiceClient();
let rackId = "";      // the rack under test
let otherRackId = ""; // a second rack on the SAME site — the valid uplink target
let ppId = "";
let camTypeId = "";
const ids: { site?: string; templateId?: string } = {};

// port_endpoints.group_id is `uuid not null`, so the seeded face's group id must be a real UUID.
const GROUP_PP = crypto.randomUUID();

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 24, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const faceWith = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });

beforeAll(async () => {
  const org = await getDefaultOrganization(db);
  const site = (await db.from("sites")
    .insert({ organization_id: org.id, code: "T-EP", name: "endpoints test" })
    .select().single()).data!;
  ids.site = site.id;
  const floor = (await db.from("floors")
    .insert({ site_id: site.id, code: "F-EP", name: "F" })
    .select().single()).data!;
  const room = (await db.from("rooms")
    .insert({ floor_id: floor.id, code: "R-EP", name: "R" })
    .select().single()).data!;
  rackId = (await db.from("racks")
    .insert({ room_id: room.id, code: "RKE1", height_u: 12 }).select().single()).data!.id;
  // Second rack on the same site — makes listSiteScope non-empty and gives uplinks a valid target.
  otherRackId = (await db.from("racks")
    .insert({ room_id: room.id, code: "RKE2", height_u: 12 }).select().single()).data!.id;

  const deviceTypes = await listDeviceTypes(db);
  const rackType = deviceTypes.find((t) => t.category === "rack");
  if (!rackType) throw new Error("no rack-category device type available for test");
  const cam = deviceTypes.find((t) => t.category === "floor" && t.code === "CAM");
  if (!cam) throw new Error("no CAM floor device type available for test");
  camTypeId = cam.id;

  const tpl = (await db.from("device_templates").insert({
    organization_id: org.id, name: "endpoints test tpl", device_type_id: rackType.id,
    rack_units: 1, width_in: 19, rack_mounted: true,
    front_face: emptyFace(), back_face: emptyFace(),
  }).select().single()).data!;
  ids.templateId = tpl.id;

  ppId = (await db.from("rack_devices").insert({
    rack_id: rackId, device_template_id: tpl.id, code: "PP01",
    start_u: 3, front_face: faceWith(GROUP_PP), back_face: emptyFace(), height_u: 1,
  }).select().single()).data!.id;
});

afterAll(async () => {
  // SCOPED cleanup: only this test's site. Cascades to floors → rooms → racks → rack_devices →
  // port_endpoints. Never `.neq(...)` — that would wipe the developer's own data.
  if (ids.site) await db.from("sites").delete().eq("id", ids.site);
  // device_templates isn't cascaded from the site (ON DELETE RESTRICT), clean up separately.
  if (ids.templateId) await db.from("device_templates").delete().eq("id", ids.templateId);
});

const port = (i: number) => ({ rackDeviceId: ppId, side: "front" as const, groupId: GROUP_PP, portIndex: i });
const cam = (i: number, over: Partial<Extract<PortEndpoint, { kind: "described" }>> = {}): PortEndpoint => ({
  id: crypto.randomUUID(), port: port(i), kind: "described", deviceTypeId: camTypeId,
  name: "CAM01", portCount: 1, landingPortIndex: 0, landingPortLabel: "Lobby", ...over,
});

describe("saveEndpointsAction", () => {
  it("saves a described endpoint and reads it back", async () => {
    const res = await saveEndpointsAction(rackId, [cam(0)]);
    expect(res.ok).toBe(true);
    const back = await listPortEndpoints(db, rackId);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ kind: "described", name: "CAM01", landingPortLabel: "Lobby" });
  });

  it("rejects an endpoint on a port that does not exist", async () => {
    const res = await saveEndpointsAction(rackId, [cam(9999)]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That port no longer exists");
  });

  it("rejects two endpoints on the same port", async () => {
    const res = await saveEndpointsAction(rackId, [cam(1), cam(1)]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("That port already has an endpoint");
  });

  it("rejects a rack uplink to this same rack", async () => {
    const ep: PortEndpoint = { id: crypto.randomUUID(), port: port(2), kind: "rack", targetRackId: rackId };
    const res = await saveEndpointsAction(rackId, [ep]);
    expect(res.ok).toBe(false);
    expect(res.error).toBe("An uplink must target a different rack");
  });

  it("accepts a rack uplink to another rack on the same site", async () => {
    const ep: PortEndpoint = { id: crypto.randomUUID(), port: port(3), kind: "rack", targetRackId: otherRackId };
    const res = await saveEndpointsAction(rackId, [ep]);
    expect(res.ok).toBe(true);
  });

  it("removes an endpoint when it is omitted from the next save", async () => {
    await saveEndpointsAction(rackId, [cam(0)]);
    const res = await saveEndpointsAction(rackId, []);
    expect(res.ok).toBe(true);
    expect(await listPortEndpoints(db, rackId)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it — BY FILENAME ONLY**

```bash
cd /Users/reubensingh/development/network-doc-platform
npx vitest run src/features/racks/endpoints.integration.test.ts --no-file-parallelism
```

Expected: 6 PASS. (`--no-file-parallelism` because the integration suites race on the shared DB.)

- [ ] **Step 3: Confirm the developer's own data survived**

Because this test is scoped, the existing rack must still be there:

```bash
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t \
  -c "select count(*) from racks;"
```

Expected: **≥ 1** (the seeded RK01 still exists). If it is 0, the test used `.neq(...)` somewhere —
fix the cleanup to `.eq("id", ids.site)` before going further, then re-seed via
`scratchpad/reseed-patch.sql` (insert site → floor → room → 12U rack + two `rack_devices` reusing the
existing `Switch 24-Port` / `Patch Panel 24-Port` templates **by name**; do not re-insert those
templates — they survive and `(organization_id, name)` is unique).

- [ ] **Step 4: Verify in the browser**

Start/confirm the dev server (preview "rack-designer-dev", port 3100) and open `http://localhost:3100/racks/<seeded id>`. Then:

1. Patch `SW01/1 → PP01/1` (drag, or click-to-connect).
2. Click the cable to select it — the right panel must show **Connection · SW01/1 ↔ PP01/1** with two editor cards.
3. On the `PP01/1` card choose **Camera**, type `CAM01` → a single-port face renders with the port highlighted blue.
4. Change the type to **Telecommunications Outlet**, set **4 port**, landing **Port 2**, label `Desk A` → the face redraws with 4 ports, port 2 highlighted and labelled.
5. Wait for **✓ Saved**, reload the page, re-select the cable → the outlet endpoint is still there.
6. Disconnect the cable, re-patch the same ports, select it → **the endpoint is still on PP01/1** (it belongs to the port).
7. Press ⌘Z → the last endpoint edit undoes.

Fix anything that fails before committing.

- [ ] **Step 5: Commit**

```bash
git add src/features/racks/endpoints.integration.test.ts
git commit -m "test(endpoints): integration coverage for saveEndpointsAction"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `port_endpoints` table, constraints, RLS/grants | 1 |
| Endpoint belongs to a port; one per port | 1 (unique), 2 (`upsertEndpoint`), 6 (batch check) |
| Three kinds as a discriminated union | 2 |
| Validation: port exists, floor type, landing < count, same-site, not this rack | 2, re-validated in 6 |
| Built-in face per described type; `TO` multi-port; landing label | 3 |
| Persistence + reconcile | 4 |
| Site scope via room→floor→site; Switch-type devices only; excludes this rack | 5 |
| Server re-validation against fresh snapshots | 6 |
| Faceplate-style drawing for every kind (described / real switch face / rack graphic) | 7 |
| Right panel per end; type select excludes RK; `port_count` for `TO` only; name input | 8 |
| `RackState` gains endpoints; shared history/undo; third 600 ms autosave | 9 |
| Deleting a device drops its endpoints client-side | 9 (step 5) |
| Disconnecting a cable must NOT delete endpoints | 10 (browser step 6) |
| Integration coverage + rejections | 10 |
| Test-run hazard (filename only) | Global Constraints; Task 10 |

**Type consistency:** `PortEndpoint`, `EndpointContext`, `OutletPortCount`, `OUTLET_PORT_COUNTS` (Task 2) are used unchanged in Tasks 4, 6, 8, 9, 10. `faceForDescribed(args)` / `ENDPOINT_GROUP_ID` / `OUTLET_TYPE_CODE` (Task 3) are consumed by Tasks 7 and 8. `SiteScope`/`SiteRackTarget`/`SiteSwitchTarget` (Task 5) are consumed by Tasks 6, 8, 9. `listPortEndpoints`/`replacePortEndpoints` (Task 4) are consumed by Tasks 6, 9, 10.

**Known deviations from the spec, deliberate and noted inline:**
- `faceForDescribed` takes an args object rather than `(typeCode, portCount)` so the landing label rides along (Task 3).
- `siteScope.switches` carries `frontFace`/`heightU` so a `device` endpoint's real faceplate draws without a second query (Task 5).

**Corrections made during self-review (the spec is imprecise here; this plan is authoritative):**
- The spec says "`*.integration.test.ts` … delete all `sites`". Only **two** do —
  `racks/repository.integration.test.ts:27` and `locations/repository.integration.test.ts:22`, via
  `.delete().neq(...)`. `actions.integration.test.ts` and `connectionsRepository.integration.test.ts`
  are scoped and safe. Task 10's new test follows the **scoped** pattern, so it does not wipe the DB
  and needs no re-seed afterwards — only a directory/glob run is dangerous (it pulls in the
  destructive `racks/repository` file).
- Task 10 must `vi.mock("next/cache", …)`; `revalidatePath` throws outside a Next request context.
  Missing this fails every action test with "static generation store missing".
- Seeded face group ids must be real UUIDs — `port_endpoints.group_id` is `uuid not null`, so the
  illustrative `"g-pp"` strings used in the pure unit tests cannot be reused in the DB test.
