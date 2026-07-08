# Device Types: categories, codes, standard vs custom — design

**Date:** 2026-07-08 · **Status:** approved (incl. live-app corrections) · **Preview:** UI already
built front-end-only in `DeviceTypesManager.tsx` (local state); this spec makes it real.
**Rev 2:** validation + create-modal + table actions aligned with PatchDocs' live app
(see `docs/reference/patchdocs-notes.md` → "Their Device Library UI").

## Context & goal

The Device Types tab becomes a two-column manager — **Floor Device Types | Rack Device Types** —
matching PatchDocs' model (see `docs/reference/patchdocs-notes.md`): every device type has an
**abbreviation code** that will serve as the default **ID prefix** when devices are placed
(SW01, SW02, …). Standard types are seeded by us; users can adjust codes and add custom types.
The rack editor's "Device type" dropdown must only offer rack-category types.

## Data model (migration `0003_device_type_categories.sql`)

Extend the existing `device_types` table (single-table approach — the `device_templates` FK keeps
working untouched):

```sql
alter table device_types
  add column category text not null default 'rack' check (category in ('floor','rack')),
  add column code text not null default '',
  add column is_standard boolean not null default false;

-- names only need to be unique within their column (floor list contains "Rack")
alter table device_types drop constraint device_types_organization_id_name_key;
alter table device_types add constraint device_types_org_category_name_key
  unique (organization_id, category, name);

-- codes are ID prefixes: 1–4 uppercase alphanumerics, unique across ALL types in the org
-- (added AFTER the backfill below so the seed data satisfies them)
alter table device_types add constraint device_types_code_format_check
  check (code ~ '^[A-Z0-9]{1,4}$');
alter table device_types add constraint device_types_org_code_key
  unique (organization_id, code);
```

(The 24 seeded codes are all ≤4 chars and mutually distinct, so both constraints hold.)

Backfill + seed (default org):

- Mark the existing 12 types `is_standard = true`, `category = 'rack'`, with codes:
  Switch **SW**, Router **RT**, Firewall **FW**, Gateway **GW**, Patch Panel **PP**, Server **SRV**,
  UPS **UPS**, PDU **PDU**, KVM **KVM**, Cable Manager **CM**, Shelf/Tray **ST**, Other **OTH**.
- Insert 12 standard **floor** types: Access Control Panel **ACP**, Access Point **AP**,
  Camera **CAM**, Desktop **DP**, Telecommunications Outlet **TO**, ISP Uplink **ISP**,
  Laptop **LP**, Phone **PH**, Printer **PR**, 3D Printer **3DP**, Rack **RK**, Screen **SCR**.

## Rules (enforced server-side, mirrored in UI)

| | Standard | Custom |
|---|---|---|
| Rename | ✗ | ✓ |
| Edit code | ✓ | ✓ |
| Delete | ✗ (server rejects) | ✓ — existing FK `on delete restrict` blocks types in use |

- **Code ("ID prefix")**: required, trimmed, auto-uppercased, **1–4 chars, A–Z and 0–9 only,
  unique across ALL device-type prefixes in the org** (both categories — uniqueness is what makes
  a device ID like SW01 unambiguously parseable back to its type). DB: `unique (organization_id,
  code)` + a `code ~ '^[A-Z0-9]{1,4}$'` check. UI helper text mirrors PatchDocs: "1–4 characters,
  uppercase letters and numbers only. Must be unique across all device type ID prefixes."
- **Name** (custom): required, unique per (org, category) — DB constraint; surface a friendly error.
- Codes are *default ID prefixes* for future device-ID generation. Adopt PatchDocs' rule when that
  lands: **changing a code affects only newly added devices** (existing IDs keep their prefix).

## Server layer

`repository.ts`:
- `DeviceTypeRow` gains `category: "floor" | "rack"`, `code: string`, `is_standard: boolean`.
- `listDeviceTypes` unchanged (order by name); callers split by category.
- `createDeviceType(db, { name, code, category })` → custom type (`is_standard: false`).
- `updateDeviceType(db, id, { name?, code? })` → guard: if `is_standard`, apply `code` only.
- `deleteDeviceType(db, id)` → guard: reject if `is_standard` (before hitting the FK).

`typeActions.ts`:
- `createDeviceTypeAction({ name, code, category })`.
- `saveDeviceTypesAction(changes: { id, name?, code? }[])` — one batch per column Save.
- `deleteDeviceTypeAction(id)` (exists) — keep; still surfaces the in-use FK error.
- All validate code/name rules and return `{ ok, error? }` like the existing actions.

## UI behaviour (`DeviceTypesManager` — wire the existing preview)

- `types/page.tsx` fetches all types server-side, splits floor/rack, renders two
  `DeviceTypeColumn`s (side-by-side ≥ xl, stacked below).
- **Standard panel**: name (read-only) + code input per row, two-column flow; **Save changes**
  enabled only when a code differs from the loaded value; on click, batch-saves changed codes,
  refreshes via `router.refresh()`.
- **Custom panel**: **+ Add** opens a small modal — "Create Floor/Rack Device Type": Name* +
  ID prefix* (helper text: "1–4 characters, uppercase letters and numbers only. Must be unique
  across all device type ID prefixes."), Cancel / Create; Create validates then persists
  immediately (matches PatchDocs' live app). Existing custom rows render inline with editable
  name + code (batch-saved by the column's Save changes) and a delete button that calls
  `deleteDeviceTypeAction` immediately so FK "in use" errors surface at the point of action.
- Empty custom state: “Click "Add" to create your first custom device type.”
- Errors render inline in the column (existing red-text pattern); the create modal shows its own.

## Rack Devices tab additions (PatchDocs parity)

- **Row actions become three icons**: duplicate, edit (pencil), delete (red trash) — replacing the
  lone "Edit" button.
  - *Duplicate*: copies the template (name gets a " copy" suffix or "(2)") via a new
    `duplicateDeviceTemplateAction`; lands in the table, opens nothing.
  - *Delete*: confirm dialog, then `deleteDeviceTemplateAction`; repository gains
    `deleteDeviceTemplate`. (No FK from racks yet — deployment lands in Phase 2b; revisit the
    guard then.)
- **Name becomes a link opening the editor in read-only mode**: banner "You are viewing this
  custom rack device in read-only mode.", all inputs/palette/canvas interactions disabled, single
  Close button. Implemented as a `readOnly` prop on `RackDeviceEditor` (skip overlay handlers +
  disable fields) — the same pure Faceplate render. This is the safe inspection path once
  deployed-template edits become destructive (Phase 2b).

## Editor integration

- `device-library/page.tsx` passes only `category === 'rack'` types to `EditorLauncher` →
  `RackDeviceEditor`'s Device type dropdown ("Other" stays last per existing `Select` behavior).
- Custom rack types appear in the dropdown automatically; floor types never do.

## Testing

- Component tests (`DeviceTypesManager.test.tsx`): renders both columns from props; code edit
  enables that column's Save only; Save calls the action with only changed rows; standard rows have
  no name input / no delete; Add → create modal (validates 1–4 A–Z0–9, calls create action);
  existing-custom delete calls the action; error text renders.
- Table tests: three actions render; duplicate/delete call their actions; name link opens
  read-only editor (banner present, inputs disabled).
- Action/repository guards: standard rename ignored, standard delete rejected (unit-test the guard
  logic; Supabase calls follow the existing thin-wrapper pattern).
- Update existing tests touched by the `DeviceTypeRow` shape and the rack-only editor filter.
- Manual: `npx supabase db reset` (or migration up) locally; verify seed + backfill; browser-verify
  both columns, dirty-save, add/delete, editor dropdown filtering.

## Out of scope (deliberate)

- Generating device IDs from codes (belongs to rack/floor device placement — Phase 2b+).
- Client/Site hierarchy (own brainstorm); per-client scoping of device types.
- Floor devices themselves; the floor column is reference data until floor plans land.
