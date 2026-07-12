# Rack Builder Phase 2b (Device Placement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working rack builder — `/racks` list + `/racks/[id]` page where device templates are placed into Phase-1 racks, moved, configured, and autosaved, with undo/redo.

**Architecture:** New `rack_devices` table references templates live (render-time face lookup). Pure placement math (`rackOps`) + a generic undo `history` drive a client builder whose every mutation reconciles through ONE server action (`saveRackLayoutAction`) — so undo/redo/autosave are uniform. A pure `RackFrame` SVG composes the existing pure `renderFace` per placement; `RackCanvas` overlays interactions (EditorCanvas pattern). The light shell is promoted app-wide as `AppShell`.

**Tech Stack:** Next.js 16 app router + server actions, Supabase (local), TypeScript, Vitest + @testing-library/react, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-08-rack-builder-phase-2b-placement-design.md`

## Global Constraints

- Placed-device code: uppercase, no spaces, **1–10 chars** (`^[A-Z0-9_-]{1,10}$`), unique per rack; auto-generated as `typeCode + 2-digit increment` (SW01, SW02, … SW100 after 99).
- One device per RU span (no front/back sharing); `side` column stored, always `'front'` in 2b.
- Status values verbatim: `planned | installed | verified`, default `installed`.
- Occupancy is validated client-side AND re-validated server-side against fresh DB state.
- RU numbering is bottom-up (U1 at the bottom), like real racks and PatchDocs.
- All commits end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Run everything from `/Users/reubensingh/development/network-doc-platform` (cwd resets — `cd` first).
- Every task finishes with `npm test` green and `npx tsc --noEmit` silent.

**Key existing interfaces (verbatim from the codebase):**
- `RU_PX = 84`, `PX_PER_IN = 48`, `RAIL_WIDTH_IN = 19` from `@/domain/faceplate-geometry`; `frameDims({widthIn, rackUnits, rackMounted})` → `{frameWidthPx, heightPx, earWidthPx, bodyWidthPx}`.
- `renderFace(face: Face, opts: {widthIn, rackUnits, rackMounted})` from `@/features/device-library/faceplate/Faceplate` returns the device SVG contents (frame + ears + ports) — composable inside any `<svg>`/`<g>`.
- `RackWithPath { id, label, siteCode, floorCode, roomCode, roomType, rackCode, heightU }` and `listRacksWithPath(db)`, `createRack(db, {roomId, code, name?, heightU})` from `@/features/locations/repository`; `createRackWithHierarchyAction(formData)` from `@/features/locations/actions` (fields: siteCode, floorCode, roomCode, roomType, rackCode, heightU).
- `DeviceTemplateRow` (snake_case, faces jsonb) + `toEditableTemplate` → `EditableTemplate { id, name, brandId, deviceTypeId, rackUnits, widthIn, rackMounted, frontFace, backFace }` from `@/features/device-library/repository`; `DeviceTypeRow { id, name, category, code, is_standard }`.
- Shell components in `src/features/device-library/`: `DeviceLibraryShell.tsx`, `AppSidebar.tsx` (NavItem, SIDEBAR widths), `DeviceLibraryTabs.tsx`, `RackDeviceTable.tsx` (card-table styling to copy).

---

### Task 1: Pure placement math (`rackOps.ts`)

**Files:**
- Create: `src/features/racks/rackOps.ts`
- Test: `src/features/racks/rackOps.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Tasks 4, 5, 9, 10):

```ts
export interface PlacementLike { id: string; deviceTemplateId: string; code: string; startU: number; }
export type RuByTemplate = Record<string, number>; // templateId -> rack_units
export const DEVICE_CODE_RULE: RegExp; // ^[A-Z0-9_-]{1,10}$
export function spanOf(p: PlacementLike, ru: RuByTemplate): { bottom: number; top: number };
export function canPlace(placements: PlacementLike[], ru: RuByTemplate, startU: number, heightU: number, rackHeight: number, ignoreId?: string): boolean;
export function findFreeSlot(placements: PlacementLike[], ru: RuByTemplate, heightU: number, rackHeight: number, preferredU?: number): number | null;
export function nextCode(placements: PlacementLike[], typeCode: string): string;
export function resolveMove(placements: PlacementLike[], ru: RuByTemplate, id: string, targetU: number, rackHeight: number): number; // nearest legal startU (own position if blocked)
export function validateDeviceCode(code: string): string | null;
export function minRackHeight(placements: PlacementLike[], ru: RuByTemplate): number; // 0 when empty
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/features/racks/rackOps.test.ts
import { describe, it, expect } from "vitest";
import {
  spanOf, canPlace, findFreeSlot, nextCode, resolveMove, validateDeviceCode, minRackHeight,
  type PlacementLike,
} from "./rackOps";

const ru = { t1: 1, t2: 2 }; // template heights
const p = (id: string, tid: string, code: string, startU: number): PlacementLike =>
  ({ id, deviceTemplateId: tid, code, startU });

describe("spanOf", () => {
  it("computes bottom/top from startU and template height", () => {
    expect(spanOf(p("a", "t2", "SW01", 5), ru)).toEqual({ bottom: 5, top: 6 });
    expect(spanOf(p("a", "t1", "SW01", 1), ru)).toEqual({ bottom: 1, top: 1 });
  });
});

describe("canPlace", () => {
  const placed = [p("a", "t2", "SW01", 5)]; // occupies 5-6
  it("accepts a free, in-bounds span", () => {
    expect(canPlace(placed, ru, 1, 1, 12)).toBe(true);
    expect(canPlace(placed, ru, 7, 2, 12)).toBe(true);
  });
  it("rejects overlaps and out-of-bounds", () => {
    expect(canPlace(placed, ru, 6, 1, 12)).toBe(false);  // overlaps top of a
    expect(canPlace(placed, ru, 4, 2, 12)).toBe(false);  // 4-5 overlaps bottom
    expect(canPlace(placed, ru, 12, 2, 12)).toBe(false); // 12-13 exceeds rack
    expect(canPlace(placed, ru, 0, 1, 12)).toBe(false);  // below U1
  });
  it("ignores the moving device itself via ignoreId", () => {
    expect(canPlace(placed, ru, 5, 2, 12, "a")).toBe(true);
  });
});

describe("findFreeSlot", () => {
  const placed = [p("a", "t2", "SW01", 5), p("b", "t1", "PP01", 1)];
  it("prefers the requested U when legal, else nearest free slot, else null", () => {
    expect(findFreeSlot(placed, ru, 1, 12, 3)).toBe(3);
    expect(findFreeSlot(placed, ru, 1, 12, 5)).toBe(4);            // 5 occupied → nearest
    expect(findFreeSlot([p("x", "t2", "A01", 1)], ru, 2, 2)).toBeNull(); // full rack
  });
});

describe("nextCode", () => {
  it("increments per type code and reuses gaps", () => {
    expect(nextCode([], "SW")).toBe("SW01");
    expect(nextCode([p("a", "t1", "SW01", 1), p("b", "t1", "SW03", 3)], "SW")).toBe("SW02");
    expect(nextCode([p("a", "t1", "PP01", 1)], "SW")).toBe("SW01");
  });
});

describe("resolveMove", () => {
  const placed = [p("a", "t2", "SW01", 5), p("b", "t1", "PP01", 8)];
  it("returns the target when legal, clamps into the rack, keeps position when blocked", () => {
    expect(resolveMove(placed, ru, "a", 2, 12)).toBe(2);
    expect(resolveMove(placed, ru, "a", 14, 12)).toBe(11); // clamped so 2U fits
    expect(resolveMove(placed, ru, "a", 8, 12)).toBe(5);   // 8-9 blocked by b → stay
  });
});

describe("validateDeviceCode", () => {
  it("enforces uppercase alphanumeric/underscore/hyphen, 1-10 chars", () => {
    expect(validateDeviceCode("SW01")).toBeNull();
    expect(validateDeviceCode("RK001_M")).toBeNull();
    expect(validateDeviceCode("")).not.toBeNull();
    expect(validateDeviceCode("sw01")).not.toBeNull();
    expect(validateDeviceCode("HAS SPACE")).not.toBeNull();
    expect(validateDeviceCode("ELEVENCHARS")).not.toBeNull();
  });
});

describe("minRackHeight", () => {
  it("is the highest occupied U, 0 when empty", () => {
    expect(minRackHeight([], ru)).toBe(0);
    expect(minRackHeight([p("a", "t2", "SW01", 5)], ru)).toBe(6);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/reubensingh/development/network-doc-platform && npm test rackOps`
Expected: FAIL — cannot resolve `./rackOps`.

- [ ] **Step 3: Implement**

```ts
// src/features/racks/rackOps.ts
// Pure placement math for the rack builder. Mirrors portGroupOps' style: no React, no I/O.
// RUs are numbered bottom-up (U1 at the bottom); a placement occupies startU .. startU+ru-1.

export interface PlacementLike { id: string; deviceTemplateId: string; code: string; startU: number; }
export type RuByTemplate = Record<string, number>;

export const DEVICE_CODE_RULE = /^[A-Z0-9_-]{1,10}$/;

export function spanOf(p: PlacementLike, ru: RuByTemplate): { bottom: number; top: number } {
  const h = ru[p.deviceTemplateId] ?? 1;
  return { bottom: p.startU, top: p.startU + h - 1 };
}

export function canPlace(
  placements: PlacementLike[], ru: RuByTemplate,
  startU: number, heightU: number, rackHeight: number, ignoreId?: string,
): boolean {
  const top = startU + heightU - 1;
  if (startU < 1 || top > rackHeight) return false;
  return placements.every((p) => {
    if (p.id === ignoreId) return true;
    const s = spanOf(p, ru);
    return top < s.bottom || startU > s.top;
  });
}

/** The preferred U if legal, else the nearest legal startU, else null (rack full for this height). */
export function findFreeSlot(
  placements: PlacementLike[], ru: RuByTemplate,
  heightU: number, rackHeight: number, preferredU = 1,
): number | null {
  const candidates = Array.from({ length: rackHeight }, (_, i) => i + 1)
    .filter((u) => canPlace(placements, ru, u, heightU, rackHeight))
    .sort((a, b) => Math.abs(a - preferredU) - Math.abs(b - preferredU) || a - b);
  return candidates[0] ?? null;
}

/** First free `typeCode + NN` (2 digits, reusing gaps; grows naturally past 99). */
export function nextCode(placements: PlacementLike[], typeCode: string): string {
  const used = new Set(placements.map((p) => p.code));
  for (let n = 1; ; n++) {
    const code = `${typeCode}${String(n).padStart(2, "0")}`;
    if (!used.has(code)) return code;
  }
}

/** Nearest legal startU to the drag target; falls back to the device's current position. */
export function resolveMove(
  placements: PlacementLike[], ru: RuByTemplate,
  id: string, targetU: number, rackHeight: number,
): number {
  const self = placements.find((p) => p.id === id);
  if (!self) return targetU;
  const h = ru[self.deviceTemplateId] ?? 1;
  const clamped = Math.max(1, Math.min(targetU, rackHeight - h + 1));
  if (canPlace(placements, ru, clamped, h, rackHeight, id)) return clamped;
  return self.startU;
}

export function validateDeviceCode(code: string): string | null {
  return DEVICE_CODE_RULE.test(code)
    ? null
    : "IDs are 1–10 characters: uppercase letters, numbers, _ or -";
}

/** Highest occupied U — the floor for shrinking the rack. */
export function minRackHeight(placements: PlacementLike[], ru: RuByTemplate): number {
  return placements.reduce((m, p) => Math.max(m, spanOf(p, ru).top), 0);
}
```

- [ ] **Step 4: Run to green**

Run: `npm test rackOps` → all pass. Then `npx tsc --noEmit` → silent.

- [ ] **Step 5: Commit**

```bash
git add src/features/racks/rackOps.ts src/features/racks/rackOps.test.ts
git commit -m "racks: pure placement math (spans, occupancy, auto-codes, moves)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Generic undo history (`history.ts`)

**Files:**
- Create: `src/features/racks/history.ts`
- Test: `src/features/racks/history.test.ts`

**Interfaces:**
- Produces (used by Task 10):

```ts
export interface History<T> { past: T[]; present: T; future: T[]; }
export function createHistory<T>(present: T): History<T>;
export function push<T>(h: History<T>, next: T): History<T>;   // truncates future
export function undo<T>(h: History<T>) : History<T>;           // no-op at the start
export function redo<T>(h: History<T>) : History<T>;           // no-op at the end
export function canUndo<T>(h: History<T>): boolean;
export function canRedo<T>(h: History<T>): boolean;
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/features/racks/history.test.ts
import { describe, it, expect } from "vitest";
import { createHistory, push, undo, redo, canUndo, canRedo } from "./history";

describe("history", () => {
  it("pushes states and walks back/forward", () => {
    let h = createHistory(0);
    h = push(h, 1); h = push(h, 2);
    expect(h.present).toBe(2);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(canRedo(h)).toBe(true);
    h = redo(h);
    expect(h.present).toBe(2);
  });
  it("push after undo truncates the future (branching)", () => {
    let h = push(push(createHistory(0), 1), 2);
    h = undo(h);          // present 1, future [2]
    h = push(h, 9);       // future discarded
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe(9);
    expect(undo(h).present).toBe(1);
  });
  it("undo/redo at the boundaries are no-ops", () => {
    const h = createHistory("x");
    expect(undo(h)).toEqual(h);
    expect(redo(h)).toEqual(h);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test src/features/racks/history` → FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/features/racks/history.ts
// Minimal immutable undo/redo stack for the rack builder's placement list.

export interface History<T> { past: T[]; present: T; future: T[]; }

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function push<T>(h: History<T>, next: T): History<T> {
  return { past: [...h.past, h.present], present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [h.present, ...h.future],
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

export const canUndo = <T,>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T,>(h: History<T>): boolean => h.future.length > 0;
```

- [ ] **Step 4: Run to green** — `npm test src/features/racks/history` passes; `npx tsc --noEmit` silent.

- [ ] **Step 5: Commit**

```bash
git add src/features/racks/history.ts src/features/racks/history.test.ts
git commit -m "racks: generic undo/redo history

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Migration 0004 + racks repository

**Files:**
- Create: `supabase/migrations/0004_rack_devices.sql`
- Create: `src/features/racks/repository.ts`

**Interfaces:**
- Consumes: `createServiceClient` pattern; `@/features/locations/repository` types.
- Produces (used by Tasks 4, 9):

```ts
export interface RackDeviceRow {
  id: string; rack_id: string; device_template_id: string;
  code: string; name: string | null; start_u: number; side: "front" | "back";
  status: "planned" | "installed" | "verified";
  manufacturer: string | null; model_name: string | null; serial_number: string | null;
  purchase_date: string | null; operation_start: string | null;
  created_at: string; updated_at: string;
}
export interface RackRow { id: string; room_id: string; code: string; name: string | null; height_u: number; }
export function getRack(db, id): Promise<RackRow>;
export function updateRack(db, id, patch: { name?: string | null; heightU?: number }): Promise<void>;
export function listRackDevices(db, rackId): Promise<RackDeviceRow[]>;
export function replaceRackDevices(db, rackId, rows: Omit<RackDeviceRow, "rack_id"|"created_at"|"updated_at">[]): Promise<void>;
```

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0004_rack_devices.sql
-- Placed device instances: a rack position referencing a Device Library template.
-- Faces are looked up from the template at render time (no snapshot; impact/rebuild
-- semantics arrive with connections in Phase 2c).

create table rack_devices (
  id uuid primary key default gen_random_uuid(),
  rack_id uuid not null references racks(id) on delete cascade,
  device_template_id uuid not null references device_templates(id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9_-]{1,10}$'),
  name text,
  start_u int not null check (start_u >= 1),
  side text not null default 'front' check (side in ('front','back')),
  status text not null default 'installed' check (status in ('planned','installed','verified')),
  manufacturer text,
  model_name text,
  serial_number text,
  purchase_date date,
  operation_start date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rack_id, code)
);

alter table rack_devices enable row level security;
create policy "single_org_all" on rack_devices for all using (true) with check (true);

grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

- [ ] **Step 2: Apply + verify**

Run: `cd /Users/reubensingh/development/network-doc-platform && npx supabase migration up`
Expected: applies 0004. Verify:
`docker exec supabase_db_network-doc-platform psql -U postgres -d postgres -c "\d rack_devices" | head -20` shows the columns.
(If Supabase isn't running: `npx supabase start` first.)

- [ ] **Step 3: Write the repository**

```ts
// src/features/racks/repository.ts
// Thin Supabase wrappers for racks + placed devices (same pattern as device-library/repository).
import type { SupabaseClient } from "@supabase/supabase-js";

export interface RackRow {
  id: string; room_id: string; code: string; name: string | null; height_u: number;
}

export interface RackDeviceRow {
  id: string; rack_id: string; device_template_id: string;
  code: string; name: string | null; start_u: number; side: "front" | "back";
  status: "planned" | "installed" | "verified";
  manufacturer: string | null; model_name: string | null; serial_number: string | null;
  purchase_date: string | null; operation_start: string | null;
  created_at: string; updated_at: string;
}

/** Everything the reconcile action writes; rack_id/timestamps are supplied by the server. */
export type RackDeviceInput = Omit<RackDeviceRow, "rack_id" | "created_at" | "updated_at">;

export async function getRack(db: SupabaseClient, id: string): Promise<RackRow> {
  const { data, error } = await db.from("racks").select("*").eq("id", id).single();
  if (error) throw new Error(`getRack: ${error.message}`);
  return data as RackRow;
}

export async function updateRack(
  db: SupabaseClient, id: string, patch: { name?: string | null; heightU?: number },
): Promise<void> {
  const applied = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.heightU !== undefined ? { height_u: patch.heightU } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from("racks").update(applied).eq("id", id);
  if (error) throw new Error(`updateRack: ${error.message}`);
}

export async function listRackDevices(db: SupabaseClient, rackId: string): Promise<RackDeviceRow[]> {
  const { data, error } = await db.from("rack_devices").select("*").eq("rack_id", rackId).order("start_u");
  if (error) throw new Error(`listRackDevices: ${error.message}`);
  return data as RackDeviceRow[];
}

/** Reconcile the rack's placements to exactly `rows`: upsert present ids, delete missing ones.
 *  One call serves insert, move, edit, delete, undo, and redo alike. */
export async function replaceRackDevices(
  db: SupabaseClient, rackId: string, rows: RackDeviceInput[],
): Promise<void> {
  const existing = await listRackDevices(db, rackId);
  const keep = new Set(rows.map((r) => r.id));
  const toDelete = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (toDelete.length > 0) {
    const { error } = await db.from("rack_devices").delete().in("id", toDelete);
    if (error) throw new Error(`replaceRackDevices(delete): ${error.message}`);
  }
  if (rows.length > 0) {
    const payload = rows.map((r) => ({ ...r, rack_id: rackId, updated_at: new Date().toISOString() }));
    const { error } = await db.from("rack_devices").upsert(payload, { onConflict: "id" });
    if (error) throw new Error(`replaceRackDevices(upsert): ${error.message}`);
  }
}

/** rack_units per template id — the occupancy validator's lookup table. */
export async function templateHeights(db: SupabaseClient): Promise<Record<string, number>> {
  const { data, error } = await db.from("device_templates").select("id, rack_units");
  if (error) throw new Error(`templateHeights: ${error.message}`);
  return Object.fromEntries((data ?? []).map((r: { id: string; rack_units: number }) => [r.id, r.rack_units]));
}
```

- [ ] **Step 4: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test` → silent / green (repository is a thin wrapper; behavior is exercised through Task 4's action validation and the browser walkthrough, matching the codebase's existing pattern).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0004_rack_devices.sql src/features/racks/repository.ts
git commit -m "racks: migration 0004 rack_devices + repository

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Server actions (`racks/actions.ts`) + template-delete friendly error

**Files:**
- Create: `src/features/racks/actions.ts`
- Modify: `src/features/device-library/actions.ts` (deleteDeviceTemplateAction ~line 91 — friendly FK message)

**Interfaces:**
- Consumes: Task 1 (`canPlace`, `validateDeviceCode`, `minRackHeight`), Task 3 repository.
- Produces (used by Task 10):

```ts
export async function saveRackLayoutAction(rackId: string, devices: RackDeviceInput[]): Promise<{ ok: boolean; error?: string }>;
export async function updateRackAction(rackId: string, patch: { name?: string | null; heightU?: number }): Promise<{ ok: boolean; error?: string }>;
```

- [ ] **Step 1: Write the actions**

```ts
// src/features/racks/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { getRack, replaceRackDevices, listRackDevices, templateHeights, updateRack, type RackDeviceInput } from "./repository";
import { canPlace, validateDeviceCode, minRackHeight, type PlacementLike } from "./rackOps";

function toPlacementLike(rows: { id: string; device_template_id?: string; deviceTemplateId?: string; code: string; start_u?: number; startU?: number }[]): PlacementLike[] {
  return rows.map((r) => ({
    id: r.id,
    deviceTemplateId: (r.device_template_id ?? r.deviceTemplateId)!,
    code: r.code,
    startU: (r.start_u ?? r.startU)!,
  }));
}

/** Reconcile the whole layout. Validates codes + occupancy against FRESH template heights so a
 *  racing template edit or stale client can't produce an overlapping rack. */
export async function saveRackLayoutAction(
  rackId: string, devices: RackDeviceInput[],
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    const [rack, ru] = await Promise.all([getRack(db, rackId), templateHeights(db)]);
    const seen = new Set<string>();
    for (const d of devices) {
      const codeErr = validateDeviceCode(d.code);
      if (codeErr) return { ok: false, error: codeErr };
      if (seen.has(d.code)) return { ok: false, error: `Duplicate ID ${d.code} in this rack` };
      seen.add(d.code);
      if (!(d.device_template_id in ru)) return { ok: false, error: "A placed device's template no longer exists" };
    }
    const like = toPlacementLike(devices);
    for (const d of like) {
      const others = like.filter((x) => x.id !== d.id);
      if (!canPlace(others, ru, d.startU, ru[d.deviceTemplateId], rack.height_u)) {
        return { ok: false, error: "Those rack units are already occupied" };
      }
    }
    await replaceRackDevices(db, rackId, devices);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath(`/racks/${rackId}`);
  return { ok: true };
}

export async function updateRackAction(
  rackId: string, patch: { name?: string | null; heightU?: number },
): Promise<{ ok: boolean; error?: string }> {
  const db = createServiceClient();
  try {
    if (patch.heightU !== undefined) {
      if (!Number.isInteger(patch.heightU) || patch.heightU < 1 || patch.heightU > 60) {
        return { ok: false, error: "Height must be 1–60 U" };
      }
      const [rows, ru] = await Promise.all([listRackDevices(db, rackId), templateHeights(db)]);
      const floor = minRackHeight(toPlacementLike(rows), ru);
      if (patch.heightU < floor) {
        return { ok: false, error: `Devices occupy up to U${floor} — move them before shrinking` };
      }
    }
    await updateRack(db, rackId, patch);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
  revalidatePath(`/racks/${rackId}`);
  revalidatePath("/racks");
  return { ok: true };
}
```

- [ ] **Step 2: Friendly template-delete error**

In `src/features/device-library/actions.ts`, `deleteDeviceTemplateAction` currently throws raw errors. Change it to:

```ts
export async function deleteDeviceTemplateAction(id: string): Promise<void> {
  const db = createServiceClient();
  try {
    await deleteDeviceTemplate(db, id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg.includes("foreign key constraint")) {
      throw new Error("This device is placed in a rack — remove it from all racks first");
    }
    throw e;
  }
  revalidatePath("/device-library");
}
```

(Signature stays `Promise<void>`/throwing — `EditorLauncher.confirmDeleteNow` already catches and displays `e.message`.)

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit && npm test` → silent / green.

- [ ] **Step 4: Commit**

```bash
git add src/features/racks/actions.ts src/features/device-library/actions.ts
git commit -m "racks: layout reconcile + rack update actions; friendly placed-template delete error

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Pure rack renderer (`RackFrame.tsx`)

**Files:**
- Create: `src/features/racks/RackFrame.tsx`
- Test: `src/features/racks/RackFrame.test.tsx`

**Interfaces:**
- Consumes: `renderFace`, `frameDims` (existing); `RU_PX`, `PX_PER_IN`, `RAIL_WIDTH_IN` from geometry; `Face` from `@/domain/faceplate`.
- Produces (used by Tasks 8, 9):

```ts
export const RACK_INTERIOR_W: number; // 912 (19in * 48)
export const RACK_GUTTER_L: number;   // 30 — RU-number gutter left of the frame
export const RACK_PAD: number;        // 10 — outer enclosure padding
export interface RackPlacementRender {
  id: string; startU: number;
  template: { rackUnits: number; widthIn: number; rackMounted: boolean; frontFace: Face; backFace: Face };
}
export function rackSvgSize(heightU: number): { width: number; height: number };
export function ruTopY(startU: number, rackUnits: number, heightU: number): number; // svg y of the span's top edge
export function RackFrame({ heightU, placements, side }: { heightU: number; placements: RackPlacementRender[]; side: "FRONT" | "BACK" }): JSX-element;
```

- [ ] **Step 1: Write the failing tests**

```tsx
// src/features/racks/RackFrame.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RackFrame, ruTopY, rackSvgSize, RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { emptyFace, type Face } from "@/domain/faceplate";

const face: Face = emptyFace();
const tpl = { rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: face, backFace: face };

describe("rack geometry", () => {
  it("sizes the svg from the rack height", () => {
    const { height } = rackSvgSize(12);
    expect(height).toBeGreaterThan(12 * RU_PX); // interior + padding
  });
  it("ruTopY puts U1 at the bottom", () => {
    // a 1U device at U1 sits one RU above the interior bottom
    expect(ruTopY(1, 1, 12)).toBeGreaterThan(ruTopY(12, 1, 12));
    expect(ruTopY(12, 1, 12)).toBeLessThan(RU_PX); // top slot near the top edge
  });
});

describe("RackFrame", () => {
  it("renders rails, one slot marker per RU, and RU numbers", () => {
    render(<svg>{RackFrame({ heightU: 4, placements: [], side: "FRONT" })}</svg>);
    expect(screen.getAllByTestId("rack-slot")).toHaveLength(4);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
  it("renders a placed device's faceplate at its RU", () => {
    render(
      <svg>
        {RackFrame({ heightU: 4, placements: [{ id: "d1", startU: 2, template: tpl }], side: "FRONT" })}
      </svg>,
    );
    expect(screen.getByTestId("rack-device-d1")).toBeInTheDocument();
    // occupied RU no longer shows a free-slot marker
    expect(screen.getAllByTestId("rack-slot")).toHaveLength(3);
  });
  it("interior width is the 19-inch rail span", () => {
    expect(RACK_INTERIOR_W).toBe(912);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test RackFrame` → FAIL (module missing).

- [ ] **Step 3: Implement**

```tsx
// src/features/racks/RackFrame.tsx
// PURE rack renderer: enclosure, 19" rails with per-RU holes, bottom-up RU numbers, free-slot
// markers, and each placement's faceplate via the existing pure renderFace. No interactivity —
// RackCanvas overlays that (same split as Faceplate/EditorCanvas).
import { renderFace } from "@/features/device-library/faceplate/Faceplate";
import { RU_PX, PX_PER_IN, RAIL_WIDTH_IN } from "@/domain/faceplate-geometry";
import type { Face } from "@/domain/faceplate";

export const RACK_INTERIOR_W = RAIL_WIDTH_IN * PX_PER_IN; // 912
export const RACK_GUTTER_L = 30; // RU numbers live left of the enclosure
export const RACK_PAD = 10;      // enclosure wall thickness

export interface RackPlacementRender {
  id: string;
  startU: number;
  template: { rackUnits: number; widthIn: number; rackMounted: boolean; frontFace: Face; backFace: Face };
}

export function rackSvgSize(heightU: number): { width: number; height: number } {
  return {
    width: RACK_GUTTER_L + RACK_PAD * 2 + RACK_INTERIOR_W,
    height: RACK_PAD * 2 + heightU * RU_PX,
  };
}

/** svg-y of the TOP edge of a span starting at startU (bottom-up numbering). */
export function ruTopY(startU: number, rackUnits: number, heightU: number): number {
  const topU = startU + rackUnits - 1;
  return RACK_PAD + (heightU - topU) * RU_PX;
}

const HOLE_R = 3.5;

export function RackFrame({ heightU, placements, side }: {
  heightU: number; placements: RackPlacementRender[]; side: "FRONT" | "BACK";
}) {
  const { width, height } = rackSvgSize(heightU);
  const x0 = RACK_GUTTER_L;                 // enclosure left
  const ix = x0 + RACK_PAD;                 // interior left (rail outer edge)
  const occupied = new Set<number>();
  for (const p of placements) {
    for (let u = p.startU; u < p.startU + p.template.rackUnits; u++) occupied.add(u);
  }
  const units = Array.from({ length: heightU }, (_, i) => i + 1);

  return (
    <g data-testid="rack-frame">
      {/* enclosure */}
      <rect x={x0} y={0} width={width - x0} height={height} rx={8} fill="#f5f5f5" stroke="#d4d4d4" />
      <rect x={ix} y={RACK_PAD} width={RACK_INTERIOR_W} height={heightU * RU_PX} fill="#ffffff" stroke="#e5e5e5" />
      {units.map((u) => {
        const y = ruTopY(u, 1, heightU);
        return (
          <g key={u}>
            {/* RU number + boundary line + rail holes */}
            <text x={RACK_GUTTER_L - 6} y={y + RU_PX / 2 + 3} textAnchor="end" fontSize={10} fill="#a3a3a3">{u}</text>
            <line x1={ix} x2={ix + RACK_INTERIOR_W} y1={y} y2={y} stroke="#f0f0f0" />
            <circle cx={ix + 9} cy={y + RU_PX / 2} r={HOLE_R} fill="none" stroke="#c4c4c4" />
            <circle cx={ix + RACK_INTERIOR_W - 9} cy={y + RU_PX / 2} r={HOLE_R} fill="none" stroke="#c4c4c4" />
            {!occupied.has(u) && (
              <circle data-testid="rack-slot" cx={ix + RACK_INTERIOR_W / 2} cy={y + RU_PX / 2} r={7}
                fill="none" stroke="#bfdbfe" strokeWidth={1.5} />
            )}
          </g>
        );
      })}
      {placements.map((p) => {
        const y = ruTopY(p.startU, p.template.rackUnits, heightU);
        const face = side === "FRONT" ? p.template.frontFace : p.template.backFace;
        const opts = { widthIn: p.template.widthIn, rackUnits: p.template.rackUnits, rackMounted: p.template.rackMounted };
        return (
          <g key={p.id} data-testid={`rack-device-${p.id}`} transform={`translate(${ix}, ${y})`}>
            {renderFace(face, opts)}
          </g>
        );
      })}
    </g>
  );
}
```

*(If `renderFace`'s frame for a rack-mounted device is narrower than 912 — it is exactly 912 for `rackMounted: true` since ears pad to 19" — non-rack-mounted templates render left-aligned; acceptable for 2b.)*

- [ ] **Step 4: Run to green** — `npm test RackFrame`, then full `npm test` + `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add src/features/racks/RackFrame.tsx src/features/racks/RackFrame.test.tsx
git commit -m "racks: pure RackFrame renderer composing device faceplates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Promote the shell app-wide (`AppShell`)

**Files:**
- Create: `src/features/shell/AppShell.tsx` (moved/generalized from `DeviceLibraryShell`)
- Create: `src/features/shell/AppSidebar.tsx` (moved from device-library; + Racks item)
- Modify: `src/app/layout.tsx` (wrap children in AppShell)
- Modify: `src/app/device-library/layout.tsx` (tabs only — shell comes from root)
- Modify: `src/app/page.tsx` (redirect to /racks)
- Delete: `src/features/device-library/DeviceLibraryShell.tsx`, `src/features/device-library/AppSidebar.tsx`, `src/features/grid/RackGrid.tsx` (+ its test if present), `src/features/locations/CreateRackForm.tsx` usage from home (form itself is restyled in Task 7 — keep the file)

**Interfaces:**
- Produces: `AppShell({ children })` (client; page title derived from pathname), used by the root layout only. Sidebar nav: Racks (`tabler:server-2`, href `/racks`) and Device Library both live links; active state derived from pathname (no more hardcoded `active`).

- [ ] **Step 1: Move + generalize the shell**

Create `src/features/shell/AppShell.tsx` with the exact contents of `src/features/device-library/DeviceLibraryShell.tsx`, renamed export `AppShell`, plus a pathname-derived title and WITHOUT the tabs block (tabs are device-library-specific):

```tsx
// Replace the DeviceLibraryTabs import/usage and the hardcoded <h1> with:
import { usePathname } from "next/navigation";

const TITLES: [prefix: string, title: string][] = [
  ["/racks", "Racks"],
  ["/device-library", "Device Library"],
];

// inside the component:
const pathname = usePathname();
const title = TITLES.find(([p]) => pathname.startsWith(p))?.[1] ?? "Rack Designer";
// ... <h1 className="text-lg font-bold tracking-tight">{title}</h1>
// and the content area renders {children} directly (no tabs, no max-width change):
//   <div className="px-6"><div className="py-4 pb-12">{children}</div></div>
```

Everything else (collapse state, localStorage key `dl-sidebar-collapsed`, hamburger, notebook button placeholder) stays identical.

- [ ] **Step 2: Move + extend the sidebar**

Create `src/features/shell/AppSidebar.tsx` = current `AppSidebar.tsx` with two changes:

```tsx
// nav items get hrefs + pathname-derived active state:
import { usePathname } from "next/navigation";
// in AppSidebar():
const pathname = usePathname();
// primary nav second block becomes:
<nav className="space-y-0.5">
  <NavItem icon="tabler:server-2" label="Racks" href="/racks" active={pathname.startsWith("/racks")} />
  <NavItem icon="tabler:book-2" label="Device Library" href="/device-library" active={pathname.startsWith("/device-library")} />
  <NavItem icon="tabler:users" label="Users & Permissions" />
  <NavItem icon="tabler:settings" label="Settings & Billing" />
</nav>
```

(Import `SIDEBAR_WIDTH`/`SIDEBAR_COLLAPSED` consumers: AppShell imports from `./AppSidebar`.)

- [ ] **Step 3: Root layout + redirects + cleanup**

`src/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/features/shell/AppShell";

export const metadata: Metadata = {
  title: "Network Documentation Platform",
  description: "Rack builder & network documentation",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
```

(Also remove the dark `--background/--foreground` body colors in `src/app/globals.css` — set `:root { --background: #fafafa; --foreground: #171717; }` so nothing outside the shell renders dark.)

`src/app/device-library/layout.tsx`:

```tsx
import { DeviceLibraryTabs } from "@/features/device-library/DeviceLibraryTabs";

export default function DeviceLibraryLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="pb-4"><DeviceLibraryTabs /></div>
      {children}
    </>
  );
}
```

`src/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/racks");
}
```

Delete `src/features/device-library/DeviceLibraryShell.tsx`, `src/features/device-library/AppSidebar.tsx`, and `src/features/grid/RackGrid.tsx` (`git rm`; first `grep -rn "RackGrid\|DeviceLibraryShell" src/` — the only referrers are the old home page and the old layout, both rewritten here; move any RackGrid test to deletion too).

Create a placeholder `src/app/racks/page.tsx` so the redirect resolves (replaced in Task 7):

```tsx
export default function RacksPage() {
  return <p className="text-sm text-neutral-500">Racks coming in the next task.</p>;
}
```

- [ ] **Step 4: Verify** — `npx tsc --noEmit && npm test` green; then browser-check `/` redirects to `/racks` inside the shell, `/device-library` still shows tabs + table, sidebar Racks/Device Library links navigate and highlight.

- [ ] **Step 5: Commit**

```bash
git add -A src/app src/features/shell src/features/device-library src/features/grid
git commit -m "shell: promote light AppShell app-wide, Racks nav item, retire dark home

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `/racks` list page

**Files:**
- Create: `src/app/racks/page.tsx` (replace placeholder)
- Create: `src/features/racks/RacksTable.tsx`
- Create: `src/features/racks/CreateRackModal.tsx`
- Test: `src/features/racks/RacksTable.test.tsx`

**Interfaces:**
- Consumes: `listRacksWithPath(db)` → `RackWithPath { id, label, siteCode, floorCode, roomCode, rackCode, heightU }`; `createRackWithHierarchyAction(formData)` (existing, FormData fields siteCode/floorCode/roomCode/roomType/rackCode/heightU); device counts via one extra query.
- Produces: `RacksTable({ racks })` where `racks: (RackWithPath & { deviceCount: number })[]`; rows link to `/racks/[id]`.

- [ ] **Step 1: Failing table test**

```tsx
// src/features/racks/RacksTable.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RacksTable } from "./RacksTable";

const racks = [
  { id: "r1", label: "HQ/28/SL/RK001", siteCode: "HQ", floorCode: "28", roomCode: "SL", roomType: "other" as const, rackCode: "RK001", heightU: 42, deviceCount: 3 },
];

describe("RacksTable", () => {
  it("renders a linked row per rack with path, height, and device count", () => {
    render(<RacksTable racks={racks} />);
    const link = screen.getByRole("link", { name: /RK001/ });
    expect(link).toHaveAttribute("href", "/racks/r1");
    expect(screen.getByText("HQ/28/SL/RK001")).toBeInTheDocument();
    expect(screen.getByText("42 U")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });
  it("shows an empty state", () => {
    render(<RacksTable racks={[]} />);
    expect(screen.getByText(/no racks yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test RacksTable` → FAIL.

- [ ] **Step 3: Implement the table + modal + page**

```tsx
// src/features/racks/RacksTable.tsx
"use client";

import Link from "next/link";
import type { RackWithPath } from "@/features/locations/repository";

export type RackListRow = RackWithPath & { deviceCount: number };

/** Card table of racks — same design language as RackDeviceTable (title/search live in page). */
export function RacksTable({ racks }: { racks: RackListRow[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-200 bg-neutral-50">
            {["Rack", "Path", "Height", "Devices"].map((h) => (
              <th key={h} className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {racks.map((r) => (
            <tr key={r.id} className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50">
              <td className="px-5 py-3 font-medium">
                <Link href={`/racks/${r.id}`} className="text-blue-700 hover:underline">{r.rackCode}</Link>
              </td>
              <td className="px-5 py-3 text-neutral-600">{r.label}</td>
              <td className="px-5 py-3 text-neutral-600">{r.heightU} U</td>
              <td className="px-5 py-3 text-neutral-600">{r.deviceCount}</td>
            </tr>
          ))}
          {racks.length === 0 && (
            <tr><td colSpan={4} className="px-5 py-14 text-center text-sm text-neutral-400">No racks yet. Create one to get started.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
```

```tsx
// src/features/racks/CreateRackModal.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROOM_TYPES } from "@/domain/hierarchy";
import { createRackWithHierarchyAction } from "@/features/locations/actions";

/** The Phase-1 create flow (site/floor/room/rack codes + height) restyled into a light modal. */
export function CreateRackModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function action(formData: FormData) {
    setError(null);
    const res = await createRackWithHierarchyAction(formData);
    if (!res.ok) { setError(res.error ?? "Failed"); return; }
    setOpen(false);
    router.refresh();
  }

  const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";
  return (
    <>
      <button type="button" data-testid="rack-create" onClick={() => setOpen(true)}
        className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9]">
        + Create rack
      </button>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Create rack">
          <form action={action} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Create rack</h3>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] font-semibold text-neutral-600">Site *<input name="siteCode" placeholder="HQ" required className={input} /></label>
              <label className="text-[11px] font-semibold text-neutral-600">Floor *<input name="floorCode" placeholder="28" required className={input} /></label>
              <label className="text-[11px] font-semibold text-neutral-600">Room *<input name="roomCode" placeholder="SL" required className={input} /></label>
              <label className="text-[11px] font-semibold text-neutral-600">Room type
                <select name="roomType" defaultValue="other" className={input}>
                  {ROOM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-[11px] font-semibold text-neutral-600">Rack code *<input name="rackCode" placeholder="RK001" required className={input} /></label>
              <label className="text-[11px] font-semibold text-neutral-600">Height (U) *<input name="heightU" type="number" defaultValue={42} min={1} max={60} required className={input} /></label>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Cancel</button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Create</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
```

```tsx
// src/app/racks/page.tsx
import { createServiceClient } from "@/lib/supabase/server";
import { listRacksWithPath } from "@/features/locations/repository";
import { RacksTable } from "@/features/racks/RacksTable";
import { CreateRackModal } from "@/features/racks/CreateRackModal";

export const dynamic = "force-dynamic";

export default async function RacksPage() {
  const db = createServiceClient();
  const racks = await listRacksWithPath(db);
  const { data: counts } = await db.from("rack_devices").select("rack_id");
  const byRack = new Map<string, number>();
  for (const row of (counts ?? []) as { rack_id: string }[]) {
    byRack.set(row.rack_id, (byRack.get(row.rack_id) ?? 0) + 1);
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Racks</h2>
        <CreateRackModal />
      </div>
      <RacksTable racks={racks.map((r) => ({ ...r, deviceCount: byRack.get(r.id) ?? 0 }))} />
    </div>
  );
}
```

- [ ] **Step 4: Verify** — `npm test RacksTable` green; full suite + tsc; browser: `/racks` lists existing racks with paths, Create modal creates one.

- [ ] **Step 5: Commit**

```bash
git add src/app/racks src/features/racks/RacksTable.tsx src/features/racks/RacksTable.test.tsx src/features/racks/CreateRackModal.tsx
git commit -m "racks: list page with create-rack modal

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Add-device picker

**Files:**
- Modify: `src/features/device-library/repository.ts` (add `listTemplatesForType` after `listDeviceTemplates`)
- Create: `src/features/racks/AddDevicePicker.tsx`
- Test: `src/features/racks/AddDevicePicker.test.tsx`

**Interfaces:**
- Consumes: `toEditableTemplate`, `DeviceTemplateRow`; pure `renderFace` + `frameDims` for previews.
- Produces (used by Task 10):

```ts
// repository:
export interface PickerTemplate extends EditableTemplate { brandName: string | null; }
export function listTemplatesForType(db, deviceTypeId): Promise<PickerTemplate[]>;
// component:
export function AddDevicePicker({ typeName, templates, onInsert, onClose }: {
  typeName: string;
  templates: PickerTemplate[];
  onInsert: (t: PickerTemplate) => void;
  onClose: () => void;
});
```

- [ ] **Step 1: Repository function**

Append to `src/features/device-library/repository.ts`:

```ts
export interface PickerTemplate extends EditableTemplate { brandName: string | null; }

/** Templates of one device type, with brand names + faces — feeds the rack builder's picker. */
export async function listTemplatesForType(
  db: SupabaseClient, deviceTypeId: string,
): Promise<PickerTemplate[]> {
  const { data, error } = await db.from("device_templates")
    .select("*, brands(name)")
    .eq("device_type_id", deviceTypeId)
    .order("name");
  if (error) throw new Error(`listTemplatesForType: ${error.message}`);
  return ((data ?? []) as (DeviceTemplateRow & { brands: { name: string } | null })[]).map((r) => ({
    ...toEditableTemplate(r),
    brandName: r.brands?.name ?? null,
  }));
}
```

- [ ] **Step 2: Failing component test**

```tsx
// src/features/racks/AddDevicePicker.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddDevicePicker } from "./AddDevicePicker";
import { emptyFace } from "@/domain/faceplate";
import type { PickerTemplate } from "@/features/device-library/repository";

const tpl = (id: string, name: string): PickerTemplate => ({
  id, name, brandId: null, brandName: "cisco", deviceTypeId: "t1",
  rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: emptyFace(), backFace: emptyFace(),
});

describe("AddDevicePicker", () => {
  it("lists templates of the type; selecting shows previews; Insert fires with the template", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<AddDevicePicker typeName="Switch" templates={[tpl("a", "cisco 48p"), tpl("b", "cisco 24p")]} onInsert={onInsert} onClose={() => {}} />);
    expect(screen.getByText("Add device")).toBeInTheDocument();
    expect(screen.getByText("cisco 24p")).toBeInTheDocument();
    await user.click(screen.getByText("cisco 48p"));
    expect(screen.getByText(/1 RU/)).toBeInTheDocument();
    expect(screen.getAllByTestId("faceplate-svg").length).toBe(2); // front + back previews
    await user.click(screen.getByTestId("picker-insert"));
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });
  it("empty type shows a hint and no Insert", () => {
    render(<AddDevicePicker typeName="UPS" templates={[]} onInsert={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no .* templates yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("picker-insert")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npm test AddDevicePicker` → FAIL.

- [ ] **Step 4: Implement**

```tsx
// src/features/racks/AddDevicePicker.tsx
"use client";

import { useState } from "react";
import Link from "next/link";
import { Faceplate } from "@/features/device-library/faceplate/Faceplate";
import type { PickerTemplate } from "@/features/device-library/repository";

/** PatchDocs-style Add-device modal: templates of one type on the left, faceplate previews +
 *  Insert on the right. The caller decides where the insert lands. */
export function AddDevicePicker({ typeName, templates, onInsert, onClose }: {
  typeName: string;
  templates: PickerTemplate[];
  onInsert: (t: PickerTemplate) => void;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = templates.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Add device">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold">Add device</h3>
          <button type="button" aria-label="Close" onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100">✕</button>
        </div>
        <p className="mt-0.5 text-sm text-neutral-500">{typeName}</p>
        <div className="mt-4 grid grid-cols-[240px_1fr] gap-4">
          <div className="max-h-72 space-y-1.5 overflow-y-auto rounded-xl border border-neutral-200 p-2">
            {templates.length === 0 && (
              <p className="p-4 text-center text-sm text-neutral-400">No {typeName} templates yet.</p>
            )}
            {templates.map((t) => (
              <button key={t.id} type="button" onClick={() => setSelectedId(t.id)}
                className={`block w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  t.id === selectedId ? "border-blue-500 bg-blue-50" : "border-neutral-200 hover:bg-neutral-50"}`}>
                {t.name}
              </button>
            ))}
          </div>
          <div className="flex min-h-72 flex-col rounded-xl border border-neutral-200 p-3">
            {selected ? (
              <>
                <div className="min-h-0 flex-1 space-y-2 overflow-auto">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Front</p>
                  <div className="[&_svg]:h-auto [&_svg]:max-w-full"><Faceplate face={selected.frontFace} side="FRONT" widthIn={selected.widthIn} rackUnits={selected.rackUnits} rackMounted={selected.rackMounted} /></div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Back</p>
                  <div className="[&_svg]:h-auto [&_svg]:max-w-full"><Faceplate face={selected.backFace} side="BACK" widthIn={selected.widthIn} rackUnits={selected.rackUnits} rackMounted={selected.rackMounted} /></div>
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-neutral-200 pt-3 text-sm text-neutral-600">
                  <span>{selected.rackUnits} RU · Brand: {selected.brandName ?? "—"}</span>
                  <button type="button" data-testid="picker-insert" onClick={() => onInsert(selected)}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Insert device</button>
                </div>
              </>
            ) : (
              <p className="m-auto text-sm text-neutral-400">Select a device to see its details.</p>
            )}
          </div>
        </div>
        <div className="mt-4">
          <Link href="/device-library" className="text-sm font-semibold text-blue-700 hover:underline">+ Create Custom Device</Link>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run to green** — `npm test AddDevicePicker`, full suite, tsc.

- [ ] **Step 6: Commit**

```bash
git add src/features/racks/AddDevicePicker.tsx src/features/racks/AddDevicePicker.test.tsx src/features/device-library/repository.ts
git commit -m "racks: type->template Add-device picker with faceplate previews

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Interactive rack canvas (`RackCanvas.tsx`)

**Files:**
- Create: `src/features/racks/RackCanvas.tsx`
- Test: `src/features/racks/RackCanvas.test.tsx`

**Interfaces:**
- Consumes: Task 5 (`RackFrame`, `rackSvgSize`, `ruTopY`, `RACK_PAD`, `RACK_GUTTER_L`), `RU_PX`.
- Produces (used by Task 10):

```ts
export function RackCanvas(props: {
  heightU: number;
  placements: RackPlacementRender[]; // Task 5 type
  side: "FRONT" | "BACK";
  zoom?: number;                                 // user zoom multiplier (default 1) — final scale = fit × zoom
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddAt: (u: number) => void;                  // click a free RU
  onMove: (id: string, targetU: number) => void; // grip-handle drag (fires per pointermove)
  onDelete: (id: string) => void;                // Delete/Backspace on selection
});
```

In the implementation, destructure `zoom = 1`, compute `const finalScale = scale * zoom;` and use
`finalScale` in the transform style, the drag math (`RU_PX * (scaleRef.current || 1)` becomes
`RU_PX * finalScaleRef.current` — keep one ref updated with the final scale), and the container
width/height (`width * zoom`, `height * zoom` so scrolling accounts for zoom).

Layout contract: the component renders `<svg>` with `RackFrame` + an absolutely-positioned overlay div (EditorCanvas pattern) scaled with a `transform: scale()` container sized by ResizeObserver (default scale 1 in jsdom). Overlay children:
- per free RU: a hit strip `data-testid={'ru-hit-' + u}` spanning the interior width at that RU;
- per placement: a box `data-testid={'rack-dev-' + id}` (click → select; shows a blue frame and a right-edge grip `data-testid={'rack-grip-' + id}` when selected; pointer-dragging the grip converts dy to RU delta: `targetU = origStartU - Math.round(dyPx / (RU_PX * scale))` and calls `onMove`).

- [ ] **Step 1: Failing tests**

```tsx
// src/features/racks/RackCanvas.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RackCanvas } from "./RackCanvas";
import { emptyFace } from "@/domain/faceplate";
import { RU_PX } from "@/domain/faceplate-geometry";

const tpl = { rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: emptyFace(), backFace: emptyFace() };
const placements = [{ id: "d1", startU: 2, template: tpl }];
const base = { heightU: 4, placements, side: "FRONT" as const, onSelect: vi.fn(), onAddAt: vi.fn(), onMove: vi.fn(), onDelete: vi.fn() };

describe("RackCanvas", () => {
  it("clicking a free RU strip fires onAddAt with that U", () => {
    const onAddAt = vi.fn();
    render(<RackCanvas {...base} selectedId={null} onAddAt={onAddAt} />);
    fireEvent.click(screen.getByTestId("ru-hit-4"));
    expect(onAddAt).toHaveBeenCalledWith(4);
  });
  it("clicking a device selects it; grip drag fires onMove with the RU target", () => {
    const onSelect = vi.fn(), onMove = vi.fn();
    const { rerender } = render(<RackCanvas {...base} selectedId={null} onSelect={onSelect} onMove={onMove} />);
    fireEvent.click(screen.getByTestId("rack-dev-d1"));
    expect(onSelect).toHaveBeenCalledWith("d1");
    rerender(<RackCanvas {...base} selectedId="d1" onSelect={onSelect} onMove={onMove} />);
    const grip = screen.getByTestId("rack-grip-d1");
    fireEvent.pointerDown(grip, { clientX: 0, clientY: 100, button: 0 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 100 - RU_PX }); // up one RU → U3
    fireEvent.pointerUp(window, { clientX: 0, clientY: 100 - RU_PX });
    expect(onMove.mock.calls.at(-1)).toEqual(["d1", 3]);
  });
  it("Delete key removes the selection (not while typing in an input)", () => {
    const onDelete = vi.fn();
    render(<RackCanvas {...base} selectedId="d1" onDelete={onDelete} />);
    fireEvent.keyDown(window, { key: "Backspace" });
    expect(onDelete).toHaveBeenCalledWith("d1");
  });
  it("occupied RUs have no hit strip", () => {
    render(<RackCanvas {...base} selectedId={null} />);
    expect(screen.queryByTestId("ru-hit-2")).toBeNull();
    expect(screen.getByTestId("ru-hit-1")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test RackCanvas` → FAIL.

- [ ] **Step 3: Implement**

```tsx
// src/features/racks/RackCanvas.tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { RackFrame, rackSvgSize, ruTopY, RACK_GUTTER_L, RACK_PAD, RACK_INTERIOR_W, type RackPlacementRender } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";

/** Interactive layer over the pure RackFrame (EditorCanvas pattern): fit-to-width scaling,
 *  free-RU click targets, device selection + grip-handle RU dragging, Delete key. */
export function RackCanvas(props: {
  heightU: number;
  placements: RackPlacementRender[];
  side: "FRONT" | "BACK";
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onAddAt: (u: number) => void;
  onMove: (id: string, targetU: number) => void;
  onDelete: (id: string) => void;
}) {
  const { heightU, placements, side, selectedId } = props;
  const { width, height } = rackSvgSize(heightU);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // Fit to the host's width (vertical scrolling handles tall racks).
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = host.clientWidth;
      if (w > 0) setScale(Math.min(1, w / width));
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [width]);

  // Grip drag: convert vertical pixel movement to RU movement (up = +U).
  const [drag, setDrag] = useState<{ id: string; startY: number; origU: number } | null>(null);
  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const dyRU = Math.round((e.clientY - drag!.startY) / (RU_PX * (scaleRef.current || 1)));
      props.onMove(drag!.id, drag!.origU - dyRU);
    }
    function onUp() { setDrag(null); }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [drag, props]);

  // Delete/Backspace removes the selection (unless typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target as HTMLElement | null;
      if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.tagName === "SELECT" || t?.isContentEditable) return;
      if (selectedId) { e.preventDefault(); props.onDelete(selectedId); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, props]);

  const occupied = new Set<number>();
  for (const p of placements) for (let u = p.startU; u < p.startU + p.template.rackUnits; u++) occupied.add(u);
  const ix = RACK_GUTTER_L + RACK_PAD;

  return (
    <div ref={hostRef} className="w-full">
      <div className="relative origin-top-left" style={{ transform: `scale(${scale})`, width, height }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} onClick={() => props.onSelect(null)}>
          <RackFrame heightU={heightU} placements={placements} side={side} />
        </svg>
        {/* free-RU click strips */}
        {Array.from({ length: heightU }, (_, i) => i + 1).filter((u) => !occupied.has(u)).map((u) => (
          <div key={u} data-testid={`ru-hit-${u}`} title={`Add device at U${u}`}
            onClick={(e) => { e.stopPropagation(); props.onAddAt(u); }}
            className="absolute cursor-pointer rounded hover:bg-blue-50/60"
            style={{ left: ix, top: ruTopY(u, 1, heightU), width: RACK_INTERIOR_W, height: RU_PX }} />
        ))}
        {/* device hit boxes */}
        {placements.map((p) => {
          const top = ruTopY(p.startU, p.template.rackUnits, heightU);
          const h = p.template.rackUnits * RU_PX;
          const selected = p.id === selectedId;
          return (
            <div key={p.id} data-testid={`rack-dev-${p.id}`}
              onClick={(e) => { e.stopPropagation(); props.onSelect(p.id); }}
              className={`absolute ${selected ? "z-10" : ""}`}
              style={{ left: ix, top, width: RACK_INTERIOR_W, height: h, cursor: "pointer" }}>
              {selected && (
                <>
                  <div className="pointer-events-none absolute -inset-0.5 rounded border-2 border-blue-500" />
                  <div data-testid={`rack-grip-${p.id}`} title="Drag to move"
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      e.stopPropagation();
                      setDrag({ id: p.id, startY: e.clientY, origU: p.startU });
                    }}
                    className="absolute -right-1 top-1/2 flex h-8 w-4 -translate-y-1/2 cursor-grab items-center justify-center rounded bg-blue-600 text-white">
                    <svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to green** — `npm test RackCanvas`, full suite, tsc.

- [ ] **Step 5: Commit**

```bash
git add src/features/racks/RackCanvas.tsx src/features/racks/RackCanvas.test.tsx
git commit -m "racks: interactive RackCanvas (free-RU clicks, select, grip move, delete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Builder page — palette, sidebar, undo/redo, autosave

**Files:**
- Create: `src/app/racks/[id]/page.tsx` (server load)
- Create: `src/features/racks/RackBuilder.tsx` (client assembly)
- Create: `src/features/racks/RackDeviceSettings.tsx` (sidebar panel)
- Test: `src/features/racks/RackDeviceSettings.test.tsx`

**Interfaces:**
- Consumes: everything above — `RackCanvas`, `AddDevicePicker` + `listTemplatesForType`, `rackOps` (`nextCode`, `resolveMove`, `findFreeSlot`, `canPlace`, `validateDeviceCode`, `minRackHeight`), `history`, `saveRackLayoutAction`, `updateRackAction`, `getRack`, `listRackDevices`, `listDeviceTypes` (category='rack'), `listDeviceTemplates`-style joins.
- Produces: the working `/racks/[id]` page.

Client state model (inside `RackBuilder`):

```ts
interface PlacementDraft {
  id: string; deviceTemplateId: string; code: string; name: string | null;
  startU: number; side: "front"; status: "planned" | "installed" | "verified";
  manufacturer: string | null; modelName: string | null; serialNumber: string | null;
  purchaseDate: string | null; operationStart: string | null;
}
```

`History<PlacementDraft[]>` holds the layout. `commit(next)` = `setHist(push(hist, next))` + `queueSave(next)`. `queueSave` debounces 600ms then calls `saveRackLayoutAction(rackId, toInputs(next))` (camel→snake mapping) and drives the chip: counter>0 → "Saving…", ok → "Saved", error → red message and the state stays (user can undo). Undo/redo buttons + ⌘Z/⇧⌘Z call `undo/redo` then `queueSave(newPresent)`.

- [ ] **Step 1: Failing sidebar test**

```tsx
// src/features/racks/RackDeviceSettings.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackDeviceSettings } from "./RackDeviceSettings";

const d = {
  id: "d1", deviceTemplateId: "t1", code: "SW01", name: null, startU: 5, side: "front" as const,
  status: "installed" as const, manufacturer: null, modelName: null, serialNumber: null,
  purchaseDate: null, operationStart: null,
};

describe("RackDeviceSettings", () => {
  it("shows the code and fires onChange patches for edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RackDeviceSettings device={d} templateName="cisco 48p" codeError={null} onChange={onChange} onDelete={() => {}} />);
    expect(screen.getByDisplayValue("SW01")).toBeInTheDocument();
    expect(screen.getByText("cisco 48p")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/status/i), "verified");
    expect(onChange).toHaveBeenCalledWith({ status: "verified" });
    await user.type(screen.getByLabelText(/serial/i), "X");
    expect(onChange).toHaveBeenCalledWith({ serialNumber: "X" });
  });
  it("renders a code error and a delete button", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<RackDeviceSettings device={d} templateName="x" codeError="Duplicate ID" onChange={() => {}} onDelete={onDelete} />);
    expect(screen.getByText("Duplicate ID")).toBeInTheDocument();
    await user.click(screen.getByTestId("device-delete"));
    expect(onDelete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test RackDeviceSettings` → FAIL.

- [ ] **Step 3: Implement the sidebar panel**

```tsx
// src/features/racks/RackDeviceSettings.tsx
"use client";

export interface PlacementDraft {
  id: string; deviceTemplateId: string; code: string; name: string | null;
  startU: number; side: "front"; status: "planned" | "installed" | "verified";
  manufacturer: string | null; modelName: string | null; serialNumber: string | null;
  purchaseDate: string | null; operationStart: string | null;
}

const input = "mt-1 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm font-normal focus:border-neutral-400 focus:outline-none";
const label = "block text-[11px] font-semibold text-neutral-600";

/** Selected-device settings: ID (auto SW01, editable), status, inventory. Emits partial patches. */
export function RackDeviceSettings({ device, templateName, codeError, onChange, onDelete }: {
  device: PlacementDraft;
  templateName: string;
  codeError: string | null;
  onChange: (patch: Partial<PlacementDraft>) => void;
  onDelete: () => void;
}) {
  const text = (key: keyof PlacementDraft, lbl: string, type = "text") => (
    <label className={label}>{lbl}
      <input type={type} value={(device[key] as string | null) ?? ""} className={input}
        onChange={(e) => onChange({ [key]: e.target.value === "" ? null : e.target.value } as Partial<PlacementDraft>)} />
    </label>
  );
  return (
    <div className="space-y-3" data-testid="rack-device-settings">
      <div className="text-xs font-bold text-neutral-800">{templateName}</div>
      <label className={label}>ID *
        <input value={device.code} className={input}
          onChange={(e) => onChange({ code: e.target.value.toUpperCase() })} />
      </label>
      {codeError && <p className="text-sm text-red-600">{codeError}</p>}
      {text("name", "Name")}
      <label className={label}>Status
        <select aria-label="Status" value={device.status} className={input}
          onChange={(e) => onChange({ status: e.target.value as PlacementDraft["status"] })}>
          <option value="planned">planned</option>
          <option value="installed">installed</option>
          <option value="verified">verified</option>
        </select>
      </label>
      {text("manufacturer", "Manufacturer")}
      {text("modelName", "Model name")}
      {text("serialNumber", "Serial number")}
      {text("purchaseDate", "Purchase date", "date")}
      {text("operationStart", "Operation start", "date")}
      <button type="button" data-testid="device-delete" onClick={onDelete}
        className="text-left text-xs font-semibold text-red-600 hover:text-red-700">🗑 Remove from rack</button>
    </div>
  );
}
```

- [ ] **Step 4: Implement the builder + page**

```tsx
// src/app/racks/[id]/page.tsx
import { createServiceClient } from "@/lib/supabase/server";
import { getRack, listRackDevices } from "@/features/racks/repository";
import { listDeviceTypes, listTemplatesForType } from "@/features/device-library/repository";
import { RackBuilder } from "@/features/racks/RackBuilder";

export const dynamic = "force-dynamic";

export default async function RackBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceClient();
  const [rack, devices, types] = await Promise.all([
    getRack(db, id), listRackDevices(db, id), listDeviceTypes(db),
  ]);
  const rackTypes = types.filter((t) => t.category === "rack");
  // All templates for all rack types, keyed by type — one round trip per type is fine at this scale.
  const templatesByType = Object.fromEntries(
    await Promise.all(rackTypes.map(async (t) => [t.id, await listTemplatesForType(db, t.id)])),
  );
  return <RackBuilder rack={rack} initialDevices={devices} types={rackTypes} templatesByType={templatesByType} />;
}
```

```tsx
// src/features/racks/RackBuilder.tsx
"use client";

import { useMemo, useRef, useState, useEffect } from "react";
import type { RackRow, RackDeviceRow, RackDeviceInput } from "./repository";
import type { DeviceTypeRow, PickerTemplate } from "@/features/device-library/repository";
import { RackCanvas } from "./RackCanvas";
import { AddDevicePicker } from "./AddDevicePicker";
import { RackDeviceSettings, type PlacementDraft } from "./RackDeviceSettings";
import { saveRackLayoutAction, updateRackAction } from "./actions";
import { nextCode, resolveMove, findFreeSlot, validateDeviceCode, minRackHeight, type PlacementLike } from "./rackOps";
import { createHistory, push, undo, redo, canUndo, canRedo, type History } from "./history";

function fromRow(r: RackDeviceRow): PlacementDraft {
  return {
    id: r.id, deviceTemplateId: r.device_template_id, code: r.code, name: r.name,
    startU: r.start_u, side: "front", status: r.status,
    manufacturer: r.manufacturer, modelName: r.model_name, serialNumber: r.serial_number,
    purchaseDate: r.purchase_date, operationStart: r.operation_start,
  };
}
function toInput(d: PlacementDraft): RackDeviceInput {
  return {
    id: d.id, device_template_id: d.deviceTemplateId, code: d.code, name: d.name,
    start_u: d.startU, side: d.side, status: d.status,
    manufacturer: d.manufacturer, model_name: d.modelName, serial_number: d.serialNumber,
    purchase_date: d.purchaseDate, operation_start: d.operationStart,
  };
}

export function RackBuilder({ rack, initialDevices, types, templatesByType }: {
  rack: RackRow;
  initialDevices: RackDeviceRow[];
  types: DeviceTypeRow[];
  templatesByType: Record<string, PickerTemplate[]>;
}) {
  const [hist, setHist] = useState<History<PlacementDraft[]>>(() => createHistory(initialDevices.map(fromRow)));
  const placements = hist.present;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [side, setSide] = useState<"FRONT" | "BACK">("FRONT");
  const [picker, setPicker] = useState<{ typeId: string; atU: number | null } | null>(null);
  const [zoom, setZoom] = useState(1); // passed to RackCanvas (final scale = fit × zoom)
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allTemplates = useMemo(() => Object.values(templatesByType).flat(), [templatesByType]);
  const templatesById = useMemo(() => Object.fromEntries(allTemplates.map((t) => [t.id, t])), [allTemplates]);
  const ru = useMemo(() => Object.fromEntries(allTemplates.map((t) => [t.id, t.rackUnits])), [allTemplates]);
  const typeCodeByTypeId = useMemo(() => Object.fromEntries(types.map((t) => [t.id, t.code])), [types]);
  const like: PlacementLike[] = placements.map((p) => ({ id: p.id, deviceTemplateId: p.deviceTemplateId, code: p.code, startU: p.startU }));

  function queueSave(next: PlacementDraft[]) {
    setSaveState("saving"); setError(null);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const res = await saveRackLayoutAction(rack.id, next.map(toInput));
      if (!res.ok) { setSaveState("error"); setError(res.error ?? "Save failed"); return; }
      setSaveState("saved");
    }, 600);
  }
  function commit(next: PlacementDraft[]) { setHist((h) => push(h, next)); queueSave(next); }

  // Undo/redo — buttons + keyboard.
  function doUndo() { setHist((h) => { const n = undo(h); if (n !== h) queueSave(n.present); return n; }); }
  function doRedo() { setHist((h) => { const n = redo(h); if (n !== h) queueSave(n.present); return n; }); }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      e.preventDefault();
      if (e.shiftKey) doRedo(); else doUndo();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function insertTemplate(t: PickerTemplate) {
    const at = picker?.atU ?? undefined;
    const slot = findFreeSlot(like, ru, t.rackUnits, rack.height_u, at);
    if (slot === null) { setError("No free slot for that device height"); setPicker(null); return; }
    const typeCode = typeCodeByTypeId[t.deviceTypeId] ?? "DEV";
    const draft: PlacementDraft = {
      id: crypto.randomUUID(), deviceTemplateId: t.id, code: nextCode(like, typeCode), name: null,
      startU: slot, side: "front", status: "installed",
      manufacturer: null, modelName: null, serialNumber: null, purchaseDate: null, operationStart: null,
    };
    commit([...placements, draft]);
    setSelectedId(draft.id);
    setPicker(null);
  }

  const selected = placements.find((p) => p.id === selectedId) ?? null;
  const codeError = selected
    ? validateDeviceCode(selected.code) ??
      (placements.some((p) => p.id !== selected.id && p.code === selected.code) ? "That ID is already used in this rack" : null)
    : null;

  const canvasPlacements = placements
    .filter((p) => templatesById[p.deviceTemplateId])
    .map((p) => ({ id: p.id, startU: p.startU, template: templatesById[p.deviceTemplateId] }));

  return (
    <div className="flex gap-4">
      {/* Palette: rack device types */}
      <div className="w-48 shrink-0 space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Devices</p>
        {types.map((t) => (
          <button key={t.id} type="button" data-testid={`palette-type-${t.code}`}
            onClick={() => setPicker({ typeId: t.id, atU: null })}
            className="block w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm font-medium hover:bg-neutral-50">
            {t.name}
          </button>
        ))}
      </div>

      {/* Canvas + toolbar */}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-neutral-200 bg-white p-0.5 text-sm font-semibold">
            {(["FRONT", "BACK"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSide(s)}
                className={`rounded-md px-3 py-1 ${side === s ? "bg-neutral-900 text-white" : "text-neutral-600"}`}>
                {s === "FRONT" ? "Front" : "Back"}
              </button>
            ))}
          </div>
          <button type="button" data-testid="rack-undo" disabled={!canUndo(hist)} onClick={doUndo}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm disabled:opacity-40">↺</button>
          <button type="button" data-testid="rack-redo" disabled={!canRedo(hist)} onClick={doRedo}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm disabled:opacity-40">↻</button>
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, +(z / 1.25).toFixed(2)))}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm">−</button>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(3, +(z * 1.25).toFixed(2)))}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm">+</button>
          <button type="button" aria-label="Fit" onClick={() => setZoom(1)}
            className="h-8 rounded-lg border border-neutral-200 bg-white px-3 text-sm">Fit</button>
          <span className={`ml-auto text-xs font-semibold ${saveState === "error" ? "text-red-600" : saveState === "saving" ? "text-amber-600" : "text-green-600"}`}>
            {saveState === "error" ? error : saveState === "saving" ? "Saving…" : "✓ Saved"}
          </span>
        </div>
        <div className="max-h-[75vh] overflow-y-auto rounded-2xl border border-neutral-200 bg-white p-4">
          <RackCanvas
            heightU={rack.height_u}
            placements={canvasPlacements}
            side={side}
            zoom={zoom}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onAddAt={(u) => setPicker({ typeId: types[0]?.id ?? "", atU: u })}
            onMove={(id, targetU) => {
              const resolved = resolveMove(like, ru, id, targetU, rack.height_u);
              const cur = placements.find((p) => p.id === id);
              if (!cur || cur.startU === resolved) return;
              commit(placements.map((p) => (p.id === id ? { ...p, startU: resolved } : p)));
            }}
            onDelete={(id) => { commit(placements.filter((p) => p.id !== id)); setSelectedId(null); }}
          />
        </div>
      </div>

      {/* Sidebar */}
      <div className="w-72 shrink-0 rounded-2xl border border-neutral-200 bg-white p-4">
        {selected ? (
          <RackDeviceSettings
            device={selected}
            templateName={templatesById[selected.deviceTemplateId]?.name ?? "Unknown template"}
            codeError={codeError}
            onChange={(patch) => commit(placements.map((p) => (p.id === selected.id ? { ...p, ...patch } : p)))}
            onDelete={() => { commit(placements.filter((p) => p.id !== selected.id)); setSelectedId(null); }}
          />
        ) : (
          <RackSettings rack={rack} minHeight={minRackHeight(like, ru)} />
        )}
      </div>

      {picker && (
        <AddDevicePicker
          typeName={types.find((t) => t.id === picker.typeId)?.name ?? ""}
          templates={templatesByType[picker.typeId] ?? []}
          onInsert={insertTemplate}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

/** Rack settings when nothing is selected: name + height (shrink guarded server-side too). */
function RackSettings({ rack, minHeight }: { rack: RackRow; minHeight: number }) {
  const [name, setName] = useState(rack.name ?? "");
  const [heightU, setHeightU] = useState(rack.height_u);
  const [msg, setMsg] = useState<string | null>(null);
  async function saveField(patch: { name?: string | null; heightU?: number }) {
    setMsg(null);
    const res = await updateRackAction(rack.id, patch);
    if (!res.ok) setMsg(res.error ?? "Save failed");
  }
  const input = "mt-1 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm font-normal focus:border-neutral-400 focus:outline-none";
  return (
    <div className="space-y-3" data-testid="rack-settings">
      <div className="text-xs font-bold text-neutral-800">Rack {rack.code}</div>
      <label className="block text-[11px] font-semibold text-neutral-600">Name
        <input value={name} className={input}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => saveField({ name: name === "" ? null : name })} />
      </label>
      <label className="block text-[11px] font-semibold text-neutral-600">Rack units
        <input type="number" min={Math.max(1, minHeight)} max={60} value={heightU} className={input}
          onChange={(e) => setHeightU(Number(e.target.value))}
          onBlur={() => saveField({ heightU })} />
      </label>
      {msg && <p className="text-sm text-red-600">{msg}</p>}
      <p className="text-xs text-neutral-400">Select a device to edit its settings.</p>
    </div>
  );
}
```

Note: `onAddAt` opens the picker pre-scoped to the FIRST type; the picker header shows the type — clicking a palette type is the primary flow, the RU click is a convenience (PatchDocs also opens a generic picker). If a reviewer flags the first-type default as arbitrary: it is intentional-but-cheap; a type chooser inside the picker is 2c polish.

- [ ] **Step 5: Run everything** — `npm test` green (RackDeviceSettings + all prior), `npx tsc --noEmit` silent.

- [ ] **Step 6: Commit**

```bash
git add src/app/racks src/features/racks
git commit -m "racks: builder page — palette, picker insert w/ auto-IDs, sidebar, undo/redo, autosave

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 11: Full verification (browser)

**Files:** none.

- [ ] **Step 1:** `cd /Users/reubensingh/development/network-doc-platform && npm test && npx tsc --noEmit` → green/silent.
- [ ] **Step 2:** `npx supabase db reset` → migrations 0001–0004 apply cleanly.
- [ ] **Step 3:** Browser walkthrough (preview server "rack-designer-dev", port 3100):
  - `/` redirects to `/racks` inside the light shell; sidebar Racks item active.
  - Create a rack (HQ/28/SL/RK001, 12U) → appears with path + 0 devices; open it.
  - Palette → Switch → picker lists templates with previews → Insert → lands in a free slot with code `SW01`; second insert → `SW02`.
  - Click a free RU → picker → insert lands at that RU.
  - Select a device → grip-drag up/down: moves in whole RUs, refuses overlaps; sidebar shows its settings; rename ID (dup → inline error, invalid chars → rule error); set status/serial.
  - Delete via sidebar and via Backspace (confirmless — undo covers it).
  - Undo/redo (buttons + ⌘Z/⇧⌘Z) walk placements; "Saving…/✓ Saved" chip cycles; reload the page → state persisted.
  - Rack settings: rename; shrink below occupied U → server error surfaces; shrink to a legal height works.
  - Front/Back toggle flips faces; zoom −/+/Fit scale the rack and grip-drag still lands on whole RUs while zoomed.
  - Device Library: deleting a template that's placed → "This device is placed in a rack — remove it from all racks first".
  - No console errors.

**Success criteria:** every bullet observed; then dispatch the final whole-branch review.
