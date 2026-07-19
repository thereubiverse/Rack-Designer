# Clients Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Organise racks in a directory per client and site, reached through the Clients section, replacing the flat `Racks` sidebar list.

**Architecture:** A new `clients` table replaces `organizations` at the top of the hierarchy (`client → site → floor → room → rack`), and the device library becomes global. Three server-component drill-down pages under `/clients` browse the tree using readable uppercase codes in the URL; the rack builder keeps its existing UUID permalink at `/racks/[rackId]`. Deletion leans on the database's existing `CASCADE` chain, with the UI responsible only for showing what will be destroyed.

**Tech Stack:** Next.js 16 (app router, server components), TypeScript strict, Supabase (local via Docker), Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-07-17-clients-directory-design.md`

## Global Constraints

- **NEVER run vitest against a directory or glob.** `*.integration.test.ts` files in this repo delete rows wholesale and WILL wipe the developer's local database. Run tests by EXPLICIT FILENAME only — never `vitest run src/features/clients/`.
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` resolves the wrong package.
- There is no local `psql`. Use `docker exec supabase_db_network-doc-platform psql -U postgres -d postgres`.
- Server actions return `{ ok: boolean; error?: string }` — they never throw to the caller.
- Codes match `isValidCode` from `@/domain/hierarchy` (`/^[A-Za-z0-9_-]+$/`), are stored uppercase, and are matched case-insensitively when resolving a URL.
- Run commands from the project root; the Bash tool's cwd resets between calls.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Component markup is the implementer's to write** within the contract each task gives (exact props, `data-testid`s, and behaviours). Match the existing visual language: see `RackDeviceTable.tsx` for the card-table pattern and `AddDevicePicker.tsx` for the modal pattern.

---

### Task 1: Migration 0008 — clients table, global library, drop organizations

**Files:**
- Create: `supabase/migrations/0008_clients.sql`
- Modify: `src/lib/supabase/types.ts`

**Interfaces:**
- Produces: `ClientRow { id: string; code: string; name: string; created_at: string }`; `SiteRow.client_id: string` (replacing `organization_id`); `OrganizationRow` deleted; `organization_id` removed from `DeviceTypeRow` and `BrandRow`.

- [ ] **Step 1: Back up the location tables before anything destructive**

This migration destroys all locations. Take the safety dump first:

```bash
docker exec supabase_db_network-doc-platform pg_dump -U postgres -d postgres \
  -t sites -t floors -t rooms -t racks -t rack_devices -t connections -t port_endpoints \
  > ~/rack-designer-locations-backup-$(date +%Y%m%d-%H%M).sql
ls -la ~/rack-designer-locations-backup-*.sql
```
Expected: a non-empty `.sql` file. Do not continue if it is 0 bytes.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0008_clients.sql`:

```sql
-- Clients replace organizations at the top of the hierarchy:
--   client -> site -> floor -> room -> rack
-- The device library (brands, device_types, device_templates) becomes GLOBAL: it is one
-- catalogue shared by every client, so it loses its owner column entirely.

create table clients (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

alter table clients enable row level security;
create policy "single_org_all" on clients for all using (true) with check (true);

-- Destructive: wipe every location. Cascades sites -> floors -> rooms -> racks ->
-- rack_devices -> connections / port_endpoints. Deliberate (see spec 2.1).
delete from sites;

-- Reparent sites onto clients.
alter table sites drop constraint sites_organization_id_code_key;
alter table sites drop column organization_id;
alter table sites add column client_id uuid not null references clients(id) on delete cascade;
alter table sites add constraint sites_client_id_code_key unique (client_id, code);

-- Device library goes global: drop the owner column and re-scope its uniques.
alter table brands drop constraint brands_organization_id_name_key;
alter table brands drop column organization_id;
alter table brands add constraint brands_name_key unique (name);

alter table device_templates drop constraint device_templates_organization_id_name_key;
alter table device_templates drop column organization_id;
alter table device_templates add constraint device_templates_name_key unique (name);

alter table device_types drop constraint device_types_org_code_key;
alter table device_types drop constraint device_types_org_category_name_key;
alter table device_types drop column organization_id;
alter table device_types add constraint device_types_code_key unique (code);
alter table device_types add constraint device_types_category_name_key unique (category, name);

drop table organizations;
```

- [ ] **Step 3: Apply it and verify the schema**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0008_clients.sql
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t -c "select table_name from information_schema.tables where table_schema='public' order by 1;"
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t -c "select column_name from information_schema.columns where table_schema='public' and column_name in ('organization_id','client_id');"
```
Expected: `clients` present and `organizations` absent; the only column returned is `sites.client_id`. Zero rows mentioning `organization_id`.

- [ ] **Step 4: Update the row types**

In `src/lib/supabase/types.ts`: delete `OrganizationRow`; add `ClientRow`; on `SiteRow` replace `organization_id: string` with `client_id: string`.

```ts
export interface ClientRow {
  id: string;
  code: string;
  name: string;
  created_at: string;
}
```

Also remove the `organization_id` field from `DeviceTypeRow` and `BrandRow` wherever they are declared (`src/features/device-library/repository.ts` declares them if not in `types.ts` — check both).

- [ ] **Step 5: Typecheck to enumerate the fallout**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head -30
```
Expected: FAILS, listing every file that still references `organization_id` / `OrganizationRow`. Record that list — Tasks 4 and 5 fix it. Do not fix them here.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0008_clients.sql src/lib/supabase/types.ts
git commit -m "feat(db): clients replace organizations; device library goes global"
```

---

### Task 2: Pure validation module

**Files:**
- Create: `src/features/clients/validation.ts`, `src/features/clients/validation.test.ts`

**Interfaces:**
- Produces: `normaliseCode(raw: string): string`; `validateCode(raw: string, kind: "client" | "site"): string | null`; `describeCascade(counts: CascadeCounts): string`; `CascadeCounts { sites?: number; racks?: number; devices?: number }`; `requiresTypedConfirm(counts: CascadeCounts): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/clients/validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normaliseCode, validateCode, describeCascade, requiresTypedConfirm } from "./validation";

describe("normaliseCode", () => {
  it("uppercases and trims so codes are stored one way", () => {
    expect(normaliseCode("  acme ")).toBe("ACME");
  });
});

describe("validateCode", () => {
  it("accepts letters, digits, dash and underscore", () => {
    expect(validateCode("ACME-1_A", "client")).toBeNull();
  });
  it("rejects an empty code, naming the kind", () => {
    expect(validateCode("  ", "client")).toBe("Client code is required");
  });
  it("rejects characters outside the allowed set, naming the kind", () => {
    expect(validateCode("AC ME", "site")).toBe("Site code can only use letters, numbers, - and _");
  });
});

describe("describeCascade", () => {
  it("lists only the non-zero parts, pluralised", () => {
    expect(describeCascade({ sites: 3, racks: 7, devices: 41 })).toBe("3 sites, 7 racks and 41 devices");
    expect(describeCascade({ sites: 1, racks: 1, devices: 0 })).toBe("1 site and 1 rack");
  });
  it("says nothing is affected when the subtree is empty", () => {
    expect(describeCascade({})).toBe("nothing else");
  });
});

describe("requiresTypedConfirm", () => {
  it("only demands the typed code when something would actually be destroyed", () => {
    expect(requiresTypedConfirm({})).toBe(false);
    expect(requiresTypedConfirm({ sites: 0, racks: 0 })).toBe(false);
    expect(requiresTypedConfirm({ racks: 1 })).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/features/clients/validation.test.ts
```
Expected: FAIL — cannot resolve `./validation`.

- [ ] **Step 3: Implement**

Create `src/features/clients/validation.ts`:

```ts
import { isValidCode } from "@/domain/hierarchy";

export interface CascadeCounts { sites?: number; racks?: number; devices?: number }

/** Codes are stored one way — uppercase, trimmed — so URL matching can be case-insensitive. */
export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function validateCode(raw: string, kind: "client" | "site"): string | null {
  const label = kind === "client" ? "Client" : "Site";
  const code = normaliseCode(raw);
  if (!code) return `${label} code is required`;
  if (!isValidCode(code)) return `${label} code can only use letters, numbers, - and _`;
  return null;
}

/** "3 sites, 7 racks and 41 devices" — only the parts that are actually non-zero. */
export function describeCascade(counts: CascadeCounts): string {
  const parts: string[] = [];
  const add = (n: number | undefined, one: string, many: string) => {
    if (n && n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(counts.sites, "site", "sites");
  add(counts.racks, "rack", "racks");
  add(counts.devices, "device", "devices");
  if (parts.length === 0) return "nothing else";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Typing the code to confirm is only worth demanding when a delete actually destroys something. */
export function requiresTypedConfirm(counts: CascadeCounts): boolean {
  return (counts.sites ?? 0) + (counts.racks ?? 0) + (counts.devices ?? 0) > 0;
}
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/features/clients/validation.test.ts
```
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/clients/validation.ts src/features/clients/validation.test.ts
git commit -m "feat(clients): pure code validation and cascade description"
```

---

### Task 3: Clients repository

**Files:**
- Create: `src/features/clients/repository.ts`, `src/features/clients/repository.integration.test.ts`

**Interfaces:**
- Consumes: `ClientRow` (Task 1); `normaliseCode` (Task 2).
- Produces:
  - `ClientSummary { id, code, name, siteCount, rackCount }`
  - `SiteSummary { id, code, name, address: string | null, rackCount }`
  - `SiteRackRow { id, code, heightU, floorCode, roomCode, roomType, deviceCount }`
  - `listClients(db): Promise<ClientSummary[]>`
  - `getClientByCode(db, code): Promise<ClientRow | null>`
  - `listSitesForClient(db, clientId): Promise<SiteSummary[]>`
  - `getSiteByCode(db, clientId, code): Promise<SiteRow | null>`
  - `listRacksForSite(db, siteId): Promise<SiteRackRow[]>`
  - `createClient(db, { code, name }): Promise<ClientRow>`
  - `renameClient(db, id, { code, name }): Promise<void>`
  - `deleteClient(db, id): Promise<void>`
  - `createSiteForClient(db, { clientId, code, name, address }): Promise<SiteRow>`
  - `renameSite(db, id, { code, name, address }): Promise<void>`
  - `deleteSite(db, id): Promise<void>`
  - `countClientCascade(db, clientId): Promise<CascadeCounts>`
  - `countSiteCascade(db, siteId): Promise<CascadeCounts>`

- [ ] **Step 1: Implement the repository**

Create `src/features/clients/repository.ts`. All lookups by code must be case-insensitive — use `.ilike("code", code)` so `/clients/acme` resolves `ACME`. Every write normalises its code through `normaliseCode` first. Follow the existing error style: `if (error) throw new Error(\`fnName: ${error.message}\`)`.

Counts are derived by walking the hierarchy with `in` filters (there is no join helper in this codebase — see `listRacksWithPath` in `features/locations/repository.ts` for the nested-select precedent):

```ts
export async function countSiteCascade(db: SupabaseClient, siteId: string): Promise<CascadeCounts> {
  const { data: floors } = await db.from("floors").select("id").eq("site_id", siteId);
  const floorIds = (floors ?? []).map((f) => f.id as string);
  if (floorIds.length === 0) return { racks: 0, devices: 0 };
  const { data: rooms } = await db.from("rooms").select("id").in("floor_id", floorIds);
  const roomIds = (rooms ?? []).map((r) => r.id as string);
  if (roomIds.length === 0) return { racks: 0, devices: 0 };
  const { data: racks } = await db.from("racks").select("id").in("room_id", roomIds);
  const rackIds = (racks ?? []).map((r) => r.id as string);
  if (rackIds.length === 0) return { racks: 0, devices: 0 };
  const { count } = await db.from("rack_devices").select("id", { count: "exact", head: true }).in("rack_id", rackIds);
  return { racks: rackIds.length, devices: count ?? 0 };
}
```

`countClientCascade` does the same starting from `sites` for that client, and additionally returns `sites: siteIds.length`.

- [ ] **Step 2: Write the scoped integration test**

Create `src/features/clients/repository.integration.test.ts`, mirroring the pattern in `src/features/locations/repository.integration.test.ts` (a `testDb()` reading `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, and a `cleanup()` in `beforeAll` + `afterEach`).

**Cleanup must delete only this test's own clients** — deleting all clients would cascade away the developer's real data. Seed codes prefixed `T-CLI` and clean with `.like("code", "T-CLI%")`:

```ts
async function cleanup() {
  await db.from("clients").delete().like("code", "T-CLI%");
}
```

Cover: create → `listClients` reports `siteCount`/`rackCount`; `getClientByCode` is case-insensitive (`getClientByCode(db, "t-cli-a")` finds `T-CLI-A`); duplicate client code rejects; `listRacksForSite` returns floor/room/type per rack; `countClientCascade` counts the subtree; `deleteClient` cascades its sites away.

- [ ] **Step 3: Run it BY FILENAME ONLY**

```bash
npx vitest run src/features/clients/repository.integration.test.ts
```
Expected: PASS. **Never** run this as part of a directory or glob.

- [ ] **Step 4: Verify the developer's data is untouched**

```bash
docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -t -c "select (select count(*) from clients) clients, (select count(*) from device_templates) templates;"
```
Expected: 0 leftover `T-CLI%` clients; `templates` still 4.

- [ ] **Step 5: Commit**

```bash
git add src/features/clients/repository.ts src/features/clients/repository.integration.test.ts
git commit -m "feat(clients): repository with case-insensitive code lookups and cascade counts"
```

---

### Task 4: Rework the locations layer onto clients

**Files:**
- Modify: `src/features/locations/repository.ts`, `src/features/locations/actions.ts`, `src/features/locations/repository.integration.test.ts`

**Interfaces:**
- Consumes: `createSiteForClient` is NOT used here — this task keeps floor/room/rack creation only.
- Produces: `createSite(db, { clientId, code, name, address? })`; `createRackInSiteAction(formData)` returning `{ ok, error? }`; `getDefaultOrganization`, `listRacksWithPath` and `RackWithPath` **deleted**.

- [ ] **Step 1: Update the repository**

In `src/features/locations/repository.ts`: delete `getDefaultOrganization`, `listRacksWithPath` and the `RackWithPath` interface; change `createSite` to take `clientId` and insert `client_id` instead of looking up the default org. `createFloor`, `createRoom` and `createRack` are unchanged.

- [ ] **Step 2: Update the rack-creation action**

In `src/features/locations/actions.ts`: `findOrCreateSite` is deleted — the site now arrives as a resolved id from the site page. Replace `createRackWithHierarchyAction` with:

```ts
export async function createRackInSiteAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const siteId = String(formData.get("siteId") ?? "");
  const floorCode = normaliseCode(String(formData.get("floorCode") ?? ""));
  const roomCode = normaliseCode(String(formData.get("roomCode") ?? ""));
  const roomType = String(formData.get("roomType") ?? "other") as RoomType;
  const rackCode = normaliseCode(String(formData.get("rackCode") ?? ""));
  const heightU = Number(formData.get("heightU") ?? 0);

  if (!siteId) return { ok: false, error: "Missing site" };
  for (const [name, code] of [["floor", floorCode], ["room", roomCode], ["rack", rackCode]] as const) {
    if (!isValidCode(code)) return { ok: false, error: `Invalid ${name} code` };
  }
  if (!isValidRackHeight(heightU)) return { ok: false, error: "Invalid rack height" };

  const db = createServiceClient();
  try {
    const floor = await findOrCreateFloor(db, siteId, floorCode);
    const room = await findOrCreateRoom(db, floor.id, roomCode, roomType);
    await createRack(db, { roomId: room.id, code: rackCode, heightU });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/clients");
  return { ok: true };
}
```

Floors and rooms stay find-or-create — the spec makes them implicit.

- [ ] **Step 3: Update the locations integration test**

`src/features/locations/repository.integration.test.ts` imports `getDefaultOrganization` and `listRacksWithPath`, both now gone. Seed a `T-LOC` client via `createClient` and pass its id to `createSite`; drop the `listRacksWithPath` assertions. Keep `cleanup()` scoped — delete only `T-LOC%` clients, not all sites.

- [ ] **Step 4: Run it BY FILENAME ONLY**

```bash
npx vitest run src/features/locations/repository.integration.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/locations
git commit -m "refactor(locations): sites belong to clients; rack creation takes a site id"
```

---

### Task 5: Repair every remaining reference to organizations

**Files:**
- Modify: `src/features/racks/repository.integration.test.ts`, `src/features/racks/connectionsRepository.integration.test.ts`, `src/features/racks/actions.integration.test.ts`, `src/features/racks/endpoints.integration.test.ts`
- Modify: `src/features/racks/RackBuilder.test.tsx`, `src/features/racks/AddDevicePicker.test.tsx`, `src/features/racks/ConnectionDetails.test.tsx`
- Modify: `src/features/device-library/repository.ts` and any device-library action still writing `organization_id`

**Interfaces:**
- Consumes: `createClient` (Task 3), `createSite` (Task 4).

- [ ] **Step 1: List what is still broken**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head -30
```
Work the list. Every fix is mechanical, in one of two shapes.

- [ ] **Step 2: Fix the four rack integration tests**

Each calls `getDefaultOrganization(db)` then inserts `{ organization_id: org.id, ... }` for a site and a device template. Replace with a seeded client, and drop `organization_id` from the template insert entirely (the library is global now):

```ts
// was: const org = await getDefaultOrganization(db);
const client = await createClient(db, { code: "T-CONN-CLI", name: "conn repo test" });
// site insert: organization_id: org.id  ->  client_id: client.id
// device_templates insert: drop the organization_id key
```
Use a distinct client code per file (`T-CONN-CLI`, `T-ACT-CLI`, `T-EP-CLI`, `T-RACK-CLI`) and extend each file's existing `cleanup()` to delete its own client by that code.

- [ ] **Step 3: Fix the three unit-test fixtures**

`RackBuilder.test.tsx`, `AddDevicePicker.test.tsx` and `ConnectionDetails.test.tsx` build `DeviceTypeRow`/`BrandRow` literals containing `organization_id`. Delete that property from each fixture. No other change.

- [ ] **Step 4: Fix the device-library layer**

Remove `organization_id` from any select, insert or row type in `src/features/device-library/repository.ts` and its actions (`typeActions.ts` creates device types; check it for an org lookup).

- [ ] **Step 5: Typecheck clean, then run the affected tests BY FILENAME**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
npx vitest run src/features/racks/RackBuilder.test.tsx src/features/racks/AddDevicePicker.test.tsx src/features/racks/ConnectionDetails.test.tsx
npx vitest run src/features/racks/repository.integration.test.ts
npx vitest run src/features/racks/connectionsRepository.integration.test.ts
npx vitest run src/features/racks/actions.integration.test.ts
npx vitest run src/features/racks/endpoints.integration.test.ts
```
Expected: tsc silent; every run PASSES. Run the integration files one at a time, by name.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: drop organization_id across tests and the device library"
```

---

### Task 6: Client and site server actions

**Files:**
- Create: `src/features/clients/actions.ts`

**Interfaces:**
- Consumes: `validateCode`, `normaliseCode` (Task 2); repository writes (Task 3).
- Produces: `createClientAction`, `renameClientAction`, `deleteClientAction`, `createSiteAction`, `renameSiteAction`, `deleteSiteAction`, `deleteRackAction` — each `(formData: FormData) => Promise<{ ok: boolean; error?: string }>`.

- [ ] **Step 1: Implement**

`"use server"` at the top. Each action: read the fields, run `validateCode` and return its message on failure, call the repository inside `try/catch`, `revalidatePath("/clients")`, return `{ ok: true }`.

A duplicate code surfaces as a Postgres unique violation — translate it rather than leaking the raw message:

```ts
function friendly(e: unknown, kind: "client" | "site"): string {
  const msg = e instanceof Error ? e.message : "Unknown error";
  if (/duplicate key|already exists/i.test(msg)) {
    return kind === "client" ? "A client with that code already exists"
                             : "That site code is already used by this client";
  }
  return msg;
}
```

`deleteRackAction` takes `rackId` and deletes from `racks` (cascade handles devices, connections, endpoints).

- [ ] **Step 2: Typecheck**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
```
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add src/features/clients/actions.ts
git commit -m "feat(clients): create/rename/delete actions for clients, sites and racks"
```

---

### Task 7: DeleteDialog

**Files:**
- Create: `src/features/clients/DeleteDialog.tsx`, `src/features/clients/DeleteDialog.test.tsx`

**Interfaces:**
- Consumes: `describeCascade`, `requiresTypedConfirm`, `CascadeCounts` (Task 2).
- Produces: `DeleteDialog` with props `{ open: boolean; kind: "client" | "site" | "rack"; code: string; counts: CascadeCounts; onConfirm: () => void; onCancel: () => void }`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/clients/DeleteDialog.test.tsx`:

```ts
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DeleteDialog } from "./DeleteDialog";

const base = { open: true, kind: "client" as const, code: "ACME", onConfirm: vi.fn(), onCancel: vi.fn() };

describe("DeleteDialog", () => {
  it("spells out what the delete destroys", () => {
    render(<DeleteDialog {...base} counts={{ sites: 3, racks: 7, devices: 41 }} />);
    expect(screen.getByTestId("delete-cascade")).toHaveTextContent("3 sites, 7 racks and 41 devices");
  });

  it("keeps Delete locked until the code is typed exactly", () => {
    render(<DeleteDialog {...base} counts={{ racks: 2 }} />);
    const confirm = screen.getByTestId("delete-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId("delete-code-input"), { target: { value: "acme" } });
    expect(confirm).toBeDisabled();                       // case must match
    fireEvent.change(screen.getByTestId("delete-code-input"), { target: { value: "ACME" } });
    expect(confirm).toBeEnabled();
  });

  it("skips the typing gate entirely when nothing would be destroyed", () => {
    render(<DeleteDialog {...base} counts={{}} />);
    expect(screen.queryByTestId("delete-code-input")).toBeNull();
    expect(screen.getByTestId("delete-confirm")).toBeEnabled();
  });

  it("fires onConfirm only once the gate is satisfied", () => {
    const onConfirm = vi.fn();
    render(<DeleteDialog {...base} counts={{ racks: 1 }} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId("delete-confirm"));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("delete-code-input"), { target: { value: "ACME" } });
    fireEvent.click(screen.getByTestId("delete-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/DeleteDialog.test.tsx
```
Expected: FAIL — cannot resolve `./DeleteDialog`.

- [ ] **Step 3: Implement**

`"use client"`. Render nothing when `open` is false. Required test ids: `delete-cascade`, `delete-code-input` (only when `requiresTypedConfirm(counts)`), `delete-confirm`, `delete-cancel`. The confirm button is `disabled` unless the gate is satisfied. Style it on the modal pattern in `AddDevicePicker.tsx` (`fixed inset-0 z-[70] … bg-black/40`, white rounded panel) with the destructive button in red.

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/features/clients/DeleteDialog.test.tsx
```
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/clients/DeleteDialog.tsx src/features/clients/DeleteDialog.test.tsx
git commit -m "feat(clients): delete dialog gated on typing the code"
```

---

### Task 8: /clients page and ClientsTable

**Files:**
- Create: `src/app/clients/page.tsx`, `src/features/clients/ClientsTable.tsx`, `src/features/clients/ClientsTable.test.tsx`

**Interfaces:**
- Consumes: `listClients` (Task 3); actions (Task 6); `DeleteDialog` (Task 7).
- Produces: `ClientsTable({ clients }: { clients: ClientSummary[] })`.

- [ ] **Step 1: Write the failing tests**

Create `src/features/clients/ClientsTable.test.tsx` covering: each client renders a row linking to `/clients/<code>` showing its site and rack counts; the empty state reads "No clients yet" and still offers the create control. Use `data-testid={`client-row-${c.code}`}`.

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/ClientsTable.test.tsx
```
Expected: FAIL.

- [ ] **Step 3: Implement the table**

`"use client"`. Card table matching `RackDeviceTable.tsx`: columns Client / Code / Sites / Racks / actions. Name links to `/clients/${encodeURIComponent(c.code)}`. Row actions open rename and delete (delete calls `countClientCascade` results already carried on the summary — pass `{ sites: c.siteCount, racks: c.rackCount }` into `DeleteDialog`). A "+ Add client" button opens a small create form posting `createClientAction`.

- [ ] **Step 4: Implement the page**

Create `src/app/clients/page.tsx` as a server component, mirroring `src/app/racks/page.tsx`:

```tsx
import { createServiceClient } from "@/lib/supabase/server";
import { listClients } from "@/features/clients/repository";
import { ClientsTable } from "@/features/clients/ClientsTable";

export const dynamic = "force-dynamic";

export default async function ClientsPage() {
  const db = createServiceClient();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold">Clients</h2>
      <ClientsTable clients={await listClients(db)} />
    </div>
  );
}
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
npx vitest run src/features/clients/ClientsTable.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
```
Expected: PASS; tsc silent.

- [ ] **Step 6: Commit**

```bash
git add src/app/clients/page.tsx src/features/clients/ClientsTable.tsx src/features/clients/ClientsTable.test.tsx
git commit -m "feat(clients): /clients directory listing"
```

---

### Task 9: Client detail page (its sites)

**Files:**
- Create: `src/app/clients/[clientCode]/page.tsx`, `src/features/clients/ClientDetail.tsx`, `src/features/clients/ClientDetail.test.tsx`

**Interfaces:**
- Consumes: `getClientByCode`, `listSitesForClient` (Task 3).
- Produces: `ClientDetail({ client, sites }: { client: ClientRow; sites: SiteSummary[] })`.

- [ ] **Step 1: Write the failing tests**

`ClientDetail.test.tsx`: each site renders a row linking to `/clients/<clientCode>/<siteCode>` with its rack count and address; breadcrumb shows `Clients / <client name>`; the empty state reads "No sites yet".

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/ClientDetail.test.tsx
```
Expected: FAIL.

- [ ] **Step 3: Implement the component and the page**

The page resolves the code and 404s on a miss:

```tsx
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ClientPage({ params }: { params: Promise<{ clientCode: string }> }) {
  const { clientCode } = await params;
  const db = createServiceClient();
  const client = await getClientByCode(db, clientCode);
  if (!client) notFound();
  return <ClientDetail client={client} sites={await listSitesForClient(db, client.id)} />;
}
```

`ClientDetail` carries a breadcrumb (`Clients / {client.name}`), an "+ Add site" control posting `createSiteAction` with a hidden `clientId`, and rename/delete per site.

- [ ] **Step 4: Run the tests and typecheck**

```bash
npx vitest run src/features/clients/ClientDetail.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
```
Expected: PASS; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/app/clients/\[clientCode\] src/features/clients/ClientDetail.tsx src/features/clients/ClientDetail.test.tsx
git commit -m "feat(clients): client detail page listing its sites"
```

---

### Task 10: Site detail page (its racks, grouped by floor · room)

**Files:**
- Create: `src/app/clients/[clientCode]/[siteCode]/page.tsx`, `src/features/clients/SiteDetail.tsx`, `src/features/clients/SiteDetail.test.tsx`

**Interfaces:**
- Consumes: `getClientByCode`, `getSiteByCode`, `listRacksForSite` (Task 3); `createRackInSiteAction` (Task 4).
- Produces: `SiteDetail({ client, site, racks }: { client: ClientRow; site: SiteRow; racks: SiteRackRow[] })`.

- [ ] **Step 1: Write the failing tests**

`SiteDetail.test.tsx` — the grouping is the interesting behaviour, so test it directly:

```ts
const racks = [
  { id: "r1", code: "RK01", heightU: 20, floorCode: "GF", roomCode: "MDF", roomType: "MDF", deviceCount: 3 },
  { id: "r2", code: "RK02", heightU: 42, floorCode: "GF", roomCode: "MDF", roomType: "MDF", deviceCount: 0 },
  { id: "r3", code: "RK03", heightU: 12, floorCode: "L1", roomCode: "IDF", roomType: "IDF", deviceCount: 1 },
];
```
Assert: two group headings render (`GF · MDF`, `L1 · IDF`); `GF · MDF` contains RK01 and RK02; each rack links to `/racks/<id>` (a UUID permalink, NOT a nested URL); the empty state reads "No racks yet".

- [ ] **Step 2: Run and watch it fail**

```bash
npx vitest run src/features/clients/SiteDetail.test.tsx
```
Expected: FAIL.

- [ ] **Step 3: Implement**

Group with a `Map` keyed `${floorCode} · ${roomCode}`, preserving first-seen order. Group heading `data-testid={`rack-group-${floorCode}-${roomCode}`}`. Each rack links to `/racks/${r.id}`. "+ Add rack" posts `createRackInSiteAction` with hidden `siteId` plus floor code, room code, room type and height — the floor/room inputs are `<datalist>`-backed from the site's existing floors/rooms so an existing one is picked rather than retyped.

The page resolves both codes, 404ing on either miss:

```tsx
const client = await getClientByCode(db, clientCode);
if (!client) notFound();
const site = await getSiteByCode(db, client.id, siteCode);
if (!site) notFound();
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
npx vitest run src/features/clients/SiteDetail.test.tsx
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
```
Expected: PASS; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add "src/app/clients/[clientCode]/[siteCode]" src/features/clients/SiteDetail.tsx src/features/clients/SiteDetail.test.tsx
git commit -m "feat(clients): site detail page with racks grouped by floor and room"
```

---

### Task 11: Retire the flat racks list and rewire the sidebar

**Files:**
- Modify: `src/features/shell/AppSidebar.tsx`
- Delete: `src/app/racks/page.tsx`, `src/features/racks/RacksTable.tsx`, `src/features/racks/CreateRackModal.tsx`, and their test files if present

**Interfaces:**
- Consumes: `/clients` (Task 8).

- [ ] **Step 1: Rewire the sidebar**

In `src/features/shell/AppSidebar.tsx`: make Clients a real link and drop the Racks entry.

```tsx
<NavItem icon="tabler:building-community" label="Clients" href="/clients" active={pathname.startsWith("/clients")} />
```
Remove the `<NavItem … label="Racks" href="/racks" … />` line from the second nav group. `/racks/[id]` keeps working — only the list page and its nav entry go.

- [ ] **Step 2: Delete the retired files**

```bash
git rm src/app/racks/page.tsx src/features/racks/RacksTable.tsx src/features/racks/CreateRackModal.tsx
ls src/features/racks/RacksTable.test.tsx 2>/dev/null && git rm src/features/racks/RacksTable.test.tsx
```

- [ ] **Step 3: Typecheck and confirm nothing still imports them**

```bash
./node_modules/.bin/tsc --noEmit 2>&1 | grep "error TS" | head
command grep -rn --include='*.tsx' --include='*.ts' "RacksTable\|CreateRackModal\|listRacksWithPath" src/ | head
```
Expected: tsc silent; grep returns nothing.

- [ ] **Step 4: Full verification by explicit filename**

```bash
npx vitest run src/features/clients/validation.test.ts src/features/clients/DeleteDialog.test.tsx src/features/clients/ClientsTable.test.tsx src/features/clients/ClientDetail.test.tsx src/features/clients/SiteDetail.test.tsx src/features/racks/RackBuilder.test.tsx src/features/racks/RackCanvas.test.tsx src/features/racks/PatchLayer.test.tsx
```
Expected: all PASS.

- [ ] **Step 5: Browser verification**

Start the dev server via the preview tooling (never `npm run dev` in a shell). Then walk the whole path and confirm each step:
1. `/clients` — empty state, create a client `ACME` / "Acme Corp".
2. Open it — create a site `HQ`.
3. Open the site — create a rack `RK01` on floor `GF`, room `MDF`, 20U.
4. Click the rack → the builder opens at `/racks/<uuid>` and works.
5. Sidebar shows Clients (active) and no Racks entry.
6. `/clients/acme` (lowercase) resolves; `/clients/nope` 404s.
7. Delete the client — the dialog names the cascade and stays locked until `ACME` is typed.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(clients): retire the flat racks list; Clients becomes the directory"
```

---

## Self-Review

**Spec coverage:** §3 data model → Task 1. §3.3 codes → Tasks 2, 3. §4 routes → Tasks 8, 9, 10 (rack permalink asserted in Task 10 Step 1). §5 files → Tasks 3, 6–11. §6 deletes → Tasks 6, 7. §7 error handling → Task 6 (`friendly`), Tasks 9/10 (`notFound`). §8 testing → Tasks 2, 3, 7–10, with the by-filename rule repeated in every task that runs a test. §2.1 backup → Task 1 Step 1. Cascade repair of existing tests, not called out in the spec but forced by it → Task 5.

**Placeholder scan:** no TBD/TODO. The two places without literal code — component markup in Tasks 8–10 — are deliberate and bounded by an explicit contract (props, test ids, behaviours) plus a named file to copy the visual language from; this is stated in Global Constraints.

**Type consistency:** `ClientRow`/`SiteRow` (Task 1) flow into Tasks 3, 9, 10. `CascadeCounts` (Task 2) is produced by `countClientCascade`/`countSiteCascade` (Task 3) and consumed by `DeleteDialog` (Task 7). `SiteRackRow` field names (`floorCode`, `roomCode`, `roomType`, `deviceCount`) match between Task 3's interface block and Task 10's fixture. `createRackInSiteAction` is named identically in Tasks 4 and 10.
