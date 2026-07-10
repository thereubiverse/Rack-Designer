# Settings page — Device Wizard enable toggle + Gemini API key

**Date:** 2026-07-10
**Status:** Design approved, pending implementation plan

## Problem

The Device Wizard (AI port detection) currently always shows its icon in the
rack-device editor and reads its Gemini key only from the `GEMINI_API_KEY`
server env var. There is no in-app way to turn the feature on/off or to supply a
key. We want a Settings page where a user can enable/disable the wizard (which
controls whether its icon appears in the editor) and enter their own Gemini API
key that the wizard uses.

## Goal

A global Settings page with `Features › Device Wizard`, offering:
- an **enable toggle** that gates whether the wizard icon shows in the editor, and
- a **Gemini API key field** (write-only) whose value is stored server-side and
  used by the wizard's detect action.

## Settled decisions (from brainstorming)

- **Global settings, not per-user.** The app has no auth yet (`supabase/server.ts`
  uses the service role, "no auth yet"), so settings are a single global store.
- **Key stored in the server DB, never returned to the client.** The settings
  form writes the key; the UI only ever learns whether a key *is set* (a masked
  "key is set" state), never the value. The wizard's detect action reads the DB
  key server-side, falling back to `process.env.GEMINI_API_KEY`.
- **Enabled but no key → show the icon with a friendly prompt.** The toggle alone
  controls the icon (matches "enable the feature for the icon to show"). When
  enabled with no key set, opening the wizard shows "Add your Gemini API key in
  Settings →" instead of the search/upload UI.

## Architecture & data flow

```
Settings form ─▶ updateDeviceWizardSettings (server) ─▶ app_settings (Supabase)
Editor load   ─▶ getDeviceWizardSettings (server) ─▶ { enabled, hasKey } ─▶ DeviceWizard
Wizard detect ─▶ detectPortsAction ─▶ resolveGeminiKey() (DB ▸ env) ─▶ Gemini
```

### Storage

A global key/value table `app_settings` (extensible for future settings). This
feature uses two keys:
- `device_wizard.enabled` → `"true"` | `"false"`
- `device_wizard.gemini_api_key` → the secret

Added via a new Supabase migration (next number in `supabase/migrations/`).

### New units

| Unit | Kind | Responsibility |
| --- | --- | --- |
| migration `*_app_settings.sql` | schema | Create `app_settings (key text primary key, value text not null, updated_at)`. |
| `settings/repository.ts` | server | `getSetting(key)`, `setSetting(key, value)`, `deleteSetting(key)` on `app_settings` (service client). |
| `settings/actions.ts` | `"use server"` | `getDeviceWizardSettings()` → `{ enabled: boolean, hasKey: boolean }` (NEVER the key). `updateDeviceWizardSettings({ enabled?, apiKey? })` — writes toggle and/or key; empty `apiKey` deletes the key; returns nothing sensitive. |
| `settings/geminiKey.ts` | server-only | `resolveGeminiKey(): Promise<string \| null>` — DB key, else `process.env.GEMINI_API_KEY`, else null. |
| `settings/SettingsPage.tsx` | client | Two-column layout: category rail (`Features › Device Wizard`) + content panel. |
| `settings/DeviceWizardSettings.tsx` | client | Enable toggle + write-only key field + status line. |
| `app/settings/page.tsx` | route | Server component: loads current `{ enabled, hasKey }`, renders `SettingsPage`. |

### Changes to existing code

- **`visionBackend.ts` / `detectPortsAction`:** the key is resolved server-side
  via `resolveGeminiKey()` and passed into the backend, instead of the backend
  reading `process.env` directly. When null, the detect action returns a typed
  `{ ok: false, error: "no-key" }` (no Gemini call).
- **`DeviceWizard.tsx`:** gains `enabled: boolean` and `hasKey: boolean` props.
  Renders the icon only when `enabled`. On open with `hasKey === false`, the
  slide-out shows the "Add your Gemini API key in Settings →" prompt (a link to
  `/settings`) instead of the search/upload controls.
- **`RackDeviceEditor` (and its route/parent):** fetch `getDeviceWizardSettings()`
  and pass `enabled`/`hasKey` down to `DeviceWizard`. (The editor is opened from
  the device-library page; settings are fetched there and threaded through, or
  fetched in the editor's server parent.)
- **`AppShell.tsx`:** add a **Settings** entry (gear) linking to `/settings`.

## UI

**Settings page** (`/settings`): left category rail lists sections; **Features**
is a section with **Device Wizard** as its sub-item (`Settings › Features ›
Device Wizard`), selected by default. Built so more categories/sub-items slot in
later.

**Device Wizard panel:**
- **Enable toggle** — "Show the Device Wizard in the rack device editor." Saves
  on change via `updateDeviceWizardSettings({ enabled })`.
- **Gemini API key field** — password input.
  - Key already set: shows a masked "key is set" state (server never sends the
    value) + a **Remove key** button.
  - Enter a value + **Save** → `updateDeviceWizardSettings({ apiKey })`; field
    then reflects the "set" state without echoing the value.
  - Helper line: free key from Google AI Studio; stored server-side; used only by
    the wizard.
- **Status line** — e.g. "Enabled · key set" / "Enabled · no key — the wizard
  will prompt you to add one" / "Disabled".

**Editor no-key prompt:** when `enabled && !hasKey`, the wizard slide-out shows a
single line — "Add your Gemini API key in **Settings** →" (links to `/settings`)
— instead of search/upload. When `hasKey`, the normal flow.

## Security

- **Write-only to the client:** `getDeviceWizardSettings()` returns only
  `{ enabled, hasKey }`; the raw key is never serialized to the browser.
  `updateDeviceWizardSettings` accepts a key but returns nothing sensitive.
- **Read only server-side:** the key value is read exclusively in `server-only`
  code (`resolveGeminiKey()` / the `"use server"` detect action) and passed
  straight to the Gemini call — never logged, never a client prop, never in a URL.
- **DB storage caveat (stated, not accidental):** with no auth yet, the key sits
  in `app_settings` reachable via the service role, and anyone who can reach the
  app can set/replace it. Acceptable for a single-tenant internal tool; when auth
  lands, settings/key can move behind it.
- **No new client secret:** `GEMINI_API_KEY` env stays a fallback; nothing about
  the key touches `NEXT_PUBLIC_`.

## Testing

- **Repository/actions:** `updateDeviceWizardSettings` persists the toggle and
  key; an empty key deletes it; `getDeviceWizardSettings` returns `hasKey`
  (true/false) and NEVER the raw key. `resolveGeminiKey()` — DB key wins, env
  fallback, none → null.
- **Detect action:** no resolvable key → `{ ok:false, error:"no-key" }` with no
  Gemini call; with a key → passes it to the (faked) backend.
- **DeviceWizard gating:** icon absent when `enabled===false`; when
  `enabled && !hasKey`, opening shows the "Add your key in Settings" prompt (not
  search/upload); `enabled && hasKey` → normal flow.
- **Settings panel:** toggle calls the action; saving a key flips the field to
  the masked "set" state; Remove clears it.

## Out of scope

- Per-user settings / auth (no auth yet).
- Encrypting the key at rest in the DB (plaintext in a single-tenant tool;
  revisit with auth).
- Settings beyond the Device Wizard section (the page is built to extend, but
  only Device Wizard ships now).
- Fixing/replacing the DuckDuckGo search library (separate follow-up).
