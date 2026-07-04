# Phase 2a · Slice 1 — Device Library data model & template management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a working Device Library page where you manage the org's **device types** and **brands**, and create/list/delete **device templates** (metadata only — the visual editor and faceplate come in later slices).

**Architecture:** Extends the merged Phase 1 app. New Supabase tables (`brands`, `device_types`, `device_templates`) scoped by `organization_id`. Pure domain types for the faceplate model live framework-free. A `device-library` repository (takes a Supabase client) is integration-tested against local Supabase. UI is a tabbed Device Library page (Rack Devices / Device Types) with server-component reads and server actions for writes — the same shape as Phase 1's locations feature.

**Tech Stack:** Next.js 16, React 19, TypeScript 5, Tailwind v4, Supabase (`@supabase/supabase-js`), Vitest + React Testing Library.

## Global Constraints

- Versions: Next.js `16.x`, React `19.x`, TypeScript `5.x`, Tailwind `4.x`. Package manager: npm. Path alias `@/*` → `src/*`.
- **Org-scoped, multi-tenant-ready:** every new table carries `organization_id` (FK to `organizations`, cascade). Reuse the seeded `DEFAULT` organization. RLS enabled with the single-org placeholder policy, plus GRANTs for the PostgREST roles (the Phase 1 migration established this pattern — new tables need the same GRANTs or `service_role` gets `42501`).
- **Faceplate model shape** (used verbatim in later slices): `Media`, `CountingDirection`, `Face`, `PortGroup`, `Element` as defined in Task 2.
- **TDD:** failing test first, watch it fail, minimal implementation, watch it pass, commit.
- Local Supabase must be running (`npx supabase start`) for integration tasks; Vitest auto-loads `.env.local` via dotenv (already configured).

---

### Task 1: Migration — brands, device_types, device_templates

**Files:**
- Create: `supabase/migrations/0002_device_library.sql`

**Interfaces:**
- Consumes: `organizations` (seeded `DEFAULT` org from migration 0001).
- Produces: tables `brands`, `device_types`, `device_templates`; a seeded `Generic` brand and a starter set of device types for the default org.

- [ ] **Step 1: Write the migration**

`supabase/migrations/0002_device_library.sql`:
```sql
-- Brands (org-scoped reference list)
create table brands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- Device types (org-scoped reference list; managed on the Device Types tab)
create table device_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- Device templates (authored in the Rack Device Editor; front/back faces are JSON)
create table device_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  brand_id uuid references brands(id) on delete set null,
  device_type_id uuid not null references device_types(id) on delete restrict,
  rack_units int not null default 1 check (rack_units > 0 and rack_units <= 60),
  width_in numeric not null default 19 check (width_in > 0 and width_in <= 30),
  rack_mounted boolean not null default true,
  front_face jsonb,
  back_face jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- RLS: single-org placeholder policies (replace with org-scoped policies when auth lands)
alter table brands enable row level security;
alter table device_types enable row level security;
alter table device_templates enable row level security;
create policy "single_org_all" on brands for all using (true) with check (true);
create policy "single_org_all" on device_types for all using (true) with check (true);
create policy "single_org_all" on device_templates for all using (true) with check (true);

-- Privileges for the PostgREST API roles (same pattern as migration 0001)
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- Seed: a Generic brand and a starter device-type list for the default org
insert into brands (organization_id, name)
  select id, 'Generic' from organizations where code = 'DEFAULT';
insert into device_types (organization_id, name)
  select o.id, t.name
  from organizations o
  cross join (values
    ('Switch'),('Router'),('Firewall'),('Gateway'),('Patch Panel'),
    ('Server'),('UPS'),('PDU'),('KVM'),('Cable Manager'),('Shelf/Tray'),('Other')
  ) as t(name)
  where o.code = 'DEFAULT';
```

- [ ] **Step 2: Apply the migration**

Run: `cd network-doc-platform && npx supabase db reset`
Expected: output ends with "Finished supabase db reset"; migrations 0001 and 0002 both apply with no errors.

- [ ] **Step 3: Verify tables + seed via REST**

Run (use the anon/service key from `npx supabase status`):
```bash
SRK=$(npx supabase status -o env | sed -nE 's/^SERVICE_ROLE_KEY="?([^"]+)"?/\1/p')
curl -s "http://127.0.0.1:54321/rest/v1/device_types?select=name" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
curl -s "http://127.0.0.1:54321/rest/v1/brands?select=name" -H "apikey: $SRK" -H "Authorization: Bearer $SRK"
```
Expected: device_types returns 12 rows (Switch…Other); brands returns `[{"name":"Generic"}]`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0002_device_library.sql
git commit -m "feat: add device library schema (brands, device_types, device_templates)"
```

---

### Task 2: Faceplate domain model

**Files:**
- Create: `src/domain/faceplate.ts`
- Test: `src/domain/faceplate.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `type Media = "copper" | "fiber" | "sfp" | "usb_a" | "usb_c" | "hdmi" | "dp" | "vga" | "ps2" | "audio"`
  - `const MEDIA: Media[]`
  - `type CountingDirection = "ttb" | "btt" | "ltr" | "rtl"`
  - `const CONNECTORS: Record<Media, string[]>` (connector options per media)
  - `interface PortGroup { id: string; media: Media; connectorType: string; idPrefix: string; countingDirection: CountingDirection; rows: number; cols: number; gridX: number; gridY: number; colSpacing: number; rowSpacing: number; portOverrides: Record<number, { name?: string; flipped?: boolean }>; }`
  - `interface TextElement { id: string; kind: "text"; gridX: number; gridY: number; w: number; h: number; content: string; alignment: "left" | "center" | "right"; highlighted: boolean; }`
  - `interface IconElement { id: string; kind: "icon"; gridX: number; gridY: number; w: number; h: number; iconName: string; }`
  - `type FaceElement = TextElement | IconElement`
  - `interface Face { portGroups: PortGroup[]; elements: FaceElement[]; }`
  - `function emptyFace(): Face`
  - `function isValidWidthIn(n: number): boolean` (> 0 and <= 30)
  - `function isValidRackUnits(n: number): boolean` (integer, > 0, <= 60)

- [ ] **Step 1: Write the failing test**

`src/domain/faceplate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { MEDIA, CONNECTORS, emptyFace, isValidWidthIn, isValidRackUnits } from "./faceplate";

describe("faceplate domain", () => {
  it("lists all ten media types", () => {
    expect(MEDIA).toEqual(["copper","fiber","sfp","usb_a","usb_c","hdmi","dp","vga","ps2","audio"]);
  });
  it("maps connector options per media", () => {
    expect(CONNECTORS.copper).toContain("RJ45");
    expect(CONNECTORS.sfp).toContain("SFP+");
    expect(CONNECTORS.fiber).toContain("LC");
    // every media has at least one connector option
    for (const m of MEDIA) expect(CONNECTORS[m].length).toBeGreaterThan(0);
  });
  it("emptyFace has no groups or elements", () => {
    expect(emptyFace()).toEqual({ portGroups: [], elements: [] });
  });
  it("validates width in inches (0 < w <= 30)", () => {
    expect(isValidWidthIn(19)).toBe(true);
    expect(isValidWidthIn(10.6)).toBe(true);
    expect(isValidWidthIn(0)).toBe(false);
    expect(isValidWidthIn(31)).toBe(false);
  });
  it("validates rack units (int, 1..60)", () => {
    expect(isValidRackUnits(1)).toBe(true);
    expect(isValidRackUnits(0)).toBe(false);
    expect(isValidRackUnits(1.5)).toBe(false);
    expect(isValidRackUnits(61)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- faceplate`
Expected: FAIL — cannot find module `./faceplate`.

- [ ] **Step 3: Write minimal implementation**

`src/domain/faceplate.ts`:
```ts
export type Media =
  | "copper" | "fiber" | "sfp" | "usb_a" | "usb_c"
  | "hdmi" | "dp" | "vga" | "ps2" | "audio";

export const MEDIA: Media[] = [
  "copper", "fiber", "sfp", "usb_a", "usb_c",
  "hdmi", "dp", "vga", "ps2", "audio",
];

export type CountingDirection = "ttb" | "btt" | "ltr" | "rtl";

export const CONNECTORS: Record<Media, string[]> = {
  copper: ["RJ45", "RJ11", "Keystone"],
  fiber: ["LC", "SC", "ST", "MPO-MTP"],
  sfp: ["SFP", "SFP+", "SFP28", "QSFP", "QSFP+"],
  usb_a: ["USB-A"],
  usb_c: ["USB-C"],
  hdmi: ["HDMI"],
  dp: ["DisplayPort"],
  vga: ["VGA"],
  ps2: ["PS/2"],
  audio: ["3.5mm"],
};

export interface PortGroup {
  id: string;
  media: Media;
  connectorType: string;
  idPrefix: string;
  countingDirection: CountingDirection;
  rows: number;
  cols: number;
  gridX: number;
  gridY: number;
  colSpacing: number;
  rowSpacing: number;
  portOverrides: Record<number, { name?: string; flipped?: boolean }>;
}

export interface TextElement {
  id: string;
  kind: "text";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  content: string;
  alignment: "left" | "center" | "right";
  highlighted: boolean;
}

export interface IconElement {
  id: string;
  kind: "icon";
  gridX: number;
  gridY: number;
  w: number;
  h: number;
  iconName: string;
}

export type FaceElement = TextElement | IconElement;

export interface Face {
  portGroups: PortGroup[];
  elements: FaceElement[];
}

export function emptyFace(): Face {
  return { portGroups: [], elements: [] };
}

export function isValidWidthIn(n: number): boolean {
  return typeof n === "number" && n > 0 && n <= 30;
}

export function isValidRackUnits(n: number): boolean {
  return Number.isInteger(n) && n > 0 && n <= 60;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- faceplate`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/domain/faceplate.ts src/domain/faceplate.test.ts
git commit -m "feat: add faceplate domain model (media, connectors, Face types, validators)"
```

---

### Task 3: Device-library repository

**Files:**
- Create: `src/features/device-library/repository.ts`
- Test: `src/features/device-library/repository.integration.test.ts`

**Interfaces:**
- Consumes: `getDefaultOrganization` (Phase 1, `@/features/locations/repository`); `Face` (Task 2); `SupabaseClient`.
- Produces (all take `db: SupabaseClient` first):
  - Row types `BrandRow`, `DeviceTypeRow`, `DeviceTemplateRow` and view type `DeviceTemplateListRow { id: string; name: string; brandName: string | null; typeName: string; rackUnits: number; widthIn: number; rackMounted: boolean; }`
  - `listDeviceTypes(db): Promise<DeviceTypeRow[]>`
  - `createDeviceType(db, { name }): Promise<DeviceTypeRow>`
  - `deleteDeviceType(db, id): Promise<void>`
  - `listBrands(db): Promise<BrandRow[]>`
  - `createBrand(db, { name }): Promise<BrandRow>`
  - `listDeviceTemplates(db): Promise<DeviceTemplateListRow[]>`
  - `createDeviceTemplate(db, { name, deviceTypeId, brandId?, rackUnits?, widthIn?, rackMounted? }): Promise<DeviceTemplateRow>`
  - `deleteDeviceTemplate(db, id): Promise<void>`

- [ ] **Step 1: Write the failing integration test**

`src/features/device-library/repository.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  listDeviceTypes, createDeviceType, deleteDeviceType,
  listBrands, createBrand,
  listDeviceTemplates, createDeviceTemplate, deleteDeviceTemplate,
} from "./repository";

function testDb(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
const db = testDb();

async function cleanup() {
  await db.from("device_templates").delete().neq("name", "");
  await db.from("device_types").delete().eq("name", "ZZ Test Type");
  await db.from("brands").delete().eq("name", "ZZ Test Brand");
}

describe("device-library repository (integration)", () => {
  beforeAll(cleanup);
  afterEach(cleanup);

  it("lists the seeded device types", async () => {
    const types = await listDeviceTypes(db);
    expect(types.map((t) => t.name)).toContain("Switch");
  });

  it("lists the seeded Generic brand", async () => {
    const brands = await listBrands(db);
    expect(brands.map((b) => b.name)).toContain("Generic");
  });

  it("creates and lists a template with brand + type names", async () => {
    const type = await createDeviceType(db, { name: "ZZ Test Type" });
    const brand = await createBrand(db, { name: "ZZ Test Brand" });
    const tpl = await createDeviceTemplate(db, {
      name: "ZZ Test Device", deviceTypeId: type.id, brandId: brand.id,
      rackUnits: 1, widthIn: 10.6, rackMounted: true,
    });
    expect(tpl.width_in).toBe(10.6);

    const list = await listDeviceTemplates(db);
    const row = list.find((r) => r.id === tpl.id)!;
    expect(row.name).toBe("ZZ Test Device");
    expect(row.typeName).toBe("ZZ Test Type");
    expect(row.brandName).toBe("ZZ Test Brand");
    expect(row.widthIn).toBe(10.6);

    await deleteDeviceTemplate(db, tpl.id);
    expect((await listDeviceTemplates(db)).find((r) => r.id === tpl.id)).toBeUndefined();
    await deleteDeviceType(db, type.id);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- device-library/repository`
Expected: FAIL — cannot find module `./repository`.

- [ ] **Step 3: Write minimal implementation**

`src/features/device-library/repository.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDefaultOrganization } from "@/features/locations/repository";

export interface BrandRow { id: string; organization_id: string; name: string; created_at: string; }
export interface DeviceTypeRow { id: string; organization_id: string; name: string; created_at: string; }
export interface DeviceTemplateRow {
  id: string; organization_id: string; name: string;
  brand_id: string | null; device_type_id: string;
  rack_units: number; width_in: number; rack_mounted: boolean;
  front_face: unknown | null; back_face: unknown | null;
  created_at: string; updated_at: string;
}
export interface DeviceTemplateListRow {
  id: string; name: string; brandName: string | null; typeName: string;
  rackUnits: number; widthIn: number; rackMounted: boolean;
}

export async function listDeviceTypes(db: SupabaseClient): Promise<DeviceTypeRow[]> {
  const { data, error } = await db.from("device_types").select("*").order("name");
  if (error) throw new Error(`listDeviceTypes: ${error.message}`);
  return data as DeviceTypeRow[];
}

export async function createDeviceType(db: SupabaseClient, input: { name: string }): Promise<DeviceTypeRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db.from("device_types")
    .insert({ organization_id: org.id, name: input.name }).select("*").single();
  if (error) throw new Error(`createDeviceType: ${error.message}`);
  return data as DeviceTypeRow;
}

export async function deleteDeviceType(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("device_types").delete().eq("id", id);
  if (error) throw new Error(`deleteDeviceType: ${error.message}`);
}

export async function listBrands(db: SupabaseClient): Promise<BrandRow[]> {
  const { data, error } = await db.from("brands").select("*").order("name");
  if (error) throw new Error(`listBrands: ${error.message}`);
  return data as BrandRow[];
}

export async function createBrand(db: SupabaseClient, input: { name: string }): Promise<BrandRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db.from("brands")
    .insert({ organization_id: org.id, name: input.name }).select("*").single();
  if (error) throw new Error(`createBrand: ${error.message}`);
  return data as BrandRow;
}

interface TemplateJoinRow {
  id: string; name: string; rack_units: number; width_in: number; rack_mounted: boolean;
  brands: { name: string } | null;
  device_types: { name: string };
}

export async function listDeviceTemplates(db: SupabaseClient): Promise<DeviceTemplateListRow[]> {
  const { data, error } = await db.from("device_templates")
    .select("id, name, rack_units, width_in, rack_mounted, brands(name), device_types!inner(name)")
    .order("name");
  if (error) throw new Error(`listDeviceTemplates: ${error.message}`);
  const rows = (data ?? []) as unknown as TemplateJoinRow[];
  return rows.map((r) => ({
    id: r.id, name: r.name,
    brandName: r.brands ? r.brands.name : null,
    typeName: r.device_types.name,
    rackUnits: r.rack_units, widthIn: r.width_in, rackMounted: r.rack_mounted,
  }));
}

export async function createDeviceTemplate(
  db: SupabaseClient,
  input: { name: string; deviceTypeId: string; brandId?: string; rackUnits?: number; widthIn?: number; rackMounted?: boolean },
): Promise<DeviceTemplateRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db.from("device_templates").insert({
    organization_id: org.id,
    name: input.name,
    device_type_id: input.deviceTypeId,
    brand_id: input.brandId ?? null,
    rack_units: input.rackUnits ?? 1,
    width_in: input.widthIn ?? 19,
    rack_mounted: input.rackMounted ?? true,
  }).select("*").single();
  if (error) throw new Error(`createDeviceTemplate: ${error.message}`);
  return data as DeviceTemplateRow;
}

export async function deleteDeviceTemplate(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db.from("device_templates").delete().eq("id", id);
  if (error) throw new Error(`deleteDeviceTemplate: ${error.message}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- device-library/repository`
Expected: PASS — 3 tests pass (local Supabase running).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/repository.ts src/features/device-library/repository.integration.test.ts
git commit -m "feat: add device-library repository (types, brands, templates CRUD)"
```

---

### Task 4: Device Library page — Rack Devices tab (list + create)

**Files:**
- Create: `src/features/device-library/actions.ts`
- Create: `src/features/device-library/RackDeviceTable.tsx`
- Test: `src/features/device-library/RackDeviceTable.test.tsx`
- Create: `src/features/device-library/CreateDeviceForm.tsx`
- Create: `src/app/device-library/page.tsx`

**Interfaces:**
- Consumes: repository functions + `DeviceTemplateListRow`, `DeviceTypeRow`, `BrandRow` (Task 3); `createServiceClient` (`@/lib/supabase/server`); `isValidWidthIn`, `isValidRackUnits` (Task 2).
- Produces:
  - `RackDeviceTable({ rows }: { rows: DeviceTemplateListRow[] })` — client component: search box filtering on `name`, columns Name / Brand / Type / Rack units.
  - Server actions in `actions.ts`: `createDeviceTemplateAction(formData): Promise<{ ok: boolean; error?: string }>`, `deleteDeviceTemplateAction(id): Promise<void>`.

- [ ] **Step 1: Write the failing component test**

`src/features/device-library/RackDeviceTable.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackDeviceTable } from "./RackDeviceTable";
import type { DeviceTemplateListRow } from "./repository";

const rows: DeviceTemplateListRow[] = [
  { id: "1", name: "48xCAT 4xSFP", brandName: "Generic", typeName: "Switch", rackUnits: 1, widthIn: 19, rackMounted: true },
  { id: "2", name: "Mini Patch 12", brandName: null, typeName: "Patch Panel", rackUnits: 1, widthIn: 10.6, rackMounted: true },
];

describe("RackDeviceTable", () => {
  it("renders a row per template", () => {
    render(<RackDeviceTable rows={rows} />);
    expect(screen.getByText("48xCAT 4xSFP")).toBeInTheDocument();
    expect(screen.getByText("Mini Patch 12")).toBeInTheDocument();
  });
  it("filters by search", async () => {
    render(<RackDeviceTable rows={rows} />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), "Patch");
    expect(screen.queryByText("48xCAT 4xSFP")).not.toBeInTheDocument();
    expect(screen.getByText("Mini Patch 12")).toBeInTheDocument();
  });
  it("shows an em dash when brand is null", () => {
    render(<RackDeviceTable rows={[rows[1]]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- RackDeviceTable`
Expected: FAIL — cannot find module `./RackDeviceTable`.

- [ ] **Step 3: Write the table component**

`src/features/device-library/RackDeviceTable.tsx`:
```tsx
"use client";

import { useMemo, useState } from "react";
import type { DeviceTemplateListRow } from "./repository";

export function RackDeviceTable({ rows }: { rows: DeviceTemplateListRow[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => rows.filter((r) => r.name.toLowerCase().includes(query.toLowerCase())),
    [rows, query],
  );
  return (
    <div className="space-y-3">
      <input
        className="w-full max-w-sm rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        placeholder="Search devices…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <table className="w-full text-left text-sm">
        <thead className="text-neutral-400">
          <tr><th className="p-2">Name</th><th className="p-2">Brand</th><th className="p-2">Type</th><th className="p-2">Rack units</th></tr>
        </thead>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.id} className="border-t border-neutral-800">
              <td className="p-2 font-medium">{r.name}</td>
              <td className="p-2">{r.brandName ?? "—"}</td>
              <td className="p-2">{r.typeName}</td>
              <td className="p-2">{r.rackUnits} RU</td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && <p className="text-sm text-neutral-500">No devices yet. Create one above.</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- RackDeviceTable`
Expected: PASS — 3 tests pass.

- [ ] **Step 5: Write the server actions**

`src/features/device-library/actions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidWidthIn, isValidRackUnits } from "@/domain/faceplate";
import { createDeviceTemplate, deleteDeviceTemplate } from "./repository";

export async function createDeviceTemplateAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const name = String(formData.get("name") ?? "").trim();
  const deviceTypeId = String(formData.get("deviceTypeId") ?? "");
  const brandId = String(formData.get("brandId") ?? "");
  const rackUnits = Number(formData.get("rackUnits") ?? 1);
  const widthIn = Number(formData.get("widthIn") ?? 19);
  const rackMounted = formData.get("rackMounted") === "on";

  if (!name) return { ok: false, error: "Name is required" };
  if (!deviceTypeId) return { ok: false, error: "Device type is required" };
  if (!isValidRackUnits(rackUnits)) return { ok: false, error: "Invalid rack units" };
  if (!isValidWidthIn(widthIn)) return { ok: false, error: "Invalid width" };

  const db = createServiceClient();
  try {
    await createDeviceTemplate(db, {
      name, deviceTypeId, brandId: brandId || undefined, rackUnits, widthIn, rackMounted,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/device-library");
  return { ok: true };
}

export async function deleteDeviceTemplateAction(id: string): Promise<void> {
  const db = createServiceClient();
  await deleteDeviceTemplate(db, id);
  revalidatePath("/device-library");
}
```

- [ ] **Step 6: Write the create form**

`src/features/device-library/CreateDeviceForm.tsx`:
```tsx
"use client";

import { useState } from "react";
import type { DeviceTypeRow, BrandRow } from "./repository";
import { createDeviceTemplateAction } from "./actions";

export function CreateDeviceForm({ types, brands }: { types: DeviceTypeRow[]; brands: BrandRow[] }) {
  const [error, setError] = useState<string | null>(null);
  async function action(formData: FormData) {
    setError(null);
    const res = await createDeviceTemplateAction(formData);
    if (!res.ok) setError(res.error ?? "Failed");
  }
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <input name="name" placeholder="Device name" className="input" required />
      <select name="deviceTypeId" className="input" required defaultValue="">
        <option value="" disabled>Device type…</option>
        {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
      <select name="brandId" className="input" defaultValue="">
        <option value="">Brand (optional)</option>
        {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
      <input name="rackUnits" type="number" min={1} defaultValue={1} className="input w-20" title="Rack units" />
      <input name="widthIn" type="number" step="0.1" min={1} defaultValue={19} className="input w-24" title="Width (in)" />
      <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="rackMounted" defaultChecked /> Rack mounted</label>
      <button type="submit" className="rounded bg-blue-600 px-3 py-2 text-sm text-white">Create</button>
      {error && <span className="text-sm text-red-400">{error}</span>}
    </form>
  );
}
```

- [ ] **Step 7: Write the Device Library page (Rack Devices tab)**

`src/app/device-library/page.tsx`:
```tsx
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTemplates, listDeviceTypes, listBrands } from "@/features/device-library/repository";
import { RackDeviceTable } from "@/features/device-library/RackDeviceTable";
import { CreateDeviceForm } from "@/features/device-library/CreateDeviceForm";

export const dynamic = "force-dynamic";

export default async function DeviceLibraryPage() {
  const db = createServiceClient();
  const [rows, types, brands] = await Promise.all([
    listDeviceTemplates(db), listDeviceTypes(db), listBrands(db),
  ]);
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Device Library</h1>
        <nav className="mt-3 flex gap-2 border-b border-neutral-800 text-sm">
          <span className="rounded-t bg-neutral-800 px-3 py-2 font-semibold">Rack Devices</span>
          <Link href="/device-library/types" className="px-3 py-2 text-neutral-400">Device Types</Link>
        </nav>
      </header>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Custom Rack Devices</h2>
        <CreateDeviceForm types={types} brands={brands} />
        <RackDeviceTable rows={rows} />
      </section>
    </main>
  );
}
```

- [ ] **Step 8: Run the full suite + build**

Run: `npm test` then `npm run build`
Expected: all tests pass (faceplate, device-library integration, RackDeviceTable, plus Phase 1 suites); build compiles with a `/device-library` route.

- [ ] **Step 9: Manually verify**

Run: `npm run dev`, open `http://localhost:3000/device-library`, create a device (name `Test`, type `Switch`, width `10.6`).
Expected: the row appears in the table; searching `Test` keeps it, `zzz` empties it.

- [ ] **Step 10: Commit**

```bash
git add src/features/device-library/ src/app/device-library/page.tsx
git commit -m "feat: device library page with rack-devices list and create form"
```

---

### Task 5: Device Types tab (list + add + delete)

**Files:**
- Create: `src/features/device-library/typeActions.ts`
- Create: `src/features/device-library/DeviceTypesPanel.tsx`
- Test: `src/features/device-library/DeviceTypesPanel.test.tsx`
- Create: `src/app/device-library/types/page.tsx`

**Interfaces:**
- Consumes: `listDeviceTypes`, `createDeviceType`, `deleteDeviceType`, `DeviceTypeRow` (Task 3); `createServiceClient`.
- Produces:
  - `DeviceTypesPanel({ types }: { types: DeviceTypeRow[] })` — client component: lists type names, an add-form input, and a delete button per type that calls the action.
  - `typeActions.ts`: `createDeviceTypeAction(formData): Promise<{ ok: boolean; error?: string }>`, `deleteDeviceTypeAction(id): Promise<void>`.

- [ ] **Step 1: Write the failing component test**

`src/features/device-library/DeviceTypesPanel.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeviceTypesPanel } from "./DeviceTypesPanel";
import type { DeviceTypeRow } from "./repository";

const types: DeviceTypeRow[] = [
  { id: "1", organization_id: "o", name: "Switch", created_at: "" },
  { id: "2", organization_id: "o", name: "Router", created_at: "" },
];

describe("DeviceTypesPanel", () => {
  it("renders each device type and an add input", () => {
    render(<DeviceTypesPanel types={types} />);
    expect(screen.getByText("Switch")).toBeInTheDocument();
    expect(screen.getByText("Router")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/new device type/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- DeviceTypesPanel`
Expected: FAIL — cannot find module `./DeviceTypesPanel`.

- [ ] **Step 3: Write the actions**

`src/features/device-library/typeActions.ts`:
```ts
"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { createDeviceType, deleteDeviceType } from "./repository";

export async function createDeviceTypeAction(
  formData: FormData,
): Promise<{ ok: boolean; error?: string }> {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required" };
  const db = createServiceClient();
  try {
    await createDeviceType(db, { name });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath("/device-library/types");
  return { ok: true };
}

export async function deleteDeviceTypeAction(id: string): Promise<void> {
  const db = createServiceClient();
  await deleteDeviceType(db, id);
  revalidatePath("/device-library/types");
}
```

- [ ] **Step 4: Write the panel component**

`src/features/device-library/DeviceTypesPanel.tsx`:
```tsx
"use client";

import { useState } from "react";
import type { DeviceTypeRow } from "./repository";
import { createDeviceTypeAction, deleteDeviceTypeAction } from "./typeActions";

export function DeviceTypesPanel({ types }: { types: DeviceTypeRow[] }) {
  const [error, setError] = useState<string | null>(null);
  async function add(formData: FormData) {
    setError(null);
    const res = await createDeviceTypeAction(formData);
    if (!res.ok) setError(res.error ?? "Failed");
  }
  return (
    <div className="space-y-4">
      <form action={add} className="flex items-end gap-2">
        <input name="name" placeholder="New device type…" className="input" required />
        <button type="submit" className="rounded bg-blue-600 px-3 py-2 text-sm text-white">Add</button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </form>
      <ul className="divide-y divide-neutral-800">
        {types.map((t) => (
          <li key={t.id} className="flex items-center justify-between py-2 text-sm">
            <span>{t.name}</span>
            <button
              onClick={() => deleteDeviceTypeAction(t.id)}
              className="text-xs text-red-400"
              title="Delete (blocked if in use)"
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- DeviceTypesPanel`
Expected: PASS.

- [ ] **Step 6: Write the Device Types page**

`src/app/device-library/types/page.tsx`:
```tsx
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTypes } from "@/features/device-library/repository";
import { DeviceTypesPanel } from "@/features/device-library/DeviceTypesPanel";

export const dynamic = "force-dynamic";

export default async function DeviceTypesPage() {
  const db = createServiceClient();
  const types = await listDeviceTypes(db);
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Device Library</h1>
        <nav className="mt-3 flex gap-2 border-b border-neutral-800 text-sm">
          <Link href="/device-library" className="px-3 py-2 text-neutral-400">Rack Devices</Link>
          <span className="rounded-t bg-neutral-800 px-3 py-2 font-semibold">Device Types</span>
        </nav>
      </header>
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Device Types</h2>
        <DeviceTypesPanel types={types} />
      </section>
    </main>
  );
}
```

- [ ] **Step 7: Run the full suite + build**

Run: `npm test` then `npm run build`
Expected: all tests pass; build compiles with `/device-library` and `/device-library/types` routes.

- [ ] **Step 8: Manually verify**

Run: `npm run dev`, open `http://localhost:3000/device-library/types`, add a type `TestType`, confirm it appears; delete it.
Expected: add/list/delete work; deleting a type that has templates surfaces a Postgres restrict error (expected — deletion is blocked while in use).

- [ ] **Step 9: Commit**

```bash
git add src/features/device-library/typeActions.ts src/features/device-library/DeviceTypesPanel.tsx src/features/device-library/DeviceTypesPanel.test.tsx src/app/device-library/types/page.tsx
git commit -m "feat: device types tab (list, add, delete)"
```

---

## Self-Review

**Spec coverage (Slice 1 subset):**
- §3 IA (Device Library, Rack Devices + Device Types tabs, org-level) → Tasks 4, 5. ✓
- §4.1 header fields (Name, Brand, Device type, Rack units, Width) → captured in the create form (Task 4); the full editor is Slice 3. ✓
- §6 data model (`brands`, `device_types`, `device_templates` with `width_in`, `rack_mounted`, front/back face JSON) → Task 1; `Face`/`PortGroup`/`Element` types → Task 2. ✓
- §10 delete-type-in-use blocked → `on delete restrict` (Task 1) verified in Task 5 Step 8. ✓
- §11 testing (unit + integration + component) → Tasks 2, 3, 4, 5. ✓
- Deferred to later slices (correctly out of this plan): SVG faceplate renderer + rack-mount geometry (Slice 2), the editor modal / palette / port-group build / spacing / flip (Slice 3), Text/Icon elements + icon picker (Slice 4).

**Placeholder scan:** No TBD/TODO; every code step contains complete code. ✓

**Type consistency:** `DeviceTemplateListRow`, `DeviceTypeRow`, `BrandRow`, `Face`, `Media`, `createDeviceTemplate`/`listDeviceTemplates` signatures, and the `{ ok, error? }` action contract are defined once (Tasks 2, 3) and consumed with identical shapes in Tasks 4, 5. ✓

**Note:** `front_face`/`back_face` columns exist now (Task 1) but are written by the editor in Slice 3; Slice 1 leaves them null, which is valid.
