# Phase 2a · Slice 1 — Deferred items

Surfaced during Slice 1 reviews; intentionally deferred. None block the slice.

## For later slices
- **Type `front_face` / `back_face` as `Face | null`** — currently `unknown | null` in
  `device_templates` row type. Tighten when **Slice 3** starts writing faces.
  (`src/features/device-library/repository.ts`)
- **`deleteDeviceTemplateAction`** is exported but not yet wired to UI — a planned
  produced-interface; wire it when the Rack Devices table gets row actions.

## When auth / multi-tenant lands
- **Validate `deviceTypeId` / `brandId` ownership** in `createDeviceTemplateAction`
  (currently backstopped by the FK + the org-scoped `<select>` + RLS).

## Housekeeping (any time)
- **Pre-existing repo-wide `npm run lint` failure** — ESLint 9 flat-config issue
  (circular structure when merging Next's config with the react plugin). Predates this
  slice; `next build`'s TS/lint pass is clean. Fix if standalone `eslint` CLI is wanted.
- **Redundant grant in `0002_device_library.sql`** — `grant all ... to service_role`
  duplicates `0001`'s blanket grant (harmless/idempotent). Drop if the migration is
  touched again.
