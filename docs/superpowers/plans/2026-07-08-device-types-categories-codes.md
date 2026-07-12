# Device Types Categories & Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the two-column Device Types manager (floor/rack categories, ID-prefix codes, standard vs custom) and bring the Rack Devices table to PatchDocs parity (duplicate/edit/delete actions + read-only template view).

**Architecture:** Single `device_types` table gains `category`/`code`/`is_standard` via migration 0003. Pure validation rules live in a tiny TDD'd module; thin Supabase repository functions enforce standard-type guards; server actions map DB errors to friendly text. The existing preview UI (`DeviceTypesManager`) is wired to props + actions; the table and editor gain small props (`onDuplicate`/`onDelete`/`onView`, `readOnly`).

**Tech Stack:** Next.js 16 (app router, server actions), Supabase (local via `npx supabase start`), Vitest + @testing-library/react, TypeScript, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-08-device-types-categories-codes-design.md`

## Global Constraints

- Code ("ID prefix") rule, verbatim: **1–4 characters, uppercase letters and numbers only. Must be unique across all device type ID prefixes.** (regex `^[A-Z0-9]{1,4}$`, unique per organization across BOTH categories.)
- Standard types: code editable only, never deletable. Custom types: name+code editable, deletable (FK `on delete restrict` blocks in-use).
- Custom-type creation happens in a modal (Name* + ID prefix* + helper text), persisting immediately on Create.
- Read-only editor banner text, verbatim: **You are viewing this custom rack device in read-only mode.**
- Empty custom state, verbatim: **Click "Add" to create your first custom device type.**
- All commits end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Run all commands from `/Users/reubensingh/development/network-doc-platform` (cwd resets between shells — `cd` first).
- Before finishing any task: `npx tsc --noEmit` clean + `npm test` green.

---

### Task 1: Pure code/name rules (`deviceTypeRules.ts`)

**Files:**
- Create: `src/features/device-library/deviceTypeRules.ts`
- Test: `src/features/device-library/deviceTypeRules.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CODE_HELP: string`; `normalizeCode(raw: string): string`; `validateCode(code: string): string | null`; `validateTypeName(name: string): string | null`. Used by Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

```ts
// src/features/device-library/deviceTypeRules.test.ts
import { describe, it, expect } from "vitest";
import { normalizeCode, validateCode, validateTypeName, CODE_HELP } from "./deviceTypeRules";

describe("normalizeCode", () => {
  it("uppercases, strips non-alphanumerics, and caps at 4 chars", () => {
    expect(normalizeCode("sw")).toBe("SW");
    expect(normalizeCode(" 3d-p! ")).toBe("3DP");
    expect(normalizeCode("switch")).toBe("SWIT");
  });
});

describe("validateCode", () => {
  it("accepts 1-4 uppercase alphanumerics", () => {
    expect(validateCode("SW")).toBeNull();
    expect(validateCode("3DP")).toBeNull();
    expect(validateCode("MISC")).toBeNull();
  });
  it("rejects empty, too-long, lowercase, and symbols", () => {
    expect(validateCode("")).toBe(CODE_HELP);
    expect(validateCode("TOOLONG")).toBe(CODE_HELP);
    expect(validateCode("sw")).toBe(CODE_HELP);
    expect(validateCode("S-W")).toBe(CODE_HELP);
  });
});

describe("validateTypeName", () => {
  it("requires a non-blank name", () => {
    expect(validateTypeName("Media Converter")).toBeNull();
    expect(validateTypeName("   ")).toBe("Name is required");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/reubensingh/development/network-doc-platform && npm test deviceTypeRules`
Expected: FAIL — cannot resolve `./deviceTypeRules`.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/device-library/deviceTypeRules.ts
// Pure rules for device-type codes ("ID prefixes") and names. Codes prefix generated device IDs
// (SW01, SW02, ...) so they must be short, uppercase, and unique — see the design spec.

export const CODE_RULE = /^[A-Z0-9]{1,4}$/;

export const CODE_HELP =
  "1–4 characters, uppercase letters and numbers only. Must be unique across all device type ID prefixes.";

/** Coerce raw input toward a valid code: uppercase, alphanumerics only, max 4 chars. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

/** Null when valid, else the helper message (also used as the inline error). */
export function validateCode(code: string): string | null {
  return CODE_RULE.test(code) ? null : CODE_HELP;
}

export function validateTypeName(name: string): string | null {
  return name.trim() ? null : "Name is required";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test deviceTypeRules`
Expected: 3 test groups PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/deviceTypeRules.ts src/features/device-library/deviceTypeRules.test.ts
git commit -m "device types: pure code/name validation rules

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Migration 0003 + repository layer

**Files:**
- Create: `supabase/migrations/0003_device_type_categories.sql`
- Modify: `src/features/device-library/repository.ts` (DeviceTypeRow interface ~line 6; createDeviceType ~line 25; deleteDeviceType ~line 33; add getDeviceType/updateDeviceType)

**Interfaces:**
- Consumes: existing `getDefaultOrganization(db)` from `@/features/locations/repository`.
- Produces (used by Task 3):
  - `DeviceTypeRow` gains `category: "floor" | "rack"; code: string; is_standard: boolean;`
  - `createDeviceType(db, { name, code, category }): Promise<DeviceTypeRow>` (always custom)
  - `updateDeviceType(db, id, { name?, code? }): Promise<void>` — standard rows apply `code` only
  - `deleteDeviceType(db, id): Promise<void>` — throws `"Standard device types cannot be deleted"` for standard rows

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0003_device_type_categories.sql
-- Device types gain a floor/rack category, an ID-prefix code, and a standard flag.
-- Codes are the default ID prefixes for placed devices (SW01, SW02, ...).

alter table device_types
  add column category text not null default 'rack' check (category in ('floor','rack')),
  add column code text not null default '',
  add column is_standard boolean not null default false;

-- Names only need to be unique within their category (the floor list contains "Rack").
alter table device_types drop constraint device_types_organization_id_name_key;
alter table device_types add constraint device_types_org_category_name_key
  unique (organization_id, category, name);

-- Backfill: the 12 seeded rack types become standard, with our agreed codes.
update device_types set is_standard = true, code = c.code
from (values
  ('Switch','SW'),('Router','RT'),('Firewall','FW'),('Gateway','GW'),
  ('Patch Panel','PP'),('Server','SRV'),('UPS','UPS'),('PDU','PDU'),
  ('KVM','KVM'),('Cable Manager','CM'),('Shelf/Tray','ST'),('Other','OTH')
) as c(name, code)
where device_types.name = c.name and device_types.category = 'rack';

-- Seed the 12 standard floor types (codes from the PatchDocs reference).
insert into device_types (organization_id, name, category, code, is_standard)
select o.id, t.name, 'floor', t.code, true
from organizations o
cross join (values
  ('Access Control Panel','ACP'),('Access Point','AP'),('Camera','CAM'),
  ('Desktop','DP'),('Telecommunications Outlet','TO'),('ISP Uplink','ISP'),
  ('Laptop','LP'),('Phone','PH'),('Printer','PR'),('3D Printer','3DP'),
  ('Rack','RK'),('Screen','SCR')
) as t(name, code)
where o.code = 'DEFAULT';

-- Any pre-existing user-created types (created before codes existed) get X001, X002, ...
with bad as (
  select id, row_number() over (order by created_at) as rn
  from device_types where code !~ '^[A-Z0-9]{1,4}$'
)
update device_types set code = 'X' || lpad(bad.rn::text, 3, '0')
from bad where device_types.id = bad.id;

-- Enforce the code rules only after every row satisfies them.
alter table device_types add constraint device_types_code_format_check
  check (code ~ '^[A-Z0-9]{1,4}$');
alter table device_types add constraint device_types_org_code_key
  unique (organization_id, code);
```

- [ ] **Step 2: Apply it locally**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx supabase migration up`
Expected: `Applying migration 0003_device_type_categories.sql...` then success. (If Supabase isn't running: `npx supabase start` first. If the local DB has drifted, `npx supabase db reset` reapplies all three migrations + seeds.)

Verify: `npx supabase db execute --sql "select category, count(*) from device_types group by category"` (psql fallback: `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -c "..."`)
Expected: `floor 12`, `rack 12` (plus any pre-existing customs).

- [ ] **Step 3: Update the repository**

In `src/features/device-library/repository.ts`, replace the `DeviceTypeRow` interface and the three type functions:

```ts
export interface DeviceTypeRow {
  id: string; organization_id: string; name: string; created_at: string;
  category: "floor" | "rack";
  code: string;          // ID prefix for generated device IDs (SW01, ...)
  is_standard: boolean;  // seeded by us: code editable, never deletable
}
```

```ts
export async function createDeviceType(
  db: SupabaseClient,
  input: { name: string; code: string; category: "floor" | "rack" },
): Promise<DeviceTypeRow> {
  const org = await getDefaultOrganization(db);
  const { data, error } = await db.from("device_types")
    .insert({
      organization_id: org.id, name: input.name, code: input.code,
      category: input.category, is_standard: false,
    })
    .select("*").single();
  if (error) throw new Error(`createDeviceType: ${error.message}`);
  return data as DeviceTypeRow;
}

async function getDeviceType(db: SupabaseClient, id: string): Promise<DeviceTypeRow> {
  const { data, error } = await db.from("device_types").select("*").eq("id", id).single();
  if (error) throw new Error(`getDeviceType: ${error.message}`);
  return data as DeviceTypeRow;
}

/** Standard types accept a code change only; custom types accept name and/or code. */
export async function updateDeviceType(
  db: SupabaseClient, id: string, patch: { name?: string; code?: string },
): Promise<void> {
  const row = await getDeviceType(db, id);
  const applied = row.is_standard
    ? (patch.code !== undefined ? { code: patch.code } : {})
    : { ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.code !== undefined ? { code: patch.code } : {}) };
  if (Object.keys(applied).length === 0) return;
  const { error } = await db.from("device_types").update(applied).eq("id", id);
  if (error) throw new Error(`updateDeviceType: ${error.message}`);
}

export async function deleteDeviceType(db: SupabaseClient, id: string): Promise<void> {
  const row = await getDeviceType(db, id);
  if (row.is_standard) throw new Error("Standard device types cannot be deleted");
  const { error } = await db.from("device_types").delete().eq("id", id);
  if (error) throw new Error(`deleteDeviceType: ${error.message}`);
}
```

- [ ] **Step 4: Typecheck + tests**

Run: `npx tsc --noEmit && npm test`
Expected: tsc reports errors ONLY in `typeActions.ts` (old `createDeviceType(db, { name })` call — fixed in Task 3). If so, proceed; the commit lands with Task 3. If other files break, fix them here.

*(Note: repository functions are thin Supabase wrappers — the codebase's existing pattern leaves them untested; the guard logic is exercised via Task 3's action behavior and Task 4's UI tests.)*

- [ ] **Step 5: Commit (combined with Task 3 if tsc was red here)**

```bash
git add supabase/migrations/0003_device_type_categories.sql src/features/device-library/repository.ts
git commit -m "device types: migration 0003 (category/code/is_standard) + repo guards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Server actions (`typeActions.ts` rewrite)

**Files:**
- Modify: `src/features/device-library/typeActions.ts` (full rewrite, ~26 lines currently)

**Interfaces:**
- Consumes: Task 1 rules, Task 2 repository functions.
- Produces (used by Task 4):
  - `createDeviceTypeAction(input: { name: string; code: string; category: "floor" | "rack" }): Promise<{ ok: boolean; error?: string }>`
  - `saveDeviceTypesAction(changes: { id: string; name?: string; code?: string }[]): Promise<{ ok: boolean; error?: string }>`
  - `deleteDeviceTypeAction(id: string): Promise<{ ok: boolean; error?: string }>` (**breaking:** was `Promise<void>`; old caller `DeviceTypesPanel` is deleted in Task 4)

- [ ] **Step 1: Rewrite the actions**

```ts
// src/features/device-library/typeActions.ts
"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { createDeviceType, updateDeviceType, deleteDeviceType } from "./repository";
import { validateCode, validateTypeName } from "./deviceTypeRules";

/** Map raw Postgres/Supabase errors to copy a user can act on. */
function friendly(e: unknown): string {
  const msg = e instanceof Error ? e.message : "Unknown error";
  if (msg.includes("device_types_org_code_key")) return "That ID prefix is already in use";
  if (msg.includes("device_types_org_category_name_key")) return "A type with that name already exists";
  if (msg.includes("foreign key constraint")) return "This type is in use by a device template";
  return msg;
}

export async function createDeviceTypeAction(
  input: { name: string; code: string; category: "floor" | "rack" },
): Promise<{ ok: boolean; error?: string }> {
  const err = validateTypeName(input.name) ?? validateCode(input.code);
  if (err) return { ok: false, error: err };
  const db = createServiceClient();
  try {
    await createDeviceType(db, { name: input.name.trim(), code: input.code, category: input.category });
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
  revalidatePath("/device-library/types");
  return { ok: true };
}

/** Batch save from one column's "Save changes" — applied sequentially, first error aborts. */
export async function saveDeviceTypesAction(
  changes: { id: string; name?: string; code?: string }[],
): Promise<{ ok: boolean; error?: string }> {
  for (const c of changes) {
    const err =
      (c.name !== undefined ? validateTypeName(c.name) : null) ??
      (c.code !== undefined ? validateCode(c.code) : null);
    if (err) return { ok: false, error: err };
  }
  const db = createServiceClient();
  try {
    for (const c of changes) {
      await updateDeviceType(db, c.id, {
        ...(c.name !== undefined ? { name: c.name.trim() } : {}),
        ...(c.code !== undefined ? { code: c.code } : {}),
      });
    }
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
  revalidatePath("/device-library/types");
  return { ok: true };
}

export async function deleteDeviceTypeAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    await deleteDeviceType(db, id);
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
  revalidatePath("/device-library/types");
  return { ok: true };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors ONLY in `DeviceTypesPanel.tsx` (calls the old signatures; it's deleted next task). If DeviceTypesPanel is the sole complaint, delete it now instead of waiting:

```bash
grep -rn "DeviceTypesPanel" src/  # expect: only the file itself
git rm src/features/device-library/DeviceTypesPanel.tsx
npx tsc --noEmit  # expect: clean
```

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all green (nothing imports typeActions in tests yet).

- [ ] **Step 4: Commit**

```bash
git add -A src/features/device-library supabase/migrations
git commit -m "device types: server actions for create/batch-save/delete with friendly errors

Standard types: code-only updates, delete rejected. Removes the dead
DeviceTypesPanel (replaced by DeviceTypesManager).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Wire `DeviceTypesManager` to the DB (+ create modal)

**Files:**
- Modify: `src/features/device-library/DeviceTypesManager.tsx` (full rewrite of the preview)
- Modify: `src/app/device-library/types/page.tsx`
- Test: `src/features/device-library/DeviceTypesManager.test.tsx` (new)

**Interfaces:**
- Consumes: `DeviceTypeRow` (Task 2), all three actions (Task 3), `normalizeCode`/`validateCode`/`validateTypeName`/`CODE_HELP` (Task 1).
- Produces: `DeviceTypesManager({ floor, rack }: { floor: DeviceTypeRow[]; rack: DeviceTypeRow[] })`.

- [ ] **Step 1: Write failing component tests**

```tsx
// src/features/device-library/DeviceTypesManager.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeviceTypesManager } from "./DeviceTypesManager";
import type { DeviceTypeRow } from "./repository";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("./typeActions", () => ({
  createDeviceTypeAction: vi.fn(async () => ({ ok: true })),
  saveDeviceTypesAction: vi.fn(async () => ({ ok: true })),
  deleteDeviceTypeAction: vi.fn(async () => ({ ok: true })),
}));
import { createDeviceTypeAction, saveDeviceTypesAction, deleteDeviceTypeAction } from "./typeActions";

function row(over: Partial<DeviceTypeRow>): DeviceTypeRow {
  return {
    id: "t1", organization_id: "o1", name: "Switch", created_at: "2026-01-01",
    category: "rack", code: "SW", is_standard: true, ...over,
  };
}
const floor = [row({ id: "f1", name: "Camera", code: "CAM", category: "floor" })];
const rack = [
  row({ id: "r1", name: "Switch", code: "SW" }),
  row({ id: "r2", name: "Media Converter", code: "MC", is_standard: false }),
];

beforeEach(() => vi.clearAllMocks());

describe("DeviceTypesManager", () => {
  it("renders both columns with standard codes and custom rows", () => {
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    expect(screen.getByText("Floor Device Types")).toBeInTheDocument();
    expect(screen.getByText("Rack Device Types")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CAM")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Media Converter")).toBeInTheDocument(); // custom name is an input
    expect(screen.getByText("Switch")).toBeInTheDocument();                  // standard name is text
  });

  it("standard rows have no delete button; custom rows do", () => {
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    expect(screen.queryByTestId("delete-type-r1")).not.toBeInTheDocument();
    expect(screen.getByTestId("delete-type-r2")).toBeInTheDocument();
  });

  it("editing a code enables that column's Save and saves only changed rows", async () => {
    const user = userEvent.setup();
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    const save = screen.getByTestId("save-rack");
    expect(save).toBeDisabled();
    const code = screen.getByDisplayValue("SW");
    await user.clear(code);
    await user.type(code, "SWX");
    expect(save).toBeEnabled();
    await user.click(save);
    expect(saveDeviceTypesAction).toHaveBeenCalledWith([{ id: "r1", code: "SWX" }]);
    expect(refresh).toHaveBeenCalled();
  });

  it("Add opens the create modal and validates the prefix before creating", async () => {
    const user = userEvent.setup();
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    await user.click(screen.getByTestId("add-type-rack"));
    await user.type(screen.getByTestId("new-type-name"), "PDU Bar");
    await user.click(screen.getByTestId("new-type-create")); // empty prefix
    expect(createDeviceTypeAction).not.toHaveBeenCalled();
    expect(screen.getAllByText(/1–4 characters/).length).toBeGreaterThan(0);
    await user.type(screen.getByTestId("new-type-code"), "pdub"); // normalizes to PDUB
    await user.click(screen.getByTestId("new-type-create"));
    expect(createDeviceTypeAction).toHaveBeenCalledWith({ name: "PDU Bar", code: "PDUB", category: "rack" });
  });

  it("deleting a custom type calls the action and surfaces failures", async () => {
    (deleteDeviceTypeAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "This type is in use by a device template" });
    const user = userEvent.setup();
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    await user.click(screen.getByTestId("delete-type-r2"));
    expect(deleteDeviceTypeAction).toHaveBeenCalledWith("r2");
    expect(await screen.findByText("This type is in use by a device template")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test DeviceTypesManager`
Expected: FAIL — component still has the old preview props (no `floor`/`rack`).

- [ ] **Step 3: Rewrite the component**

```tsx
// src/features/device-library/DeviceTypesManager.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DeviceTypeRow } from "./repository";
import { createDeviceTypeAction, saveDeviceTypesAction, deleteDeviceTypeAction } from "./typeActions";
import { normalizeCode, validateCode, validateTypeName, CODE_HELP } from "./deviceTypeRules";

type Category = "floor" | "rack";

export function DeviceTypesManager({ floor, rack }: { floor: DeviceTypeRow[]; rack: DeviceTypeRow[] }) {
  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
      <DeviceTypeColumn title="Floor Device Types" category="floor" types={floor} />
      <DeviceTypeColumn title="Rack Device Types" category="rack" types={rack} />
    </div>
  );
}

function DeviceTypeColumn({ title, category, types }: { title: string; category: Category; types: DeviceTypeRow[] }) {
  const router = useRouter();
  const standard = types.filter((t) => t.is_standard);
  const customs = types.filter((t) => !t.is_standard);

  // Draft edits keyed by row id; absent key = unchanged. Codes are normalized as typed.
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const changes = types
    .map((t) => {
      const code = codes[t.id] !== undefined && codes[t.id] !== t.code ? codes[t.id] : undefined;
      const name = names[t.id] !== undefined && names[t.id] !== t.name ? names[t.id] : undefined;
      return { id: t.id, ...(name !== undefined ? { name } : {}), ...(code !== undefined ? { code } : {}) };
    })
    .filter((c) => "name" in c || "code" in c);
  const dirty = changes.length > 0;

  async function save() {
    setSaving(true); setError(null);
    const res = await saveDeviceTypesAction(changes);
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Save failed"); return; }
    setCodes({}); setNames({});
    router.refresh();
  }

  async function remove(id: string) {
    setError(null);
    const res = await deleteDeviceTypeAction(id);
    if (!res.ok) { setError(res.error ?? "Delete failed"); return; }
    router.refresh();
  }

  const half = Math.ceil(standard.length / 2);
  const columns = [standard.slice(0, half), standard.slice(half)];

  return (
    <section className="space-y-4 rounded-2xl border border-neutral-200 bg-white p-5">
      <h2 className="text-xl font-bold text-neutral-900">{title}</h2>

      {/* Standard */}
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-sm font-semibold text-neutral-700">
          Standard Device Types
        </div>
        <div className="p-4">
          <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
            {columns.map((col, ci) => (
              <div key={ci} className="space-y-3">
                {col.map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-3">
                    <span className="text-sm font-semibold text-neutral-800">{t.name}</span>
                    <input
                      value={codes[t.id] ?? t.code}
                      onChange={(e) => setCodes((c) => ({ ...c, [t.id]: normalizeCode(e.target.value) }))}
                      className="h-9 w-20 rounded-lg border border-neutral-200 px-2 text-sm text-neutral-600 focus:border-neutral-400 focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
          <button
            type="button"
            data-testid={`save-${category}`}
            disabled={!dirty || saving}
            onClick={save}
            className="mt-5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9] disabled:opacity-40 disabled:hover:bg-blue-600"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {/* Custom */}
      <div className="overflow-hidden rounded-xl border border-neutral-200">
        <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-4 py-2.5">
          <span className="text-sm font-semibold text-neutral-700">Custom Device Types</span>
          <button
            type="button"
            data-testid={`add-type-${category}`}
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-100"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M7 2v10M2 7h10" /></svg>
            Add
          </button>
        </div>
        <div className="p-4">
          {customs.length === 0 ? (
            <p className="py-6 text-center text-sm text-neutral-400">Click &quot;Add&quot; to create your first custom device type.</p>
          ) : (
            <div className="space-y-2">
              {customs.map((t) => (
                <div key={t.id} className="flex items-center gap-2">
                  <input
                    value={names[t.id] ?? t.name}
                    onChange={(e) => setNames((n) => ({ ...n, [t.id]: e.target.value }))}
                    className="h-9 flex-1 rounded-lg border border-neutral-200 px-3 text-sm text-neutral-900 focus:border-neutral-400 focus:outline-none"
                  />
                  <input
                    value={codes[t.id] ?? t.code}
                    onChange={(e) => setCodes((c) => ({ ...c, [t.id]: normalizeCode(e.target.value) }))}
                    className="h-9 w-24 rounded-lg border border-neutral-200 px-2 text-sm text-neutral-600 focus:border-neutral-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="Delete type"
                    data-testid={`delete-type-${t.id}`}
                    onClick={() => remove(t.id)}
                    className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {modalOpen && (
        <CreateTypeModal
          category={category}
          onClose={() => setModalOpen(false)}
          onCreated={() => { setModalOpen(false); router.refresh(); }}
        />
      )}
    </section>
  );
}

function CreateTypeModal({ category, onClose, onCreated }: {
  category: Category; onClose: () => void; onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = category === "floor" ? "Floor" : "Rack";

  async function create() {
    const err = validateTypeName(name) ?? validateCode(code);
    if (err) { setError(err); return; }
    setBusy(true); setError(null);
    const res = await createDeviceTypeAction({ name: name.trim(), code, category });
    setBusy(false);
    if (!res.ok) { setError(res.error ?? "Create failed"); return; }
    onCreated();
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label={`Create ${label} Device Type`}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
        <h3 className="text-base font-bold">Create {label} Device Type</h3>
        <p className="mt-1 text-sm text-neutral-500">Create a custom device type.</p>
        <label className="mt-4 block text-[11px] font-semibold text-neutral-600">
          Name *
          <input
            data-testid="new-type-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm font-normal focus:border-neutral-400 focus:outline-none"
          />
        </label>
        <label className="mt-3 block text-[11px] font-semibold text-neutral-600">
          ID prefix *
          <input
            data-testid="new-type-code"
            value={code}
            onChange={(e) => setCode(normalizeCode(e.target.value))}
            className="mt-1 h-9 w-24 rounded-lg border border-neutral-200 px-2 text-sm font-normal focus:border-neutral-400 focus:outline-none"
          />
        </label>
        <p className="mt-1 text-xs text-neutral-500">{CODE_HELP}</p>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold transition-colors hover:bg-neutral-100">Cancel</button>
          <button type="button" data-testid="new-type-create" disabled={busy} onClick={create}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9] disabled:opacity-40">
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire the page**

```tsx
// src/app/device-library/types/page.tsx
import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTypes } from "@/features/device-library/repository";
import { DeviceTypesManager } from "@/features/device-library/DeviceTypesManager";

export const dynamic = "force-dynamic";

export default async function DeviceTypesPage() {
  const db = createServiceClient();
  const types = await listDeviceTypes(db);
  return (
    <DeviceTypesManager
      floor={types.filter((t) => t.category === "floor")}
      rack={types.filter((t) => t.category === "rack")}
    />
  );
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm test DeviceTypesManager && npx tsc --noEmit`
Expected: 5 tests PASS, tsc clean. Then `npm test` for the full suite.

- [ ] **Step 6: Commit**

```bash
git add src/features/device-library/DeviceTypesManager.tsx src/features/device-library/DeviceTypesManager.test.tsx src/app/device-library/types/page.tsx
git commit -m "device types: wire two-column manager to Supabase + create modal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Rack-only types in the editor dropdown

**Files:**
- Modify: `src/app/device-library/page.tsx` (one line)

**Interfaces:**
- Consumes: `DeviceTypeRow.category` (Task 2).
- Produces: `EditorLauncher` receives rack types only; its prop types are unchanged.

- [ ] **Step 1: Filter in the page**

In `src/app/device-library/page.tsx`, change the `EditorLauncher` render to:

```tsx
  return <EditorLauncher rows={rows} types={types.filter((t) => t.category === "rack")} brands={brands} />;
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit && npm test`
Expected: clean/green (floor types like "Camera" can no longer appear in the editor's Device type dropdown).

- [ ] **Step 3: Commit**

```bash
git add src/app/device-library/page.tsx
git commit -m "editor: device-type dropdown offers rack types only

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Rack Devices table — duplicate / edit / delete icons + name link

**Files:**
- Modify: `src/features/device-library/repository.ts` (add `duplicateDeviceTemplate` after `deleteDeviceTemplate`, ~line 101)
- Modify: `src/features/device-library/actions.ts` (add `duplicateDeviceTemplateAction` next to `deleteDeviceTemplateAction`, ~line 91)
- Modify: `src/features/device-library/RackDeviceTable.tsx` (actions cell + name cell)
- Modify: `src/features/device-library/editor/EditorLauncher.tsx` (wire duplicate/delete + confirm dialog)
- Test: `src/features/device-library/RackDeviceTable.test.tsx` (extend)

**Interfaces:**
- Consumes: existing `getDeviceTemplate(db, id)`, `deleteDeviceTemplateAction(id): Promise<void>`.
- Produces:
  - `duplicateDeviceTemplate(db, id): Promise<DeviceTemplateRow>` / `duplicateDeviceTemplateAction(id): Promise<{ ok: boolean; error?: string }>`
  - `RackDeviceTable` new optional props: `onDuplicate?: (id: string) => void; onDelete?: (id: string) => void; onView?: (id: string) => void` — with testids `duplicate-{id}`, `delete-{id}`, `view-{id}`; `edit-{id}` is retained on the pencil.

- [ ] **Step 1: Write failing table tests** (append to `RackDeviceTable.test.tsx`)

```tsx
describe("RackDeviceTable row actions", () => {
  it("renders duplicate/edit/delete icons and fires their callbacks", async () => {
    const user = userEvent.setup();
    const onDuplicate = vi.fn(), onEdit = vi.fn(), onDelete = vi.fn();
    render(<RackDeviceTable rows={rows} onEdit={onEdit} onDuplicate={onDuplicate} onDelete={onDelete} />);
    await user.click(screen.getByTestId("duplicate-1"));
    await user.click(screen.getByTestId("edit-1"));
    await user.click(screen.getByTestId("delete-1"));
    expect(onDuplicate).toHaveBeenCalledWith("1");
    expect(onEdit).toHaveBeenCalledWith("1");
    expect(onDelete).toHaveBeenCalledWith("1");
  });

  it("name becomes a view link when onView is provided", async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    render(<RackDeviceTable rows={rows} onView={onView} />);
    await user.click(screen.getByTestId("view-1"));
    expect(onView).toHaveBeenCalledWith("1");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test RackDeviceTable`
Expected: new tests FAIL (unknown testids/props).

- [ ] **Step 3: Update the table**

In `RackDeviceTable.tsx`, extend the props type:

```tsx
export function RackDeviceTable({
  rows, onEdit, onCreate, onDuplicate, onDelete, onView, title,
}: {
  rows: DeviceTemplateListRow[];
  onEdit?: (id: string) => void;
  onCreate?: () => void;
  onDuplicate?: (id: string) => void;
  onDelete?: (id: string) => void;
  onView?: (id: string) => void;
  title?: string;
}) {
```

Replace the Name `<td>`:

```tsx
              <td className="px-5 py-3 font-medium text-neutral-900">
                {onView ? (
                  <button
                    type="button"
                    data-testid={`view-${r.id}`}
                    onClick={() => onView(r.id)}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {r.name}
                  </button>
                ) : r.name}
              </td>
```

Replace the Actions `<td>` (keep `edit-{id}` on the pencil):

```tsx
              <td className="px-5 py-3 text-right">
                <div className="flex items-center justify-end gap-1">
                  {onDuplicate && (
                    <RowIcon testid={`duplicate-${r.id}`} label="Duplicate" onClick={() => onDuplicate(r.id)}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    </RowIcon>
                  )}
                  {onEdit && (
                    <RowIcon testid={`edit-${r.id}`} label="Edit" onClick={() => onEdit(r.id)}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" /></svg>
                    </RowIcon>
                  )}
                  {onDelete && (
                    <RowIcon testid={`delete-${r.id}`} label="Delete" red onClick={() => onDelete(r.id)}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
                    </RowIcon>
                  )}
                </div>
              </td>
```

Add the helper component at the bottom of the file:

```tsx
function RowIcon({ children, testid, label, red, onClick }: {
  children: React.ReactNode; testid: string; label: string; red?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        red ? "text-neutral-400 hover:bg-red-50 hover:text-red-600" : "text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 4: Repository duplicate + action**

Repository (after `deleteDeviceTemplate`):

```ts
/** Copy a template (faces and all) under "<name> (copy)". Unique-name violations surface as errors. */
export async function duplicateDeviceTemplate(db: SupabaseClient, id: string): Promise<DeviceTemplateRow> {
  const src = await getDeviceTemplate(db, id);
  const org = await getDefaultOrganization(db);
  const { data, error } = await db.from("device_templates")
    .insert({
      organization_id: org.id, name: `${src.name} (copy)`,
      brand_id: src.brand_id, device_type_id: src.device_type_id,
      rack_units: src.rack_units, width_in: src.width_in, rack_mounted: src.rack_mounted,
      front_face: src.front_face, back_face: src.back_face,
    })
    .select("*").single();
  if (error) throw new Error(`duplicateDeviceTemplate: ${error.message}`);
  return data as DeviceTemplateRow;
}
```

Action (in `actions.ts`, import `duplicateDeviceTemplate` in the existing import block):

```ts
export async function duplicateDeviceTemplateAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    await duplicateDeviceTemplate(db, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return { ok: false, error: msg.includes("duplicate key") ? "A copy with that name already exists — rename it first" : msg };
  }
  revalidatePath("/device-library");
  return { ok: true };
}
```

- [ ] **Step 5: Wire `EditorLauncher`**

In `EditorLauncher.tsx`: import `duplicateDeviceTemplateAction, deleteDeviceTemplateAction` from `../actions`; add state `const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);` and handlers:

```tsx
  async function duplicate(id: string) {
    setError(null);
    const res = await duplicateDeviceTemplateAction(id);
    if (!res.ok) { setError(res.error ?? "Duplicate failed"); return; }
    router.refresh();
  }

  async function confirmDeleteNow() {
    if (!confirmDelete) return;
    setError(null);
    try {
      await deleteDeviceTemplateAction(confirmDelete.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
    setConfirmDelete(null);
    router.refresh();
  }
```

Pass the new props to the table:

```tsx
      <RackDeviceTable
        rows={rows}
        title="Custom Rack Devices"
        onEdit={openEdit}
        onDuplicate={duplicate}
        onDelete={(id) => setConfirmDelete({ id, name: rows.find((r) => r.id === id)?.name ?? "" })}
        onCreate={() => { setError(null); setState({ mode: "create" }); }}
      />
```

And render the confirm dialog after the table (same styling as the editor's discard dialog):

```tsx
      {confirmDelete && (
        <div data-testid="delete-template-confirm" role="alertdialog" aria-label="Delete device"
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
            <h3 className="text-base font-bold">Delete “{confirmDelete.name}”?</h3>
            <p className="mt-2 text-sm text-neutral-600">This custom device will be permanently removed from the library.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(null)}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold transition-colors hover:bg-neutral-100">Cancel</button>
              <button type="button" data-testid="delete-template-confirm-btn" onClick={confirmDeleteNow}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-700">Delete</button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 6: Run everything**

Run: `npm test && npx tsc --noEmit`
Expected: all green (incl. the two new table tests), tsc clean.

- [ ] **Step 7: Commit**

```bash
git add src/features/device-library
git commit -m "device library: duplicate/edit/delete row actions + delete confirm

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Read-only editor view (name link)

**Files:**
- Modify: `src/features/device-library/editor/RackDeviceEditor.tsx` (add `readOnly?: boolean` prop)
- Modify: `src/features/device-library/editor/EditorLauncher.tsx` (view state + `onView`)
- Test: `src/features/device-library/editor/RackDeviceEditor.test.tsx` (extend)

**Interfaces:**
- Consumes: `RackDeviceTable.onView` (Task 6), existing `getDeviceTemplateAction`.
- Produces: `RackDeviceEditorProps` gains `readOnly?: boolean`; `EditingState` gains `{ mode: "view"; id: string; initial: Partial<DeviceDraft> }`.

- [ ] **Step 1: Write failing tests** (append to `RackDeviceEditor.test.tsx`)

```tsx
describe("RackDeviceEditor read-only mode", () => {
  it("shows the banner, disables fields, and offers only Close", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="edit" readOnly types={types} brands={brands}
      initial={{ name: "Switch", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={onCancel} />);
    expect(screen.getByText(/read-only mode/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/name/i)).toBeDisabled();
    expect(screen.queryByTestId("editor-save")).not.toBeInTheDocument();
    expect(screen.queryByTestId("editor-cancel")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("editor-close"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape closes immediately in read-only mode (no discard warning)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="edit" readOnly types={types} brands={brands}
      initial={{ name: "Switch", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={onCancel} />);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("discard-confirm")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test RackDeviceEditor`
Expected: FAIL — no `readOnly` prop / no banner / no `editor-close`.

- [ ] **Step 3: Implement `readOnly` in `RackDeviceEditor.tsx`**

1. Props: add `readOnly?: boolean;` to `RackDeviceEditorProps`.
2. At the top of the component: `const ro = props.readOnly === true;`
3. Keyboard effect — first line of `onKey`:

```ts
      if (ro) { if (e.key === "Escape") props.onCancel(); return; }
```

(add `ro` to the effect deps array.)
4. Banner — directly under the `<h2>` header row:

```tsx
        {ro && (
          <div data-testid="readonly-banner" className="mb-4 flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" /></svg>
            You are viewing this custom rack device in read-only mode.
          </div>
        )}
```

5. Header fields: wrap the existing header-fields row in `<fieldset disabled={ro} className="contents">…</fieldset>` (display:contents keeps the layout; native inputs and the BrandPicker/Select buttons all disable).
6. Palette + canvas: add `${ro ? "pointer-events-none opacity-70" : ""}` to the palette container's className and `${ro ? "pointer-events-none" : ""}` to the `EditorCanvas` wrapper div (the canvas without pointer events is exactly the pure-preview mode it already supports).
7. The header ✕ button: `onClick={ro ? props.onCancel : attemptClose}`.
8. Footer — replace the Cancel/Create block with:

```tsx
        <div className="mt-5 flex justify-end gap-2">
          {ro ? (
            <button type="button" data-testid="editor-close" onClick={props.onCancel}
              className="rounded-lg border border-neutral-200 px-5 py-2 text-sm font-semibold transition-colors hover:bg-neutral-100">Close</button>
          ) : (
            <>
              {/* existing editor-cancel and editor-save buttons, unchanged */}
            </>
          )}
        </div>
```

- [ ] **Step 4: Wire the view state in `EditorLauncher.tsx`**

1. Extend the state union: `| { mode: "view"; id: string; initial: Partial<DeviceDraft> }`.
2. Add:

```tsx
  async function openView(id: string) {
    setError(null);
    const res = await getDeviceTemplateAction(id);
    if (!res.ok || !res.template) { setError(res.error ?? "Failed to load"); return; }
    const t = res.template;
    setState({
      mode: "view", id,
      initial: {
        name: t.name, brandId: t.brandId, deviceTypeId: t.deviceTypeId,
        rackUnits: t.rackUnits, widthIn: t.widthIn, rackMounted: t.rackMounted,
        frontFace: t.frontFace, backFace: t.backFace,
      },
    });
  }
```

3. Pass `onView={openView}` to `RackDeviceTable`.
4. Update the editor render: it currently gates on `state.mode !== "closed"` and passes `mode={state.mode}` + `initial={state.mode === "edit" ? state.initial : undefined}`. Change to:

```tsx
      {state.mode !== "closed" && (
        <RackDeviceEditor
          mode={state.mode === "create" ? "create" : "edit"}
          readOnly={state.mode === "view"}
          initial={state.mode === "edit" || state.mode === "view" ? state.initial : undefined}
          ...
```

(`save` can keep its `state.mode === "edit"` branch — the save button doesn't render in view mode.)

- [ ] **Step 5: Run everything**

Run: `npm test && npx tsc --noEmit`
Expected: all green (incl. the 2 new editor tests + Task 6 table tests), tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/features/device-library/editor
git commit -m "editor: read-only template view via device name link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Full verification (browser)

**Files:** none (verification only).

- [ ] **Step 1: Suite + types**

Run: `cd /Users/reubensingh/development/network-doc-platform && npm test && npx tsc --noEmit`
Expected: everything green, tsc silent.

- [ ] **Step 2: Fresh DB**

Run: `npx supabase db reset`
Expected: migrations 0001–0003 apply cleanly with seeds.

- [ ] **Step 3: Browser walkthrough** (preview server "rack-designer-dev", port 3100)

- `/device-library/types`: both columns load from the DB (12 + 12 standard with codes).
- Edit a code (e.g. SW → SWX) → Save changes enables → save → refresh keeps SWX → change it back.
- Add on Rack → modal → invalid prefix rejected with helper text → valid ("Media Converter", MC) → appears in Custom list.
- Delete the custom type → row disappears. Create a device template using a custom type, then try deleting the type → "This type is in use by a device template".
- `/device-library`: row shows duplicate/edit/delete icons; duplicate creates "<name> (copy)"; delete asks to confirm, then removes; name link opens the read-only editor (banner, disabled fields, Close only); editor Create flow still works and the Device type dropdown contains no floor types.

**Success criteria:** every bullet above observed working; no console errors.
