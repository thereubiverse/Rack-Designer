# Settings — Device Wizard Toggle + Gemini Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global Settings page (`Settings › Features › Device Wizard`) with an enable toggle that gates the wizard icon in the editor and a write-only Gemini API key field the wizard uses; the key is stored server-side and never returned to the client.

**Architecture:** A global key/value `app_settings` table. Pure orchestrators (`readDeviceWizardSettings`/`writeDeviceWizardSettings`/`resolveGeminiKey`) take an injected `SettingsStore` and are unit-tested with a fake; a thin `dbSettingsStore` and `"use server"` actions wire the real Supabase store. The detect action resolves the key server-side and passes it into the vision backend (returning a typed `"no-key"` when absent). The editor threads `{ enabled, hasKey }` into `DeviceWizard`, which gates the icon and shows a friendly no-key prompt.

**Tech Stack:** Next.js 16 (server actions, server components), React 18, TypeScript strict, Tailwind, Supabase (service client), Vitest + @testing-library/react. Mirrors the existing `device-library/ai` module patterns (injected fakes for I/O).

## Global Constraints

- **Global settings (no auth):** one shared store; not per-user.
- **Key write-only to the client:** `getDeviceWizardSettings()` returns only `{ enabled: boolean, hasKey: boolean }` — NEVER the raw key. `updateDeviceWizardSettings` accepts a key but returns nothing sensitive.
- **Key read only server-side:** the raw key is read exclusively in `server-only` code and passed straight to the Gemini call — never logged, never a client prop, never in a URL, never `NEXT_PUBLIC_`.
- **Env fallback preserved:** `resolveGeminiKey` returns the DB key, else `process.env.GEMINI_API_KEY`, else null.
- **Enable gates the icon; no-key shows a prompt:** icon renders only when `enabled`; when `enabled && !hasKey`, opening the wizard shows "Add your Gemini API key in Settings →" (link to `/settings`) instead of search/upload.
- **Settings keys (exact):** `device_wizard.enabled` (`"true"`/`"false"`), `device_wizard.gemini_api_key` (the secret).
- TypeScript strict; tests co-located `*.test.ts(x)`, run via `npx vitest run <path>`. Commit after each task. Branch `phase-2b-rack-placement` (already checked out).

---

## File structure

New directory `src/features/settings/`:
- `store.ts` — `SettingsStore` interface + `dbSettingsStore` (server-only Supabase).
- `deviceWizardSettings.ts` — pure `readDeviceWizardSettings`/`writeDeviceWizardSettings`/`resolveGeminiKey` + key constants.
- `deviceWizardSettings.test.ts`
- `actions.ts` — `"use server"` `getDeviceWizardSettings` / `updateDeviceWizardSettings`.
- `SettingsPage.tsx` — category rail + content panel.
- `DeviceWizardSettings.tsx` — toggle + write-only key field.
- `DeviceWizardSettings.test.tsx`

New migration: `supabase/migrations/0005_app_settings.sql`.
New route: `src/app/settings/page.tsx`.

Modified:
- `src/features/device-library/ai/visionBackend.ts` — `VisionInput` gains `apiKey`; backend uses it instead of `process.env`.
- `src/features/device-library/ai/actions.ts` — `detectPortsAction` resolves the key and returns `"no-key"` when absent.
- `src/features/device-library/ai/pipeline.test.ts` — inputs gain `apiKey`.
- `src/features/device-library/editor/DeviceWizard.tsx` (+ test) — `enabled`/`hasKey` props, icon gate, no-key prompt.
- `src/features/device-library/editor/RackDeviceEditor.tsx` — pass `enabled`/`hasKey` to the wizard.
- `src/features/device-library/editor/EditorLauncher.tsx` — thread `wizard` prop.
- `src/app/device-library/page.tsx` — fetch settings, pass down.
- `src/features/shell/AppSidebar.tsx` — wire the Settings nav item to `/settings`.
- `src/features/shell/AppShell.tsx` — add `["/settings", "Settings"]` title.

---

## Task 1: Migration + settings store

**Files:**
- Create: `supabase/migrations/0005_app_settings.sql`
- Create: `src/features/settings/store.ts`

**Interfaces:**
- Produces: `interface SettingsStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; del(key: string): Promise<void> }` and `const dbSettingsStore: SettingsStore`.

No unit test (thin DB I/O, mirrors `visionBackend`); deliverable is the table + interface. Verify by applying migrations and typechecking.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0005_app_settings.sql
-- Global key/value application settings (no auth yet → single shared store).
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
```

- [ ] **Step 2: Write the store**

```ts
// src/features/settings/store.ts
import "server-only";
import { createServiceClient } from "@/lib/supabase/server";

export interface SettingsStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

export const dbSettingsStore: SettingsStore = {
  async get(key) {
    const db = createServiceClient();
    const { data, error } = await db.from("app_settings").select("value").eq("key", key).maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  },
  async set(key, value) {
    const db = createServiceClient();
    const { error } = await db.from("app_settings").upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
  async del(key) {
    const db = createServiceClient();
    const { error } = await db.from("app_settings").delete().eq("key", key);
    if (error) throw error;
  },
};
```

- [ ] **Step 3: Apply the migration & typecheck**

Run: `npx supabase db reset` (applies 0001–0005 to the local DB; truncates local data — fine for dev)
Expected: reset completes, migration 0005 applied.
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0005_app_settings.sql src/features/settings/store.ts
git commit -m "feat(settings): app_settings table + SettingsStore"
```

---

## Task 2: Device-wizard settings orchestrators (pure)

**Files:**
- Create: `src/features/settings/deviceWizardSettings.ts`
- Test: `src/features/settings/deviceWizardSettings.test.ts`

**Interfaces:**
- Consumes: `type SettingsStore` from `./store`.
- Produces:
  - `const KEY_ENABLED = "device_wizard.enabled"`, `const KEY_GEMINI = "device_wizard.gemini_api_key"`
  - `interface DeviceWizardSettings { enabled: boolean; hasKey: boolean }`
  - `async function readDeviceWizardSettings(store: SettingsStore): Promise<DeviceWizardSettings>`
  - `async function writeDeviceWizardSettings(store: SettingsStore, patch: { enabled?: boolean; apiKey?: string }): Promise<void>`
  - `async function resolveGeminiKey(store: SettingsStore): Promise<string | null>`

- [ ] **Step 1: Write the failing test**

```ts
// src/features/settings/deviceWizardSettings.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readDeviceWizardSettings, writeDeviceWizardSettings, resolveGeminiKey, KEY_ENABLED, KEY_GEMINI } from "./deviceWizardSettings";
import type { SettingsStore } from "./store";

function fakeStore(initial: Record<string, string> = {}): SettingsStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get: vi.fn(async (k: string) => (k in data ? data[k] : null)),
    set: vi.fn(async (k: string, v: string) => { data[k] = v; }),
    del: vi.fn(async (k: string) => { delete data[k]; }),
  };
}

describe("readDeviceWizardSettings", () => {
  it("reports enabled + hasKey from stored values", async () => {
    const s = fakeStore({ [KEY_ENABLED]: "true", [KEY_GEMINI]: "sk-abc" });
    expect(await readDeviceWizardSettings(s)).toEqual({ enabled: true, hasKey: true });
  });
  it("defaults to disabled + no key when unset", async () => {
    expect(await readDeviceWizardSettings(fakeStore())).toEqual({ enabled: false, hasKey: false });
  });
  it("treats a blank key as no key", async () => {
    const s = fakeStore({ [KEY_GEMINI]: "   " });
    expect((await readDeviceWizardSettings(s)).hasKey).toBe(false);
  });
});

describe("writeDeviceWizardSettings", () => {
  it("writes the enabled flag as a string", async () => {
    const s = fakeStore();
    await writeDeviceWizardSettings(s, { enabled: true });
    expect(s.data[KEY_ENABLED]).toBe("true");
  });
  it("stores a trimmed key and deletes on empty", async () => {
    const s = fakeStore();
    await writeDeviceWizardSettings(s, { apiKey: "  sk-xyz  " });
    expect(s.data[KEY_GEMINI]).toBe("sk-xyz");
    await writeDeviceWizardSettings(s, { apiKey: "" });
    expect(KEY_GEMINI in s.data).toBe(false);
  });
  it("leaves fields untouched when not in the patch", async () => {
    const s = fakeStore({ [KEY_ENABLED]: "true" });
    await writeDeviceWizardSettings(s, { apiKey: "sk-1" });
    expect(s.data[KEY_ENABLED]).toBe("true");
  });
});

describe("resolveGeminiKey", () => {
  const OLD = process.env.GEMINI_API_KEY;
  beforeEach(() => { delete process.env.GEMINI_API_KEY; });
  it("prefers the DB key", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    expect(await resolveGeminiKey(fakeStore({ [KEY_GEMINI]: "db-key" }))).toBe("db-key");
  });
  it("falls back to the env key", async () => {
    process.env.GEMINI_API_KEY = "env-key";
    expect(await resolveGeminiKey(fakeStore())).toBe("env-key");
  });
  it("returns null when neither is set", async () => {
    expect(await resolveGeminiKey(fakeStore())).toBeNull();
  });
  afterAll?.(() => { if (OLD !== undefined) process.env.GEMINI_API_KEY = OLD; });
});
```

Note: remove the `afterAll?.` line if your Vitest setup doesn't import it; it's a best-effort env restore and not essential.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/features/settings/deviceWizardSettings.test.ts`
Expected: FAIL — cannot find module `./deviceWizardSettings`.

- [ ] **Step 3: Write the implementation**

```ts
// src/features/settings/deviceWizardSettings.ts
import type { SettingsStore } from "./store";

export const KEY_ENABLED = "device_wizard.enabled";
export const KEY_GEMINI = "device_wizard.gemini_api_key";

export interface DeviceWizardSettings { enabled: boolean; hasKey: boolean }

export async function readDeviceWizardSettings(store: SettingsStore): Promise<DeviceWizardSettings> {
  const [enabled, key] = await Promise.all([store.get(KEY_ENABLED), store.get(KEY_GEMINI)]);
  return { enabled: enabled === "true", hasKey: !!key && key.trim().length > 0 };
}

export async function writeDeviceWizardSettings(
  store: SettingsStore,
  patch: { enabled?: boolean; apiKey?: string },
): Promise<void> {
  if (patch.enabled !== undefined) await store.set(KEY_ENABLED, patch.enabled ? "true" : "false");
  if (patch.apiKey !== undefined) {
    const k = patch.apiKey.trim();
    if (k) await store.set(KEY_GEMINI, k);
    else await store.del(KEY_GEMINI);
  }
}

export async function resolveGeminiKey(store: SettingsStore): Promise<string | null> {
  const dbKey = (await store.get(KEY_GEMINI))?.trim();
  if (dbKey) return dbKey;
  const env = process.env.GEMINI_API_KEY?.trim();
  return env ? env : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/features/settings/deviceWizardSettings.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Typecheck & commit**

```bash
npx tsc --noEmit
git add src/features/settings/deviceWizardSettings.ts src/features/settings/deviceWizardSettings.test.ts
git commit -m "feat(settings): device-wizard settings orchestrators + resolveGeminiKey"
```

---

## Task 3: Server actions

**Files:**
- Create: `src/features/settings/actions.ts`

**Interfaces:**
- Consumes: `dbSettingsStore` from `./store`; `readDeviceWizardSettings`, `writeDeviceWizardSettings`, `type DeviceWizardSettings` from `./deviceWizardSettings`.
- Produces (`"use server"`):
  - `async function getDeviceWizardSettings(): Promise<DeviceWizardSettings>`
  - `async function updateDeviceWizardSettings(patch: { enabled?: boolean; apiKey?: string }): Promise<{ ok: boolean; error?: string }>`

No dedicated test (thin wiring over Task 2's tested orchestrators + Task 1's store).

- [ ] **Step 1: Write the actions**

```ts
// src/features/settings/actions.ts
"use server";

import { revalidatePath } from "next/cache";
import { dbSettingsStore } from "./store";
import { readDeviceWizardSettings, writeDeviceWizardSettings, type DeviceWizardSettings } from "./deviceWizardSettings";

export async function getDeviceWizardSettings(): Promise<DeviceWizardSettings> {
  return readDeviceWizardSettings(dbSettingsStore);
}

export async function updateDeviceWizardSettings(
  patch: { enabled?: boolean; apiKey?: string },
): Promise<{ ok: boolean; error?: string }> {
  try {
    await writeDeviceWizardSettings(dbSettingsStore, patch);
    revalidatePath("/settings");
    revalidatePath("/device-library");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Failed to save settings" };
  }
}
```

- [ ] **Step 2: Typecheck & commit**

```bash
npx tsc --noEmit
git add src/features/settings/actions.ts
git commit -m "feat(settings): getDeviceWizardSettings / updateDeviceWizardSettings actions"
```

---

## Task 4: Feed the resolved key into detection

**Files:**
- Modify: `src/features/device-library/ai/visionBackend.ts`
- Modify: `src/features/device-library/ai/actions.ts`
- Modify: `src/features/device-library/ai/pipeline.test.ts`

**Interfaces:**
- Changes: `VisionInput` gains `apiKey: string`. `detectPortsAction` resolves the key via `resolveGeminiKey(dbSettingsStore)`; returns `{ ok:false, error:"no-key" }` when null; otherwise passes `apiKey` into the backend input.

- [ ] **Step 1: Add `apiKey` to `VisionInput` and use it in the backend**

In `visionBackend.ts`, change the interface and the key read:

```ts
export interface VisionInput { imageBase64: string; mimeType: string; modelHint?: string; apiKey: string }
```

Replace the key lookup inside `geminiVisionBackend.detect` — remove the `process.env.GEMINI_API_KEY` read and the `if (!key)` throw, and use the passed key:

```ts
  async detect(input) {
    const genAI = new GoogleGenerativeAI(input.apiKey);
    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      generationConfig: { responseMimeType: "application/json", responseSchema },
    });
    // ...unchanged: build hint, generateContent, JSON.parse(result.response.text())...
  },
```

(Keep the rest of `detect` identical — only the key source changed.)

- [ ] **Step 2: Resolve the key in the action**

In `src/features/device-library/ai/actions.ts`, update `detectPortsAction`:

```ts
import { resolveGeminiKey } from "@/features/settings/deviceWizardSettings";
import { dbSettingsStore } from "@/features/settings/store";
// ...
export async function detectPortsAction(input: { imageBase64: string; mimeType: string; modelHint?: string }): Promise<DetectResult> {
  if (!input.imageBase64) return { ok: false, error: "No image provided." };
  if (input.imageBase64.length > MAX_IMAGE_BYTES * (4 / 3)) return { ok: false, error: "Image is too large (max 8 MB)." };
  const apiKey = await resolveGeminiKey(dbSettingsStore);
  if (!apiKey) return { ok: false, error: "no-key" };
  return runDetectPorts(geminiVisionBackend, { ...input, apiKey });
}
```

(This also tightens the size pre-check multiplier from `1.4` to `4/3` — a Minor from the prior review.)

- [ ] **Step 3: Update the pipeline test inputs**

`runDetectPorts` still takes `(backend, input)`; the fake backends ignore `apiKey`, but `VisionInput` now requires it. In `pipeline.test.ts`, add `apiKey: "test-key"` to every `runDetectPorts(..., { imageBase64: ..., mimeType: ... })` input object so the calls typecheck.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/features/device-library/ai/pipeline.test.ts`
Expected: PASS (all).
Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/ai/visionBackend.ts src/features/device-library/ai/actions.ts src/features/device-library/ai/pipeline.test.ts
git commit -m "feat(settings): detect action resolves the Gemini key (DB/env), returns no-key when absent"
```

---

## Task 5: DeviceWizard — enable gate + no-key prompt

**Files:**
- Modify: `src/features/device-library/editor/DeviceWizard.tsx`
- Modify: `src/features/device-library/editor/DeviceWizard.test.tsx`

**Interfaces:**
- `DeviceWizardProps` gains `enabled: boolean` and `hasKey: boolean`.
- Behavior: when `!enabled`, the component renders nothing (no icon). When opened with `!hasKey` (or a detect returns `error === "no-key"`), the strip shows a single prompt line linking to `/settings` instead of search/upload.

- [ ] **Step 1: Write the failing tests**

Add to `DeviceWizard.test.tsx` (extend the existing `base` with `enabled: true, hasKey: true`; the new tests override those):

```tsx
it("renders nothing when the feature is disabled", () => {
  const { container } = render(<DeviceWizard {...base} enabled={false} hasKey={true} runDetect={okDetect} runIdentify={okIdentify} />);
  expect(container.querySelector('button[aria-label="Device Wizard"]')).toBeNull();
});

it("shows a Settings prompt (not search/upload) when enabled without a key", () => {
  render(<DeviceWizard {...base} enabled={true} hasKey={false} runDetect={okDetect} runIdentify={okIdentify} />);
  fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
  expect(screen.queryByPlaceholderText(/model/i)).toBeNull();
  const link = screen.getByRole("link", { name: /settings/i });
  expect(link).toHaveAttribute("href", "/settings");
});
```

Also update the top-of-file `base` fixture to include `enabled: true, hasKey: true` so the existing tests still render the icon.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/device-library/editor/DeviceWizard.test.tsx`
Expected: FAIL — `enabled`/`hasKey` not on props; disabled render still shows the button; no Settings link.

- [ ] **Step 3: Implement**

In `DeviceWizard.tsx`:
- Add `enabled: boolean; hasKey: boolean;` to `DeviceWizardProps` and destructure them.
- At the very top of the component body (after hooks — keep hook order stable; put the guard right before `return`): `if (!enabled) return null;`
- In the JSX, when `open` and `phase === "input"`, render the no-key prompt instead of the search/upload controls when `!hasKey`:

```tsx
{phase === "input" && !hasKey && (
  <div className="flex items-center gap-2 whitespace-nowrap text-sm text-neutral-600">
    <span>Add your Gemini API key in</span>
    <a href="/settings" className="font-medium text-blue-600 hover:underline">Settings →</a>
  </div>
)}
{(phase === "input" || phase === "detecting") && hasKey && (
  /* ...the existing search input + Search + Upload block, unchanged... */
)}
```

(Only the `input`/`detecting` block is gated on `hasKey`; the `candidate`/`review`/`error` blocks are unchanged. `if (!enabled) return null` must come after all hooks so React hook order stays constant.)

- Optional nicety: if a detect returns `error === "no-key"`, render the same Settings prompt in the error branch instead of the raw string. Minimal: `{phase === "error" && (error === "no-key" ? <SettingsPrompt/> : <span>{error}</span> ...)}`. Keep it simple — reuse the same prompt markup.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/features/device-library/editor/DeviceWizard.test.tsx`
Expected: PASS (all, including the two new tests).
Run: `npx tsc --noEmit`
Expected: clean (note: RackDeviceEditor now passes the new required props — Task 7 supplies them; if tsc flags the editor here, do Task 7 before typechecking the whole project, or temporarily default the props. Prefer completing Task 7's editor prop-passing in the same cycle if tsc gates.)

- [ ] **Step 5: Commit**

```bash
git add src/features/device-library/editor/DeviceWizard.tsx src/features/device-library/editor/DeviceWizard.test.tsx
git commit -m "feat(settings): DeviceWizard gates on enabled + shows no-key Settings prompt"
```

---

## Task 6: Settings page UI + route + nav

**Files:**
- Create: `src/features/settings/DeviceWizardSettings.tsx`
- Test: `src/features/settings/DeviceWizardSettings.test.tsx`
- Create: `src/features/settings/SettingsPage.tsx`
- Create: `src/app/settings/page.tsx`
- Modify: `src/features/shell/AppSidebar.tsx`
- Modify: `src/features/shell/AppShell.tsx`

**Interfaces:**
- `DeviceWizardSettings.tsx`: `function DeviceWizardSettingsPanel({ initial, save }: { initial: { enabled: boolean; hasKey: boolean }; save?: typeof updateDeviceWizardSettings })` — `save` injectable (defaults to the real action) so tests use a fake.
- `SettingsPage.tsx`: `function SettingsPage({ deviceWizard }: { deviceWizard: { enabled: boolean; hasKey: boolean } })` — renders the category rail (`Features › Device Wizard`) and the panel.

- [ ] **Step 1: Write the failing panel test**

```tsx
// src/features/settings/DeviceWizardSettings.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeviceWizardSettingsPanel } from "./DeviceWizardSettings";

const okSave = () => vi.fn().mockResolvedValue({ ok: true });

describe("DeviceWizardSettingsPanel", () => {
  it("toggling enabled calls save with the new value", async () => {
    const save = okSave();
    render(<DeviceWizardSettingsPanel initial={{ enabled: false, hasKey: false }} save={save} />);
    fireEvent.click(screen.getByRole("switch", { name: /show the device wizard/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true }));
  });

  it("shows a 'key is set' state and a Remove action when a key exists", () => {
    render(<DeviceWizardSettingsPanel initial={{ enabled: true, hasKey: true }} save={okSave()} />);
    expect(screen.getByText(/key is set/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove key/i })).toBeInTheDocument();
  });

  it("saving a typed key calls save with apiKey and flips to the set state", async () => {
    const save = okSave();
    render(<DeviceWizardSettingsPanel initial={{ enabled: true, hasKey: false }} save={save} />);
    fireEvent.change(screen.getByLabelText(/gemini api key/i), { target: { value: "sk-123" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ apiKey: "sk-123" }));
    expect(await screen.findByText(/key is set/i)).toBeInTheDocument();
  });

  it("Remove calls save with an empty apiKey", async () => {
    const save = okSave();
    render(<DeviceWizardSettingsPanel initial={{ enabled: true, hasKey: true }} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: /remove key/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ apiKey: "" }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/features/settings/DeviceWizardSettings.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the panel**

```tsx
// src/features/settings/DeviceWizardSettings.tsx
"use client";

import { useState } from "react";
import { updateDeviceWizardSettings } from "./actions";

export function DeviceWizardSettingsPanel({
  initial, save = updateDeviceWizardSettings,
}: {
  initial: { enabled: boolean; hasKey: boolean };
  save?: typeof updateDeviceWizardSettings;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [hasKey, setHasKey] = useState(initial.hasKey);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function toggle() {
    const next = !enabled;
    setEnabled(next); setBusy(true); setError("");
    const r = await save({ enabled: next });
    setBusy(false);
    if (!r.ok) { setEnabled(!next); setError(r.error ?? "Save failed"); }
  }

  async function saveKey() {
    if (!keyInput.trim()) return;
    setBusy(true); setError("");
    const r = await save({ apiKey: keyInput });
    setBusy(false);
    if (r.ok) { setHasKey(true); setKeyInput(""); } else setError(r.error ?? "Save failed");
  }

  async function removeKey() {
    setBusy(true); setError("");
    const r = await save({ apiKey: "" });
    setBusy(false);
    if (r.ok) setHasKey(false); else setError(r.error ?? "Save failed");
  }

  const status = !enabled ? "Disabled"
    : hasKey ? "Enabled · key set"
    : "Enabled · no key — the wizard will prompt you to add one";

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h2 className="text-lg font-bold">Device Wizard</h2>
        <p className="mt-1 text-sm text-neutral-500">{status}</p>
      </div>

      <label className="flex items-center justify-between gap-4 rounded-lg border border-neutral-200 p-4">
        <span className="text-sm font-medium text-neutral-800">Show the Device Wizard in the rack device editor</span>
        <button
          type="button" role="switch" aria-checked={enabled} aria-label="Show the Device Wizard in the rack device editor"
          disabled={busy} onClick={toggle}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-blue-600" : "bg-neutral-300"}`}
        >
          <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${enabled ? "translate-x-5" : "translate-x-0.5"}`} />
        </button>
      </label>

      <div className="rounded-lg border border-neutral-200 p-4">
        <label htmlFor="gemini-key" className="text-sm font-medium text-neutral-800">Gemini API key</label>
        <p className="mt-1 text-xs text-neutral-500">Free from Google AI Studio. Stored server-side and used only by the wizard.</p>
        {hasKey ? (
          <div className="mt-3 flex items-center gap-3">
            <span className="rounded bg-neutral-100 px-2 py-1 text-sm text-neutral-600">•••• key is set</span>
            <button type="button" disabled={busy} onClick={removeKey} className="text-sm text-red-600 hover:underline">Remove key</button>
          </div>
        ) : (
          <div className="mt-3 flex items-center gap-2">
            <input
              id="gemini-key" type="password" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Paste your key" className="w-64 rounded border border-neutral-300 px-2 py-1 text-sm"
            />
            <button type="button" disabled={busy || !keyInput.trim()} onClick={saveKey} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50">Save</button>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run panel tests**

Run: `npx vitest run src/features/settings/DeviceWizardSettings.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement SettingsPage + route + nav (no new test; verified via typecheck + browser)**

`SettingsPage.tsx`:

```tsx
// src/features/settings/SettingsPage.tsx
"use client";

import { DeviceWizardSettingsPanel } from "./DeviceWizardSettings";

export function SettingsPage({ deviceWizard }: { deviceWizard: { enabled: boolean; hasKey: boolean } }) {
  return (
    <div className="flex gap-8">
      <nav className="w-56 shrink-0">
        <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-400">Features</p>
        <span className="block rounded-lg bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700">Device Wizard</span>
      </nav>
      <section className="min-w-0 flex-1">
        <DeviceWizardSettingsPanel initial={deviceWizard} />
      </section>
    </div>
  );
}
```

`src/app/settings/page.tsx`:

```tsx
import { getDeviceWizardSettings } from "@/features/settings/actions";
import { SettingsPage } from "@/features/settings/SettingsPage";

export const dynamic = "force-dynamic";

export default async function Settings() {
  const deviceWizard = await getDeviceWizardSettings();
  return <SettingsPage deviceWizard={deviceWizard} />;
}
```

`AppSidebar.tsx` — wire the existing "Settings & Billing" item to the route (change that one line):

```tsx
<NavItem icon="tabler:settings" label="Settings & Billing" href="/settings" active={pathname.startsWith("/settings")} />
```

`AppShell.tsx` — add the title mapping:

```tsx
const TITLES: [prefix: string, title: string][] = [
  ["/racks", "Racks"],
  ["/device-library", "Device Library"],
  ["/settings", "Settings"],
];
```

- [ ] **Step 6: Typecheck & commit**

```bash
npx tsc --noEmit
git add src/features/settings/DeviceWizardSettings.tsx src/features/settings/DeviceWizardSettings.test.tsx src/features/settings/SettingsPage.tsx src/app/settings/page.tsx src/features/shell/AppSidebar.tsx src/features/shell/AppShell.tsx
git commit -m "feat(settings): Settings page (Features > Device Wizard) + nav wiring"
```

---

## Task 7: Thread settings into the editor

**Files:**
- Modify: `src/app/device-library/page.tsx`
- Modify: `src/features/device-library/editor/EditorLauncher.tsx`
- Modify: `src/features/device-library/editor/RackDeviceEditor.tsx`
- Modify: `src/features/device-library/editor/RackDeviceEditor.test.tsx` (fixtures)

**Interfaces:**
- `EditorLauncher` gains a prop `wizard: { enabled: boolean; hasKey: boolean }`, passed to `RackDeviceEditor` as `wizardEnabled`/`wizardHasKey`.
- `RackDeviceEditorProps` gains `wizardEnabled: boolean` and `wizardHasKey: boolean`, forwarded to `<DeviceWizard enabled={wizardEnabled} hasKey={wizardHasKey} ... />`.

- [ ] **Step 1: Fetch settings in the device-library page**

```tsx
// src/app/device-library/page.tsx — add the import and fetch, pass to EditorLauncher
import { getDeviceWizardSettings } from "@/features/settings/actions";
// ...inside the component, add to the Promise.all or a separate await:
const wizard = await getDeviceWizardSettings();
// ...render:
return <EditorLauncher rows={rows} types={types.filter((t) => t.category === "rack")} brands={brands} wizard={wizard} />;
```

- [ ] **Step 2: Thread through EditorLauncher**

Add `wizard` to `EditorLauncher`'s props and pass it to `RackDeviceEditor`:

```tsx
export function EditorLauncher({
  rows, types, brands, wizard,
}: { rows: DeviceTemplateListRow[]; types: DeviceTypeRow[]; brands: BrandRow[]; wizard: { enabled: boolean; hasKey: boolean } }) {
  // ...
  // in the <RackDeviceEditor .../> render, add:
  //   wizardEnabled={wizard.enabled}
  //   wizardHasKey={wizard.hasKey}
}
```

- [ ] **Step 3: Accept + forward in RackDeviceEditor**

In `RackDeviceEditorProps`, add `wizardEnabled: boolean; wizardHasKey: boolean;`. In the header render, change the wizard mount to:

```tsx
{!ro && <DeviceWizard enabled={props.wizardEnabled} hasKey={props.wizardHasKey} widthIn={draft.widthIn} rackUnits={draft.rackUnits} onApply={applyWizard} />}
```

- [ ] **Step 4: Update RackDeviceEditor tests**

The existing `RackDeviceEditor.test.tsx` constructs the editor with a `baseProps` object. Add `wizardEnabled: true, wizardHasKey: true` to that fixture so the wizard mounts (its own gating is unit-tested in Task 5). The `DeviceWizard` is already mocked in the editor test; the mock ignores the new props, so no assertion changes — just satisfy the type.

- [ ] **Step 5: Run affected tests + full typecheck**

Run: `npx vitest run src/features/device-library/editor/RackDeviceEditor.test.tsx src/features/device-library/editor/DeviceWizard.test.tsx`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: clean (all prop wiring now satisfied end to end).

- [ ] **Step 6: Full suite + commit**

Run: `npx vitest run`
Expected: all green.

```bash
git add src/app/device-library/page.tsx src/features/device-library/editor/EditorLauncher.tsx src/features/device-library/editor/RackDeviceEditor.tsx src/features/device-library/editor/RackDeviceEditor.test.tsx
git commit -m "feat(settings): thread wizard enabled/hasKey from settings into the editor"
```

---

## Self-review notes (reconciled)

- **Spec coverage:** global `app_settings` store (Task 1) · read/write/resolve orchestrators + write-only `hasKey` (Task 2) · server actions (Task 3) · key resolved server-side into detection with `no-key` (Task 4) · icon gate + no-key prompt (Task 5) · Settings page `Features › Device Wizard` with toggle + write-only key field + Remove + nav (Task 6) · editor threading (Task 7).
- **Security:** the raw key is never returned by `getDeviceWizardSettings` (only `hasKey`), read only in `server-only`/`"use server"` code, and passed straight into the backend; `resolveGeminiKey` keeps the env fallback. Stated DB-plaintext caveat (single-tenant, no auth) is in the spec, not the code.
- **Type consistency:** `DeviceWizardSettings { enabled, hasKey }` flows from Task 2 → actions (Task 3) → page/EditorLauncher/RackDeviceEditor/DeviceWizard (Tasks 5/7); `VisionInput.apiKey` added in Task 4 and supplied by the action.
- **Ordering caveat:** Task 5 adds required `enabled`/`hasKey` props to `DeviceWizard`; the editor doesn't supply them until Task 7, so a whole-project `tsc` is only guaranteed clean after Task 7 (noted in Task 5 Step 4). Per-task focused tests still pass in order.
