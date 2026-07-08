# Device Types: categories, codes, standard vs custom — design

**Date:** 2026-07-08 · **Status:** approved pending Reuben's review · **Preview:** UI already built
front-end-only in `DeviceTypesManager.tsx` (local state); this spec makes it real.

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
```

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

- **Code**: required, trimmed, auto-uppercased, 1–8 chars. Not unique (codes may repeat).
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
- **Custom panel**: **+ Add** appends an inline draft row (name + code + delete). Save changes
  (same button/column) creates drafts and updates edited existing customs. A draft missing its name
  or code blocks the save with an inline error; an entirely empty draft is discarded silently.
  Row delete on an *existing* custom calls `deleteDeviceTypeAction` immediately (so FK "in use"
  errors surface at the point of action); deleting a draft row is local.
- Empty custom state: “Click "Add" to create your first custom device type.”
- Errors render inline in the column (existing red-text pattern).

## Editor integration

- `device-library/page.tsx` passes only `category === 'rack'` types to `EditorLauncher` →
  `RackDeviceEditor`'s Device type dropdown ("Other" stays last per existing `Select` behavior).
- Custom rack types appear in the dropdown automatically; floor types never do.

## Testing

- Component tests (`DeviceTypesManager.test.tsx`): renders both columns from props; code edit
  enables that column's Save only; Save calls the action with only changed rows; standard rows have
  no name input / no delete; Add → draft row; draft delete is local; existing-custom delete calls
  the action; error text renders.
- Action/repository guards: standard rename ignored, standard delete rejected (unit-test the guard
  logic; Supabase calls follow the existing thin-wrapper pattern).
- Update existing tests touched by the `DeviceTypeRow` shape and the rack-only editor filter.
- Manual: `npx supabase db reset` (or migration up) locally; verify seed + backfill; browser-verify
  both columns, dirty-save, add/delete, editor dropdown filtering.

## Out of scope (deliberate)

- Generating device IDs from codes (belongs to rack/floor device placement — Phase 2b+).
- Client/Site hierarchy (own brainstorm); per-client scoping of device types.
- Floor devices themselves; the floor column is reference data until floor plans land.
