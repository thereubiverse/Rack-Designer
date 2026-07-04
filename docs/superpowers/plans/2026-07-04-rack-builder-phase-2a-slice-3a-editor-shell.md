# Phase 2a · Slice 3a — Rack Device Editor: Shell, Live Preview & Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Slice 1's placeholder `CreateDeviceForm` with the Rack Device Editor modal — header fields, Front/Back + Rack-Mounted toggles, a live read-only `Faceplate` preview driven by editable draft state, and atomic Save that round-trips both faces to Supabase.

**Architecture:** A client-component modal holds a draft (`useDeviceDraft`) and renders the pure Slice 2 `Faceplate` inside an `EditorCanvas` wrapper (the overlay origin 3b/3c will build on — `Faceplate` stays read-only). Persistence extends the Slice 1 repository with Face-typed `getDeviceTemplate` / `updateDeviceTemplate` and structured server actions. Save is atomic (one create or update); Cancel discards.

**Tech Stack:** Next.js 16 (App Router, server actions), React 19, TypeScript 5, Supabase JS, Vitest 2 + @testing-library/react (jsdom).

## Global Constraints

- **Next.js 16 + React 19 + TypeScript 5**; path alias `@/` → `src/`. Server code uses `createServiceClient()` from `@/lib/supabase/server`.
- **Draft-in-state, atomic Save:** the editor edits a draft in client state; Save does a single create (new) or update (existing) writing all fields + `frontFace`/`backFace`. Cancel discards — no half-saved rows.
- **`Faceplate` stays pure/read-only** (reused unchanged by the Phase 2b rack view). Interactivity is layered as an overlay in later slices — never by editing `Faceplate`.
- **Faces are the Slice 2 `Face` TS shape** (`{ portGroups, elements }`, camelCase) stored directly as `jsonb`; round-trip must be loss-free. Empty face = `emptyFace()` from `@/domain/faceplate`.
- **Device-level fields shared across both faces:** `widthIn`, `rackUnits`, `rackMounted` map to single `device_templates` columns; Front/Back only switches the active face.
- **Validation (spec §10):** Name required; Device type required; `widthIn > 0` (`isValidWidthIn`); `rackUnits >= 1` integer (`isValidRackUnits`). Reuse the domain helpers from `@/domain/faceplate`.
- **Rack units select capped at 10** in the UI.
- **Brand/Device type = selects** (Brand optional/clearable with inline "+ Add brand"; typeahead deferred). Managing the type list stays on the Device Types tab.
- **No group-building, spacing handle, per-port editing, or elements** in 3a (deferred to 3b/3c/4). Palette chips render statically for fidelity only.
- Tests: Vitest, `describe/it/expect`, one behavior per `it`. `npm test` runs the suite. Integration tests need Supabase up (`npx supabase start`) and follow the `ZZ Test%` cleanup pattern.
- Do **not** run `npm run lint` — it fails repo-wide for a pre-existing ESLint 9 flat-config reason unrelated to this work.
- Work on branch `phase-2a-slice-3a` (already cut from `phase-2a-slice-2`; rebase onto `main` once PR #2 merges).
- TDD, DRY, YAGNI, frequent commits.

---

## File Structure

- **Modify** `src/features/device-library/repository.ts` — add `getDeviceTemplate`, `updateDeviceTemplate`; extend `createDeviceTemplate` to accept faces; add `EditableTemplate` type + `toEditableTemplate` mapper.
- **Modify** `src/features/device-library/repository.integration.test.ts` — add face round-trip + update tests.
- **Rewrite** `src/features/device-library/actions.ts` — structured `saveNewDeviceTemplateAction`, `saveDeviceTemplateAction`, `getDeviceTemplateAction`, `createBrandAction`; remove the `FormData` `createDeviceTemplateAction`; keep `deleteDeviceTemplateAction`.
- **Create** `src/features/device-library/actions.test.ts` — validation-branch unit tests.
- **Create** `src/features/device-library/editor/useDeviceDraft.ts` (+ `.test.ts`) — draft state, update helpers, derived validation.
- **Create** `src/features/device-library/editor/EditorCanvas.tsx` (+ `.test.tsx`) — Faceplate preview wrapper / overlay origin.
- **Create** `src/features/device-library/editor/RackDeviceEditor.tsx` (+ `.test.tsx`) — the modal (presentational + draft state; `onSave` callback).
- **Create** `src/features/device-library/editor/EditorLauncher.tsx` — client entry: Create button + edit wiring, calls server actions.
- **Modify** `src/features/device-library/RackDeviceTable.tsx` (+ test) — add an Edit action per row (`onEdit` callback + Actions column).
- **Modify** `src/app/device-library/page.tsx` — mount `EditorLauncher` instead of `CreateDeviceForm`.
- **Delete** `src/features/device-library/CreateDeviceForm.tsx`.

---

## Task 1: Face-typed persistence (repository)

**Files:**
- Modify: `src/features/device-library/repository.ts`
- Test: `src/features/device-library/repository.integration.test.ts`

**Interfaces:**
- Consumes: `getDefaultOrganization` (existing), `Face`/`emptyFace` from `@/domain/faceplate`.
- Produces:
  - Extended `createDeviceTemplate` input: adds optional `frontFace?: Face; backFace?: Face` (default `emptyFace()`).
  - `getDeviceTemplate(db: SupabaseClient, id: string): Promise<DeviceTemplateRow | null>`
  - `updateDeviceTemplate(db, id, input: { name: string; deviceTypeId: string; brandId: string | null; rackUnits: number; widthIn: number; rackMounted: boolean; frontFace: Face; backFace: Face }): Promise<DeviceTemplateRow>`
  - `interface EditableTemplate { id: string; name: string; brandId: string | null; deviceTypeId: string; rackUnits: number; widthIn: number; rackMounted: boolean; frontFace: Face; backFace: Face }`
  - `toEditableTemplate(row: DeviceTemplateRow): EditableTemplate` — maps a row to the editor shape, coercing null faces to `emptyFace()`.

- [ ] **Step 1: Write the failing integration tests**

Append to `src/features/device-library/repository.integration.test.ts` (also add the new imports to the existing import block):

```ts
import {
  getDeviceTemplate, updateDeviceTemplate, toEditableTemplate,
} from "./repository";
import { emptyFace, type Face } from "@/domain/faceplate";

describe("device-library repository — faces (integration)", () => {
  it("round-trips a non-empty front face through create + get", async () => {
    const type = await createDeviceType(db, { name: "ZZ Test Type" });
    const face: Face = {
      portGroups: [{
        id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "Gi",
        countingDirection: "ltr", rows: 1, cols: 2, gridX: 0, gridY: 0,
        colSpacing: 0, rowSpacing: 0, portOverrides: {},
      }],
      elements: [],
    };
    const tpl = await createDeviceTemplate(db, {
      name: "ZZ Test Faces", deviceTypeId: type.id, rackUnits: 1, widthIn: 19,
      rackMounted: true, frontFace: face, backFace: emptyFace(),
    });

    const got = await getDeviceTemplate(db, tpl.id);
    expect(got).not.toBeNull();
    const editable = toEditableTemplate(got!);
    expect(editable.frontFace).toEqual(face);
    expect(editable.backFace).toEqual(emptyFace());

    await deleteDeviceTemplate(db, tpl.id);
    await deleteDeviceType(db, type.id);
  });

  it("update persists changed fields and both faces", async () => {
    const type = await createDeviceType(db, { name: "ZZ Test Type" });
    const tpl = await createDeviceTemplate(db, {
      name: "ZZ Test Upd", deviceTypeId: type.id, rackUnits: 1, widthIn: 19, rackMounted: true,
    });
    const backFace: Face = {
      portGroups: [{
        id: "b1", media: "sfp", connectorType: "SFP+", idPrefix: "SFP",
        countingDirection: "ltr", rows: 1, cols: 1, gridX: 4, gridY: 4,
        colSpacing: 0, rowSpacing: 0, portOverrides: {},
      }],
      elements: [],
    };
    await updateDeviceTemplate(db, tpl.id, {
      name: "ZZ Test Upd2", deviceTypeId: type.id, brandId: null,
      rackUnits: 2, widthIn: 10.6, rackMounted: false,
      frontFace: emptyFace(), backFace,
    });

    const editable = toEditableTemplate((await getDeviceTemplate(db, tpl.id))!);
    expect(editable.name).toBe("ZZ Test Upd2");
    expect(editable.rackUnits).toBe(2);
    expect(editable.widthIn).toBe(10.6);
    expect(editable.rackMounted).toBe(false);
    expect(editable.backFace).toEqual(backFace);

    await deleteDeviceTemplate(db, tpl.id);
    await deleteDeviceType(db, type.id);
  });

  it("getDeviceTemplate returns null for a missing id", async () => {
    expect(await getDeviceTemplate(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/repository.integration.test.ts`
Expected: FAIL — `getDeviceTemplate` / `updateDeviceTemplate` / `toEditableTemplate` not exported.

- [ ] **Step 3: Write the implementation**

In `src/features/device-library/repository.ts`, add the import at the top:

```ts
import { emptyFace, type Face } from "@/domain/faceplate";
```

Add the `frontFace`/`backFace` params to `createDeviceTemplate`'s input type and insert body:

```ts
export async function createDeviceTemplate(
  db: SupabaseClient,
  input: {
    name: string; deviceTypeId: string; brandId?: string;
    rackUnits?: number; widthIn?: number; rackMounted?: boolean;
    frontFace?: Face; backFace?: Face;
  },
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
    front_face: input.frontFace ?? emptyFace(),
    back_face: input.backFace ?? emptyFace(),
  }).select("*").single();
  if (error) throw new Error(`createDeviceTemplate: ${error.message}`);
  return data as DeviceTemplateRow;
}
```

Append the new functions and type:

```ts
export async function getDeviceTemplate(
  db: SupabaseClient, id: string,
): Promise<DeviceTemplateRow | null> {
  const { data, error } = await db.from("device_templates")
    .select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getDeviceTemplate: ${error.message}`);
  return (data as DeviceTemplateRow | null) ?? null;
}

export async function updateDeviceTemplate(
  db: SupabaseClient, id: string,
  input: {
    name: string; deviceTypeId: string; brandId: string | null;
    rackUnits: number; widthIn: number; rackMounted: boolean;
    frontFace: Face; backFace: Face;
  },
): Promise<DeviceTemplateRow> {
  const { data, error } = await db.from("device_templates").update({
    name: input.name,
    device_type_id: input.deviceTypeId,
    brand_id: input.brandId,
    rack_units: input.rackUnits,
    width_in: input.widthIn,
    rack_mounted: input.rackMounted,
    front_face: input.frontFace,
    back_face: input.backFace,
    updated_at: new Date().toISOString(),
  }).eq("id", id).select("*").single();
  if (error) throw new Error(`updateDeviceTemplate: ${error.message}`);
  return data as DeviceTemplateRow;
}

export interface EditableTemplate {
  id: string; name: string; brandId: string | null; deviceTypeId: string;
  rackUnits: number; widthIn: number; rackMounted: boolean;
  frontFace: Face; backFace: Face;
}

export function toEditableTemplate(row: DeviceTemplateRow): EditableTemplate {
  return {
    id: row.id,
    name: row.name,
    brandId: row.brand_id,
    deviceTypeId: row.device_type_id,
    rackUnits: row.rack_units,
    widthIn: row.width_in,
    rackMounted: row.rack_mounted,
    frontFace: (row.front_face as Face | null) ?? emptyFace(),
    backFace: (row.back_face as Face | null) ?? emptyFace(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/repository.integration.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/repository.ts src/features/device-library/repository.integration.test.ts
git commit -m "feat: Face-typed device-template persistence (get/update/create faces)"
```

---

## Task 2: Structured server actions

**Files:**
- Rewrite: `src/features/device-library/actions.ts`
- Create: `src/features/device-library/actions.test.ts`

**Interfaces:**
- Consumes: `createDeviceTemplate`, `updateDeviceTemplate`, `getDeviceTemplate`, `toEditableTemplate`, `deleteDeviceTemplate`, `createBrand`, `EditableTemplate`, `BrandRow` from `./repository`; `isValidWidthIn`/`isValidRackUnits`/`Face` from `@/domain/faceplate`; `createServiceClient` from `@/lib/supabase/server`.
- Produces:
  - `interface DeviceTemplateInput { name: string; brandId: string | null; deviceTypeId: string; rackUnits: number; widthIn: number; rackMounted: boolean; frontFace: Face; backFace: Face }`
  - `validateDeviceTemplateInput(input: DeviceTemplateInput): string | null` — returns an error message or `null` (exported for unit testing).
  - `saveNewDeviceTemplateAction(input: DeviceTemplateInput): Promise<{ ok: boolean; id?: string; error?: string }>`
  - `saveDeviceTemplateAction(id: string, input: DeviceTemplateInput): Promise<{ ok: boolean; error?: string }>`
  - `getDeviceTemplateAction(id: string): Promise<{ ok: boolean; template?: EditableTemplate; error?: string }>`
  - `createBrandAction(name: string): Promise<{ ok: boolean; brand?: BrandRow; error?: string }>`
  - `deleteDeviceTemplateAction(id: string): Promise<void>` (unchanged, retained).
- Removes: the `FormData`-based `createDeviceTemplateAction`.

- [ ] **Step 1: Write the failing unit tests**

Create `src/features/device-library/actions.test.ts` (pure validation — no DB):

```ts
import { describe, it, expect } from "vitest";
import { validateDeviceTemplateInput, type DeviceTemplateInput } from "./actions";
import { emptyFace } from "@/domain/faceplate";

function input(over: Partial<DeviceTemplateInput> = {}): DeviceTemplateInput {
  return {
    name: "Switch", brandId: null, deviceTypeId: "t1",
    rackUnits: 1, widthIn: 19, rackMounted: true,
    frontFace: emptyFace(), backFace: emptyFace(),
    ...over,
  };
}

describe("validateDeviceTemplateInput", () => {
  it("accepts a valid input", () => {
    expect(validateDeviceTemplateInput(input())).toBeNull();
  });
  it("rejects an empty name", () => {
    expect(validateDeviceTemplateInput(input({ name: "  " }))).toMatch(/name/i);
  });
  it("rejects a missing device type", () => {
    expect(validateDeviceTemplateInput(input({ deviceTypeId: "" }))).toMatch(/device type/i);
  });
  it("rejects width <= 0", () => {
    expect(validateDeviceTemplateInput(input({ widthIn: 0 }))).toMatch(/width/i);
  });
  it("rejects rack units < 1", () => {
    expect(validateDeviceTemplateInput(input({ rackUnits: 0 }))).toMatch(/rack units/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/actions.test.ts`
Expected: FAIL — `validateDeviceTemplateInput` not exported.

- [ ] **Step 3: Rewrite `actions.ts`**

Replace the entire contents of `src/features/device-library/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { isValidWidthIn, isValidRackUnits, type Face } from "@/domain/faceplate";
import {
  createDeviceTemplate, updateDeviceTemplate, getDeviceTemplate,
  toEditableTemplate, deleteDeviceTemplate, createBrand,
  type EditableTemplate, type BrandRow,
} from "./repository";

export interface DeviceTemplateInput {
  name: string;
  brandId: string | null;
  deviceTypeId: string;
  rackUnits: number;
  widthIn: number;
  rackMounted: boolean;
  frontFace: Face;
  backFace: Face;
}

/** Returns an error message, or null if the input is valid. */
export function validateDeviceTemplateInput(input: DeviceTemplateInput): string | null {
  if (!input.name.trim()) return "Name is required";
  if (!input.deviceTypeId) return "Device type is required";
  if (!isValidWidthIn(input.widthIn)) return "Width must be greater than 0";
  if (!isValidRackUnits(input.rackUnits)) return "Rack units must be at least 1";
  return null;
}

export async function saveNewDeviceTemplateAction(
  input: DeviceTemplateInput,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const err = validateDeviceTemplateInput(input);
  if (err) return { ok: false, error: err };
  const db = createServiceClient();
  try {
    const row = await createDeviceTemplate(db, {
      name: input.name.trim(), deviceTypeId: input.deviceTypeId,
      brandId: input.brandId ?? undefined, rackUnits: input.rackUnits,
      widthIn: input.widthIn, rackMounted: input.rackMounted,
      frontFace: input.frontFace, backFace: input.backFace,
    });
    revalidatePath("/device-library");
    return { ok: true, id: row.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function saveDeviceTemplateAction(
  id: string, input: DeviceTemplateInput,
): Promise<{ ok: boolean; error?: string }> {
  const err = validateDeviceTemplateInput(input);
  if (err) return { ok: false, error: err };
  const db = createServiceClient();
  try {
    await updateDeviceTemplate(db, id, {
      name: input.name.trim(), deviceTypeId: input.deviceTypeId,
      brandId: input.brandId, rackUnits: input.rackUnits,
      widthIn: input.widthIn, rackMounted: input.rackMounted,
      frontFace: input.frontFace, backFace: input.backFace,
    });
    revalidatePath("/device-library");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function getDeviceTemplateAction(
  id: string,
): Promise<{ ok: boolean; template?: EditableTemplate; error?: string }> {
  const db = createServiceClient();
  try {
    const row = await getDeviceTemplate(db, id);
    if (!row) return { ok: false, error: "Template not found" };
    return { ok: true, template: toEditableTemplate(row) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function createBrandAction(
  name: string,
): Promise<{ ok: boolean; brand?: BrandRow; error?: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Brand name is required" };
  const db = createServiceClient();
  try {
    const brand = await createBrand(db, { name: trimmed });
    revalidatePath("/device-library");
    return { ok: true, brand };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteDeviceTemplateAction(id: string): Promise<void> {
  const db = createServiceClient();
  await deleteDeviceTemplate(db, id);
  revalidatePath("/device-library");
}
```

> Note: `validateDeviceTemplateInput` is a synchronous pure function exported from a `"use server"` module. This is fine — the unit test imports and calls it directly; Next.js only treats the async functions as server actions.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/actions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/actions.ts src/features/device-library/actions.test.ts
git commit -m "feat: structured device-template server actions (save/get/brand)"
```

---

## Task 3: `useDeviceDraft` hook

**Files:**
- Create: `src/features/device-library/editor/useDeviceDraft.ts`
- Test: `src/features/device-library/editor/useDeviceDraft.test.ts`

**Interfaces:**
- Consumes: `Face`/`emptyFace`/`isValidWidthIn`/`isValidRackUnits` from `@/domain/faceplate`.
- Produces:
  - `interface DeviceDraft { name: string; brandId: string | null; deviceTypeId: string; rackUnits: number; widthIn: number; rackMounted: boolean; activeSide: "front" | "back"; frontFace: Face; backFace: Face }`
  - `type DraftErrors = { name?: string; deviceTypeId?: string; widthIn?: string; rackUnits?: string }`
  - `useDeviceDraft(initial?: Partial<DeviceDraft>): { draft: DeviceDraft; activeFace: Face; setField: <K extends keyof DeviceDraft>(key: K, value: DeviceDraft[K]) => void; setActiveSide: (side: "front" | "back") => void; setActiveFace: (face: Face) => void; errors: DraftErrors; isValid: boolean }`
  - `emptyDraft(): DeviceDraft`

- [ ] **Step 1: Write the failing tests**

Create `src/features/device-library/editor/useDeviceDraft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDeviceDraft } from "./useDeviceDraft";
import { emptyFace, type Face } from "@/domain/faceplate";

const oneGroupFace: Face = {
  portGroups: [{
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {},
  }],
  elements: [],
};

describe("useDeviceDraft", () => {
  it("starts empty and invalid (no name, no type)", () => {
    const { result } = renderHook(() => useDeviceDraft());
    expect(result.current.draft.name).toBe("");
    expect(result.current.draft.activeSide).toBe("front");
    expect(result.current.isValid).toBe(false);
    expect(result.current.errors.name).toBeTruthy();
    expect(result.current.errors.deviceTypeId).toBeTruthy();
  });

  it("becomes valid once name, type, width and rack units are set", () => {
    const { result } = renderHook(() => useDeviceDraft());
    act(() => { result.current.setField("name", "Switch"); });
    act(() => { result.current.setField("deviceTypeId", "t1"); });
    expect(result.current.isValid).toBe(true);
    expect(result.current.errors).toEqual({});
  });

  it("flags invalid width and rack units", () => {
    const { result } = renderHook(() => useDeviceDraft({ name: "X", deviceTypeId: "t1" }));
    act(() => { result.current.setField("widthIn", 0); });
    act(() => { result.current.setField("rackUnits", 0); });
    expect(result.current.errors.widthIn).toBeTruthy();
    expect(result.current.errors.rackUnits).toBeTruthy();
    expect(result.current.isValid).toBe(false);
  });

  it("activeFace follows activeSide", () => {
    const { result } = renderHook(() =>
      useDeviceDraft({ frontFace: oneGroupFace, backFace: emptyFace() }),
    );
    expect(result.current.activeFace).toEqual(oneGroupFace);
    act(() => { result.current.setActiveSide("back"); });
    expect(result.current.activeFace).toEqual(emptyFace());
  });

  it("setActiveFace writes to the active side only", () => {
    const { result } = renderHook(() => useDeviceDraft());
    act(() => { result.current.setActiveFace(oneGroupFace); });
    expect(result.current.draft.frontFace).toEqual(oneGroupFace);
    expect(result.current.draft.backFace).toEqual(emptyFace());
    act(() => { result.current.setActiveSide("back"); });
    act(() => { result.current.setActiveFace(oneGroupFace); });
    expect(result.current.draft.backFace).toEqual(oneGroupFace);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/useDeviceDraft.test.ts`
Expected: FAIL — cannot resolve `./useDeviceDraft`.

- [ ] **Step 3: Write the implementation**

Create `src/features/device-library/editor/useDeviceDraft.ts`:

```ts
import { useCallback, useMemo, useState } from "react";
import { emptyFace, isValidWidthIn, isValidRackUnits, type Face } from "@/domain/faceplate";

export interface DeviceDraft {
  name: string;
  brandId: string | null;
  deviceTypeId: string;
  rackUnits: number;
  widthIn: number;
  rackMounted: boolean;
  activeSide: "front" | "back";
  frontFace: Face;
  backFace: Face;
}

export type DraftErrors = {
  name?: string;
  deviceTypeId?: string;
  widthIn?: string;
  rackUnits?: string;
};

export function emptyDraft(): DeviceDraft {
  return {
    name: "", brandId: null, deviceTypeId: "",
    rackUnits: 1, widthIn: 19, rackMounted: true,
    activeSide: "front", frontFace: emptyFace(), backFace: emptyFace(),
  };
}

function computeErrors(d: DeviceDraft): DraftErrors {
  const e: DraftErrors = {};
  if (!d.name.trim()) e.name = "Name is required";
  if (!d.deviceTypeId) e.deviceTypeId = "Device type is required";
  if (!isValidWidthIn(d.widthIn)) e.widthIn = "Width must be greater than 0";
  if (!isValidRackUnits(d.rackUnits)) e.rackUnits = "Rack units must be at least 1";
  return e;
}

export function useDeviceDraft(initial?: Partial<DeviceDraft>) {
  const [draft, setDraft] = useState<DeviceDraft>(() => ({ ...emptyDraft(), ...initial }));

  const setField = useCallback(
    <K extends keyof DeviceDraft>(key: K, value: DeviceDraft[K]) => {
      setDraft((d) => ({ ...d, [key]: value }));
    },
    [],
  );

  const setActiveSide = useCallback((side: "front" | "back") => {
    setDraft((d) => ({ ...d, activeSide: side }));
  }, []);

  const setActiveFace = useCallback((face: Face) => {
    setDraft((d) =>
      d.activeSide === "front" ? { ...d, frontFace: face } : { ...d, backFace: face },
    );
  }, []);

  const activeFace = draft.activeSide === "front" ? draft.frontFace : draft.backFace;
  const errors = useMemo(() => computeErrors(draft), [draft]);
  const isValid = Object.keys(errors).length === 0;

  return { draft, activeFace, setField, setActiveSide, setActiveFace, errors, isValid };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/useDeviceDraft.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/useDeviceDraft.ts src/features/device-library/editor/useDeviceDraft.test.ts
git commit -m "feat: useDeviceDraft editor state hook"
```

---

## Task 4: `EditorCanvas` preview

**Files:**
- Create: `src/features/device-library/editor/EditorCanvas.tsx`
- Test: `src/features/device-library/editor/EditorCanvas.test.tsx`

**Interfaces:**
- Consumes: `Faceplate` from `@/features/device-library/faceplate/Faceplate`; `Face` from `@/domain/faceplate`.
- Produces: `EditorCanvas({ face, widthIn, rackUnits, rackMounted, side }: { face: Face; widthIn: number; rackUnits: number; rackMounted: boolean; side: "FRONT" | "BACK" }): JSX.Element` — a positioned wrapper (`data-testid="editor-canvas"`) rendering the read-only `Faceplate`. The wrapper is `position: relative` so 3b/3c can absolutely-position an overlay inside it.

- [ ] **Step 1: Write the failing tests**

Create `src/features/device-library/editor/EditorCanvas.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { EditorCanvas } from "./EditorCanvas";
import { emptyFace } from "@/domain/faceplate";

describe("EditorCanvas", () => {
  it("renders a relative-positioned wrapper around the Faceplate", () => {
    const { getByTestId } = render(
      <EditorCanvas face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted side="FRONT" />,
    );
    const canvas = getByTestId("editor-canvas");
    expect(canvas).toBeInTheDocument();
    expect(canvas.querySelector('[data-testid="faceplate-svg"]')).not.toBeNull();
  });

  it("drops screw holes when not rack-mounted (preview reflects props)", () => {
    const { queryAllByTestId } = render(
      <EditorCanvas face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted={false} side="FRONT" />,
    );
    expect(queryAllByTestId("screw-hole")).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: FAIL — cannot resolve `./EditorCanvas`.

- [ ] **Step 3: Write the implementation**

Create `src/features/device-library/editor/EditorCanvas.tsx`:

```tsx
import { Faceplate } from "@/features/device-library/faceplate/Faceplate";
import type { Face } from "@/domain/faceplate";

export function EditorCanvas({
  face, widthIn, rackUnits, rackMounted, side,
}: {
  face: Face;
  widthIn: number;
  rackUnits: number;
  rackMounted: boolean;
  side: "FRONT" | "BACK";
}) {
  // position:relative is the overlay origin 3b/3c will mount controls into.
  return (
    <div data-testid="editor-canvas" style={{ position: "relative", display: "inline-block" }}>
      <Faceplate
        face={face}
        widthIn={widthIn}
        rackUnits={rackUnits}
        rackMounted={rackMounted}
        side={side}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/EditorCanvas.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorCanvas.tsx src/features/device-library/editor/EditorCanvas.test.tsx
git commit -m "feat: EditorCanvas faceplate preview wrapper"
```

---

## Task 5: `RackDeviceEditor` modal (presentational + draft)

**Files:**
- Create: `src/features/device-library/editor/RackDeviceEditor.tsx`
- Test: `src/features/device-library/editor/RackDeviceEditor.test.tsx`

**Interfaces:**
- Consumes: `useDeviceDraft`/`DeviceDraft` (Task 3), `EditorCanvas` (Task 4), `PORT_GLYPHS`/`PortGlyph` from `@/features/device-library/faceplate/portGlyphs`, `MEDIA` from `@/domain/faceplate`, `DeviceTypeRow`/`BrandRow` from `../repository`.
- Produces:
  - `interface RackDeviceEditorProps { mode: "create" | "edit"; initial?: Partial<DeviceDraft>; types: DeviceTypeRow[]; brands: BrandRow[]; saving?: boolean; error?: string | null; onSave: (draft: DeviceDraft) => void; onCancel: () => void; onCreateBrand?: (name: string) => Promise<BrandRow | null> }`
  - `RackDeviceEditor(props): JSX.Element` — the modal. Header fields, static palette (from `MEDIA` via `PortGlyph`), Front/Back + Rack Mounted toggles, `EditorCanvas` preview, a settings-panel placeholder, and Cancel/Save footer (Save label "Create" in create mode, "Save" in edit mode). Save is disabled unless `isValid`; clicking Save calls `onSave(draft)`.
  - Test hooks: root `data-testid="rack-device-editor"`; Save button `data-testid="editor-save"`; Cancel `data-testid="editor-cancel"`; brand `<select>` gets an extra `__add__` option that triggers `onCreateBrand` via a prompt-less inline input row (`data-testid="brand-add-input"` + `data-testid="brand-add-confirm"`).

- [ ] **Step 1: Write the failing tests**

Create `src/features/device-library/editor/RackDeviceEditor.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackDeviceEditor } from "./RackDeviceEditor";
import type { DeviceTypeRow, BrandRow } from "../repository";
import type { Face } from "@/domain/faceplate";

const types: DeviceTypeRow[] = [{ id: "t1", organization_id: "o", name: "Switch", created_at: "" }];
const brands: BrandRow[] = [{ id: "b1", organization_id: "o", name: "Cisco", created_at: "" }];

const oneGroupFace: Face = {
  portGroups: [{
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 3, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {},
  }],
  elements: [],
};

function noop() {}

describe("RackDeviceEditor", () => {
  it("renders header fields and a faceplate preview", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/device type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/width/i)).toBeInTheDocument();
    expect(screen.getByTestId("faceplate-svg")).toBeInTheDocument();
  });

  it("Save is disabled until the draft is valid, then calls onSave", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={onSave} onCancel={noop} />);
    const save = screen.getByTestId("editor-save");
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/name/i), "48-port");
    await user.selectOptions(screen.getByLabelText(/device type/i), "t1");
    expect(save).toBeEnabled();
    await user.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ name: "48-port", deviceTypeId: "t1" });
  });

  it("Front/Back toggle switches the previewed side", async () => {
    const user = userEvent.setup();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    expect(screen.getByText("FRONT")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText("BACK")).toBeInTheDocument();
  });

  it("Rack Mounted toggle drops the screw holes in the preview", async () => {
    const user = userEvent.setup();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    expect(screen.getAllByTestId("screw-hole").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /rack mounted/i }));
    expect(screen.queryAllByTestId("screw-hole")).toHaveLength(0);
  });

  it("edit mode pre-fills fields and the active face", () => {
    render(
      <RackDeviceEditor
        mode="edit"
        types={types}
        brands={brands}
        initial={{ name: "Core-SW", deviceTypeId: "t1", brandId: "b1", widthIn: 10.6, frontFace: oneGroupFace }}
        onSave={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByLabelText(/name/i)).toHaveValue("Core-SW");
    expect(screen.getByTestId("editor-save")).toHaveTextContent(/save/i);
    // the pre-filled front face renders 3 port cells
    expect(screen.getAllByTestId("port-cell")).toHaveLength(3);
  });

  it("adds and selects a brand via + Add brand", async () => {
    const user = userEvent.setup();
    const onCreateBrand = vi.fn(async (name: string): Promise<BrandRow> => ({
      id: "b2", organization_id: "o", name, created_at: "",
    }));
    render(
      <RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} onCreateBrand={onCreateBrand} />,
    );
    await user.click(screen.getByRole("button", { name: /add brand/i }));
    await user.type(screen.getByTestId("brand-add-input"), "Juniper");
    await user.click(screen.getByTestId("brand-add-confirm"));
    expect(onCreateBrand).toHaveBeenCalledWith("Juniper");
  });

  it("Cancel calls onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={onCancel} />);
    await user.click(screen.getByTestId("editor-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: FAIL — cannot resolve `./RackDeviceEditor`.

- [ ] **Step 3: Write the implementation**

Create `src/features/device-library/editor/RackDeviceEditor.tsx`:

```tsx
"use client";

import { useState } from "react";
import { MEDIA, type Media } from "@/domain/faceplate";
import { PortGlyph } from "@/features/device-library/faceplate/portGlyphs";
import type { DeviceTypeRow, BrandRow } from "../repository";
import { useDeviceDraft, type DeviceDraft } from "./useDeviceDraft";
import { EditorCanvas } from "./EditorCanvas";

const MEDIA_LABELS: Record<Media, string> = {
  copper: "Copper", fiber: "Fiber", sfp: "SFP", usb_a: "USB-A", usb_c: "USB-C",
  hdmi: "HDMI", dp: "DP", vga: "VGA", ps2: "PS/2", audio: "Audio",
};

export interface RackDeviceEditorProps {
  mode: "create" | "edit";
  initial?: Partial<DeviceDraft>;
  types: DeviceTypeRow[];
  brands: BrandRow[];
  saving?: boolean;
  error?: string | null;
  onSave: (draft: DeviceDraft) => void;
  onCancel: () => void;
  onCreateBrand?: (name: string) => Promise<BrandRow | null>;
}

export function RackDeviceEditor(props: RackDeviceEditorProps) {
  const { draft, activeFace, setField, setActiveSide, errors, isValid } = useDeviceDraft(props.initial);
  const [addingBrand, setAddingBrand] = useState(false);
  const [newBrand, setNewBrand] = useState("");
  const [brands, setBrands] = useState(props.brands);

  async function confirmAddBrand() {
    if (!props.onCreateBrand || !newBrand.trim()) return;
    const created = await props.onCreateBrand(newBrand.trim());
    if (created) {
      setBrands((b) => [...b, created]);
      setField("brandId", created.id);
    }
    setAddingBrand(false);
    setNewBrand("");
  }

  const side = draft.activeSide === "front" ? "FRONT" : "BACK";

  return (
    <div
      data-testid="rack-device-editor"
      role="dialog"
      aria-label="Rack Device Editor"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-2xl bg-white p-6 text-neutral-900 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Rack Device Editor</h2>
          <button aria-label="Close" onClick={props.onCancel} className="text-neutral-400">✕</button>
        </div>

        {/* Header fields */}
        <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Name *
            <input
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-3 text-sm font-normal text-neutral-800"
              value={draft.name}
              onChange={(e) => setField("name", e.target.value)}
            />
          </label>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Brand
            {!addingBrand ? (
              <div className="mt-1 flex gap-1">
                <select
                  className="h-10 flex-1 rounded-lg border border-neutral-200 px-2 text-sm font-normal text-neutral-800"
                  value={draft.brandId ?? ""}
                  onChange={(e) => setField("brandId", e.target.value || null)}
                >
                  <option value="">—</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                {props.onCreateBrand && (
                  <button type="button" title="Add brand" aria-label="Add brand"
                    className="h-10 rounded-lg border border-neutral-200 px-2 text-sm"
                    onClick={() => setAddingBrand(true)}>+</button>
                )}
              </div>
            ) : (
              <div className="mt-1 flex gap-1">
                <input data-testid="brand-add-input" value={newBrand}
                  onChange={(e) => setNewBrand(e.target.value)}
                  className="h-10 flex-1 rounded-lg border border-neutral-200 px-2 text-sm font-normal" placeholder="New brand" />
                <button type="button" data-testid="brand-add-confirm"
                  className="h-10 rounded-lg bg-blue-600 px-2 text-sm text-white" onClick={confirmAddBrand}>Add</button>
              </div>
            )}
          </label>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Device type *
            <select
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-2 text-sm font-normal text-neutral-800"
              value={draft.deviceTypeId}
              onChange={(e) => setField("deviceTypeId", e.target.value)}
            >
              <option value="">—</option>
              {props.types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Rack units
            <select
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-2 text-sm font-normal text-neutral-800"
              value={draft.rackUnits}
              onChange={(e) => setField("rackUnits", Number(e.target.value))}
            >
              {Array.from({ length: 10 }, (_, i) => i + 1).map((u) => (
                <option key={u} value={u}>{u} RU</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col text-xs font-semibold text-neutral-600">
            Width (in)
            <input
              type="number" step="0.1" min="0"
              className="mt-1 h-10 rounded-lg border border-neutral-200 px-3 text-sm font-normal text-neutral-800"
              value={draft.widthIn}
              onChange={(e) => setField("widthIn", Number(e.target.value))}
            />
          </label>
        </div>

        {/* Canvas + palette + toggles */}
        <div className="rounded-xl border border-neutral-100 bg-neutral-50 p-4">
          <div className="mb-3 flex flex-wrap items-start gap-3">
            <div className="flex flex-wrap gap-2 rounded-lg border border-neutral-200 bg-white p-2">
              {MEDIA.map((m) => (
                <span key={m} className="flex items-center gap-1 rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-800" title={MEDIA_LABELS[m]}>
                  <span className="text-neutral-900"><PortGlyph media={m} /></span>{MEDIA_LABELS[m]}
                </span>
              ))}
            </div>
            <div className="ml-auto flex flex-col gap-2">
              <div className="flex rounded-lg border border-neutral-200 bg-white p-1 text-sm font-semibold">
                <button type="button"
                  className={`rounded-md px-4 py-1 ${draft.activeSide === "front" ? "bg-neutral-900 text-white" : "text-neutral-500"}`}
                  onClick={() => setActiveSide("front")}>Front</button>
                <button type="button"
                  className={`rounded-md px-4 py-1 ${draft.activeSide === "back" ? "bg-neutral-900 text-white" : "text-neutral-500"}`}
                  onClick={() => setActiveSide("back")}>Back</button>
              </div>
              <button type="button" aria-pressed={draft.rackMounted}
                className="flex items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs font-medium"
                onClick={() => setField("rackMounted", !draft.rackMounted)}>
                Rack Mounted
                <span className={`inline-block h-4 w-8 rounded-full ${draft.rackMounted ? "bg-blue-600" : "bg-neutral-300"}`} />
              </button>
            </div>
          </div>

          <div className="mt-2 overflow-auto">
            <EditorCanvas
              face={activeFace}
              widthIn={draft.widthIn > 0 ? draft.widthIn : 1}
              rackUnits={draft.rackUnits >= 1 ? draft.rackUnits : 1}
              rackMounted={draft.rackMounted}
              side={side}
            />
          </div>
        </div>

        {/* Settings placeholder (3b/3c fill this in) */}
        <div className="mt-4 rounded-xl border border-dashed border-neutral-200 p-6 text-center text-xs text-neutral-400">
          Select a port to edit its name. (Group building arrives in the next slice.)
        </div>

        {props.error && <p className="mt-3 text-sm text-red-600">{props.error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" data-testid="editor-cancel" onClick={props.onCancel}
            className="rounded-lg border border-neutral-200 px-5 py-2 text-sm font-semibold">Cancel</button>
          <button
            type="button"
            data-testid="editor-save"
            disabled={!isValid || props.saving}
            onClick={() => onSaveGuard(isValid, props.saving, () => props.onSave(draft))}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {props.saving ? "Saving…" : props.mode === "create" ? "Create" : "Save"}
          </button>
        </div>

        {/* consumed so errors object isn't flagged as unused when wired in 3b */}
        <span className="hidden">{Object.values(errors).join("")}</span>
      </div>
    </div>
  );
}

function onSaveGuard(isValid: boolean, saving: boolean | undefined, run: () => void) {
  if (isValid && !saving) run();
}
```

> Note: only the footer Cancel button carries `data-testid="editor-cancel"`; the header ✕ uses `aria-label="Close"` so `getByTestId("editor-cancel")` resolves uniquely.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/device-library/editor/RackDeviceEditor.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/RackDeviceEditor.tsx src/features/device-library/editor/RackDeviceEditor.test.tsx
git commit -m "feat: RackDeviceEditor modal (fields, toggles, live preview, validation)"
```

---

## Task 6: `RackDeviceTable` Edit action

**Files:**
- Modify: `src/features/device-library/RackDeviceTable.tsx`
- Create: `src/features/device-library/RackDeviceTable.test.tsx` (extend if it exists)

**Interfaces:**
- Consumes: `DeviceTemplateListRow` (existing).
- Produces: `RackDeviceTable` gains an optional `onEdit?: (id: string) => void` prop and an **Actions** column with an **Edit** button per row (`data-testid="edit-<id>"`). Existing behavior (search, empty state) is unchanged.

- [ ] **Step 1: Write the failing test**

Create/extend `src/features/device-library/RackDeviceTable.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackDeviceTable } from "./RackDeviceTable";
import type { DeviceTemplateListRow } from "./repository";

const rows: DeviceTemplateListRow[] = [
  { id: "d1", name: "Core-SW", brandName: "Cisco", typeName: "Switch", rackUnits: 1, widthIn: 19, rackMounted: true },
];

describe("RackDeviceTable edit action", () => {
  it("calls onEdit with the row id when Edit is clicked", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<RackDeviceTable rows={rows} onEdit={onEdit} />);
    await user.click(screen.getByTestId("edit-d1"));
    expect(onEdit).toHaveBeenCalledWith("d1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/features/device-library/RackDeviceTable.test.tsx`
Expected: FAIL — no `edit-d1` element / `onEdit` unsupported.

- [ ] **Step 3: Update the component**

Edit `src/features/device-library/RackDeviceTable.tsx` — add the prop and the Actions column:

```tsx
export function RackDeviceTable({ rows, onEdit }: { rows: DeviceTemplateListRow[]; onEdit?: (id: string) => void }) {
```

Add a header cell after "Rack units":

```tsx
<th className="p-2">Rack units</th><th className="p-2">Actions</th>
```

Add a cell at the end of each row:

```tsx
<td className="p-2">{r.rackUnits} RU</td>
<td className="p-2">
  {onEdit && (
    <button data-testid={`edit-${r.id}`} onClick={() => onEdit(r.id)} className="text-blue-500 hover:underline">Edit</button>
  )}
</td>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/features/device-library/RackDeviceTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/RackDeviceTable.tsx src/features/device-library/RackDeviceTable.test.tsx
git commit -m "feat: RackDeviceTable per-row Edit action"
```

---

## Task 7: `EditorLauncher` + page integration + verification

**Files:**
- Create: `src/features/device-library/editor/EditorLauncher.tsx`
- Modify: `src/app/device-library/page.tsx`
- Delete: `src/features/device-library/CreateDeviceForm.tsx`

**Interfaces:**
- Consumes: `RackDeviceEditor` (Task 5), `RackDeviceTable` (Task 6), `saveNewDeviceTemplateAction`/`saveDeviceTemplateAction`/`getDeviceTemplateAction`/`createBrandAction` (Task 2), `DeviceTemplateListRow`/`DeviceTypeRow`/`BrandRow` (repository), `DeviceDraft` (Task 3).
- Produces: `EditorLauncher({ rows, types, brands }: { rows: DeviceTemplateListRow[]; types: DeviceTypeRow[]; brands: BrandRow[] }): JSX.Element` — a client component rendering a **Create** button + the `RackDeviceTable` (with `onEdit`), and mounting `RackDeviceEditor` when creating or editing. Handles save (routes to new/edit action), loading, error, and edit-mode template loading via `getDeviceTemplateAction`.

- [ ] **Step 1: Create `EditorLauncher`**

Create `src/features/device-library/editor/EditorLauncher.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { DeviceTemplateListRow, DeviceTypeRow, BrandRow } from "../repository";
import { RackDeviceTable } from "../RackDeviceTable";
import { RackDeviceEditor } from "./RackDeviceEditor";
import type { DeviceDraft } from "./useDeviceDraft";
import {
  saveNewDeviceTemplateAction, saveDeviceTemplateAction,
  getDeviceTemplateAction, createBrandAction,
} from "../actions";

type EditingState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; id: string; initial: Partial<DeviceDraft> };

export function EditorLauncher({
  rows, types, brands,
}: { rows: DeviceTemplateListRow[]; types: DeviceTypeRow[]; brands: BrandRow[] }) {
  const router = useRouter();
  const [state, setState] = useState<EditingState>({ mode: "closed" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toInput(draft: DeviceDraft) {
    return {
      name: draft.name, brandId: draft.brandId, deviceTypeId: draft.deviceTypeId,
      rackUnits: draft.rackUnits, widthIn: draft.widthIn, rackMounted: draft.rackMounted,
      frontFace: draft.frontFace, backFace: draft.backFace,
    };
  }

  async function openEdit(id: string) {
    setError(null);
    const res = await getDeviceTemplateAction(id);
    if (!res.ok || !res.template) { setError(res.error ?? "Failed to load"); return; }
    const t = res.template;
    setState({
      mode: "edit", id,
      initial: {
        name: t.name, brandId: t.brandId, deviceTypeId: t.deviceTypeId,
        rackUnits: t.rackUnits, widthIn: t.widthIn, rackMounted: t.rackMounted,
        frontFace: t.frontFace, backFace: t.backFace,
      },
    });
  }

  async function save(draft: DeviceDraft) {
    setSaving(true);
    setError(null);
    const res = state.mode === "edit"
      ? await saveDeviceTemplateAction(state.id, toInput(draft))
      : await saveNewDeviceTemplateAction(toInput(draft));
    setSaving(false);
    if (!res.ok) { setError(res.error ?? "Save failed"); return; }
    setState({ mode: "closed" });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div>
        <button
          onClick={() => { setError(null); setState({ mode: "create" }); }}
          className="rounded bg-blue-600 px-3 py-2 text-sm font-semibold text-white"
        >Create device</button>
      </div>

      {state.mode === "closed" && error && <p className="text-sm text-red-500">{error}</p>}

      <RackDeviceTable rows={rows} onEdit={openEdit} />

      {state.mode !== "closed" && (
        <RackDeviceEditor
          mode={state.mode}
          initial={state.mode === "edit" ? state.initial : undefined}
          types={types}
          brands={brands}
          saving={saving}
          error={error}
          onSave={save}
          onCancel={() => { setState({ mode: "closed" }); setError(null); }}
          onCreateBrand={async (name) => {
            const res = await createBrandAction(name);
            return res.ok && res.brand ? res.brand : null;
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire the page and delete the old form**

Replace `src/app/device-library/page.tsx` body — swap `CreateDeviceForm` + `RackDeviceTable` for `EditorLauncher`:

```tsx
import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTemplates, listDeviceTypes, listBrands } from "@/features/device-library/repository";
import { EditorLauncher } from "@/features/device-library/editor/EditorLauncher";

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
        <EditorLauncher rows={rows} types={types} brands={brands} />
      </section>
    </main>
  );
}
```

Then delete the obsolete form:

```bash
git rm src/features/device-library/CreateDeviceForm.tsx
```

- [ ] **Step 3: Run the full suite (no regressions)**

Run: `npm test`
Expected: PASS — all prior tests plus the new Task 1–6 tests. (There is no test importing `CreateDeviceForm` after its removal; if one exists, delete it.)

- [ ] **Step 4: Browser verification (preview workflow)**

With Supabase running (`npx supabase start`), start the dev server and open `/device-library`. Verify:
- **Create device** opens the modal; the live preview renders an empty 19″ faceplate.
- Typing a Name, choosing a Device type enables **Create**; changing Width narrows the body and widens the ears in the preview; toggling **Rack Mounted** off drops the ears/holes; Front/Back switches the side label.
- **+ Add brand** adds a brand and selects it.
- Saving returns to the table and the new row appears; clicking **Edit** on that row reopens the modal pre-filled (Save label reads "Save"); changing a field and saving persists (reload confirms).
- Take a screenshot of the open editor for the record.

Fix any issues by editing source and re-running from Step 3.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/EditorLauncher.tsx src/app/device-library/page.tsx
git rm src/features/device-library/CreateDeviceForm.tsx
git commit -m "feat: mount Rack Device Editor on the Device Library page (create + edit)"
```

- [ ] **Step 6: Finish the branch**

Run the `superpowers:requesting-code-review` whole-branch review, address findings, then `superpowers:finishing-a-development-branch` to open the PR against `main` (rebase onto `main` first if PR #2 has merged). Update `docs/superpowers/notes/RESUME.md` and the project memory: Slice 3a done, Slice 3b (port-group building) next.

---

## Self-Review

**Spec coverage (3a design doc):**
- Modal shell over Device Library, opened from Create + row Edit → Tasks 5, 6, 7. ✅
- Header fields (Name, Brand select + "+ Add brand", Device type select, Rack units ≤ 10, Width) → Task 5. ✅
- Front/Back toggle switches active face; Rack Mounted toggle; Width/RackUnits drive preview → Task 5 (tests assert side label + screw-hole drop). ✅
- Live read-only `Faceplate` preview via `EditorCanvas` overlay origin → Task 4. ✅
- Draft-in-state model + validation (`useDeviceDraft`) → Task 3. ✅
- Atomic Save (create/update), structured actions, `createBrandAction`, remove FormData action → Task 2; repository `getDeviceTemplate`/`updateDeviceTemplate`/extended create + `toEditableTemplate` → Task 1. ✅
- Loss-free face round-trip (jsonb, `Face` shape) → Task 1 integration tests. ✅
- Validation rules (name/type required, width>0, rackUnits≥1) reuse domain helpers → Tasks 2, 3. ✅
- Edit-mode load via `getDeviceTemplateAction` → Tasks 2, 7. ✅
- Remove `CreateDeviceForm` → Task 7. ✅
- Errors surface inline, Cancel discards → Tasks 5, 7. ✅
- Non-goals (group building, spacing handle, per-port, elements, typeahead) correctly absent. ✅

**Placeholder scan:** The settings panel and static palette are intentional spec'd placeholders (3a scope), not plan placeholders — each has complete code. The `onSaveGuard` helper and the hidden `errors` span are deliberate (guard double-fire; keep `errors` referenced for 3b). No TODO/TBD/"implement later" left. All test code is concrete.

**Type consistency:** `DeviceDraft`, `DeviceTemplateInput`, `EditableTemplate`, `Face`, `useDeviceDraft`, `EditorCanvas`, `RackDeviceEditor`, `EditorLauncher`, and action names (`saveNewDeviceTemplateAction`, `saveDeviceTemplateAction`, `getDeviceTemplateAction`, `createBrandAction`) are used identically across producing and consuming tasks. Repository additions (`getDeviceTemplate`, `updateDeviceTemplate`, `toEditableTemplate`) match their consumers in Task 2. Faces are the Slice 2 `Face` type throughout. `PortGlyph`/`MEDIA`/`emptyFace`/`isValidWidthIn`/`isValidRackUnits` come from existing modules.
```
