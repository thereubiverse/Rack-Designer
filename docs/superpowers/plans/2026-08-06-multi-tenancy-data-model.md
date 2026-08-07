# Multi-Tenancy Slice 1: Data Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every row an owning organisation, so a second company can exist — with no change to how the application behaves or how it is secured.

**Architecture:** A new `organisations` table, an `org_id` column on all 19 existing tables, `before insert` triggers that copy `org_id` down from each row's parent, and composite foreign keys carrying `org_id` through every relationship so a cross-organisation row is refused by Postgres rather than by application code. The application supplies `org_id` in exactly three places; everything else inherits it.

**Tech Stack:** Postgres 17.6 (Supabase), TypeScript strict, Next.js 16 server actions, vitest.

**Spec:** `docs/superpowers/specs/2026-08-06-multi-tenancy-data-model-design.md`

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** `*.integration.test.ts` files WIPE THE LOCAL DATABASE, which holds real data (3 clients, 31 sites, 1 rack, 2 members, 8 activity rows). Run named files only.
- **Take a backup before Task 7.** `bash deploy/backup.sh` — the storage move is the one step a migration revert cannot undo.
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- Apply migrations with `docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < FILE`. The `-i` is required; without it psql receives nothing and reports success.
- Use `command grep`, not bare `grep`. Quote globs.
- **New migrations grant nothing to `anon` or `authenticated`** — see `supabase/migrations/README.md`. No grant tail. Slice 2 changes this deliberately; slice 1 does not.
- **Every new function needs `revoke all on function … from public`.** The schema-level default is not a backstop — see migration `0032`.
- NEVER put a real secret in a git-tracked file. The GitHub repo is PUBLIC.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- British spelling, matching the codebase (`normaliseEmail`, `organisations`).

## The 19 tables, and how each gets its `org_id`

| Table | `org_id` | Source |
|---|---|---|
| `clients` | not null | supplied by app |
| `members` | not null | supplied by app |
| `app_settings` | not null | supplied by app (no parent row) |
| `sites` | not null | trigger ← `clients` via `client_id` |
| `floors` | not null | trigger ← `sites` via `site_id` |
| `rooms` | not null | trigger ← `floors` via `floor_id` |
| `racks` | not null | trigger ← `rooms` via `room_id` |
| `rack_devices` | not null | trigger ← `racks` via `rack_id` |
| `connections` | not null | trigger ← `racks` via `rack_id` |
| `port_endpoints` | not null | trigger ← `racks` via `rack_id` |
| `floor_devices` | not null | trigger ← `sites` via `site_id` |
| `floor_plans` | not null | trigger ← `floors` via `floor_id` |
| `activity_log` | **nullable** | trigger ← `members` via `member_id`; NULL = platform event with no org (a refused sign-in from an unknown address) |
| `trusted_devices` | not null | trigger ← `members` via `member_id` |
| `phone_verifications` | not null | trigger ← `members` via `member_id` |
| `device_challenges` | not null | trigger ← `trusted_devices` via `device_id` |
| `brands` | **nullable** | NULL = shared standard |
| `device_types` | **nullable** | NULL = shared standard |
| `device_templates` | **nullable** | NULL = shared standard |

## File Structure

**Create:**
- `supabase/migrations/0034_organisations_and_org_id.sql` — the table, the columns, the backfill
- `supabase/migrations/0035_org_id_triggers.sql` — inheritance triggers and the update guard
- `supabase/migrations/0036_app_settings_org_key.sql` — the settings key, needed by Task 3's upsert
- `supabase/migrations/0037_org_id_not_null_and_composite_fks.sql` — the enforcement
- `supabase/migrations/0039_complete_composite_fks.sql` — the composite foreign keys `0037` missed,
  and the `activity_log` fallout of its own `not null`. Added during implementation, not planned:
  review found seven single-column foreign keys still reaching an org-scoped parent after `0037`,
  which is exactly the cross-organisation link this slice exists to make unrepresentable.
- `supabase/migrations/0040_scope_set_null_to_child_column.sql` — scopes `ON DELETE SET NULL` to the
  child column on `floor_devices_room_fk`, so deleting a room nulls `room_id` rather than nulling the
  row's `org_id` along with it. Also added during implementation, as the tail of `0039`'s work.
- `supabase/migrations/0041_org_scoped_unique_constraints.sql` — uniques that were global
- `src/lib/supabase/tenancy.test.ts` — the live schema guard
- `scripts/migrate-storage-to-org-paths.ts` — the one-off object move

**Modify:**
- `src/features/auth/members.ts` — `Member` gains `orgId`
- `src/features/clients/repository.ts:206-217` — `createClient` takes an org
- `src/features/users/repository.ts:88-93` — `insertMember` takes an org
- `src/features/settings/store.ts` — settings reads/writes take an org
- `src/features/clients/planStorage.ts` — path builder for plans
- `src/features/profile/avatarStorage.ts:11-13` — `avatarPathFor` takes an org
- `src/features/clients/actions.ts:564,581` — plan paths gain the org prefix
- `supabase/migrations/README.md` — document the tenancy rule for future migrations

---

### Task 1: The `organisations` table, `org_id` columns, and the backfill

**Files:**
- Create: `supabase/migrations/0034_organisations_and_org_id.sql`

**Interfaces:**
- Produces: table `organisations (id uuid pk, name text not null, created_at timestamptz)`; an `org_id uuid` column on all 19 tables (nullable at this stage); one row named `QTSI`.

- [ ] **Step 1: Write the migration**

```sql
-- Multi-tenancy slice 1, part 1 of 4: give every row an owner.
--
-- Nullable at this stage, deliberately. `not null` arrives in 0036, AFTER 0035's triggers can
-- populate it and after the application supplies it at the three roots. Applying `not null` here
-- would fail on the first table that already has rows — and this database has real data.
create table organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- The 16 tenant tables.
alter table clients             add column org_id uuid references organisations(id);
alter table members             add column org_id uuid references organisations(id);
alter table app_settings        add column org_id uuid references organisations(id);
alter table sites               add column org_id uuid references organisations(id);
alter table floors              add column org_id uuid references organisations(id);
alter table rooms               add column org_id uuid references organisations(id);
alter table racks               add column org_id uuid references organisations(id);
alter table rack_devices        add column org_id uuid references organisations(id);
alter table connections         add column org_id uuid references organisations(id);
alter table port_endpoints      add column org_id uuid references organisations(id);
alter table floor_devices       add column org_id uuid references organisations(id);
alter table floor_plans         add column org_id uuid references organisations(id);
alter table activity_log        add column org_id uuid references organisations(id);
alter table trusted_devices     add column org_id uuid references organisations(id);
alter table phone_verifications add column org_id uuid references organisations(id);
alter table device_challenges   add column org_id uuid references organisations(id);

-- The 3 shared-library tables. These stay nullable FOREVER: NULL means "standard, shared by every
-- organisation", a value means "created by, and private to, that organisation". All existing rows
-- (24 device_types, 4 brands, 6 device_templates) stay NULL and remain shared.
alter table brands           add column org_id uuid references organisations(id);
alter table device_types     add column org_id uuid references organisations(id);
alter table device_templates add column org_id uuid references organisations(id);

-- The first organisation. Everything currently in this database belongs to it.
insert into organisations (name) values ('QTSI');

-- Backfill. Every existing row belongs to the one organisation that exists, so this does not need
-- to walk the hierarchy — it will once there is more than one, which is exactly why 0035's triggers
-- exist for every row written from now on.
do $$
declare
  qtsi uuid;
  t text;
begin
  select id into strict qtsi from organisations where name = 'QTSI';
  foreach t in array array[
    'clients','members','app_settings','sites','floors','rooms','racks','rack_devices',
    'connections','port_endpoints','floor_devices','floor_plans','activity_log',
    'trusted_devices','phone_verifications','device_challenges'
  ] loop
    execute format('update %I set org_id = $1 where org_id is null', t) using qtsi;
  end loop;
end $$;

-- Every tenant query will filter on this column, and slice 2's policies will read it on every row.
create index clients_org_idx             on clients (org_id);
create index members_org_idx             on members (org_id);
create index sites_org_idx               on sites (org_id);
create index floors_org_idx              on floors (org_id);
create index rooms_org_idx               on rooms (org_id);
create index racks_org_idx               on racks (org_id);
create index rack_devices_org_idx        on rack_devices (org_id);
create index connections_org_idx         on connections (org_id);
create index port_endpoints_org_idx      on port_endpoints (org_id);
create index floor_devices_org_idx       on floor_devices (org_id);
create index floor_plans_org_idx         on floor_plans (org_id);
create index activity_log_org_idx        on activity_log (org_id);
create index trusted_devices_org_idx     on trusted_devices (org_id);
create index phone_verifications_org_idx on phone_verifications (org_id);
create index device_challenges_org_idx   on device_challenges (org_id);
create index brands_org_idx              on brands (org_id);
create index device_types_org_idx        on device_types (org_id);
create index device_templates_org_idx    on device_templates (org_id);
```

- [ ] **Step 2: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0034_organisations_and_org_id.sql
```

Expected: `CREATE TABLE`, 19 × `ALTER TABLE`, `INSERT 0 1`, `DO`, 18 × `CREATE INDEX`. No `ERROR`.

- [ ] **Step 3: Verify no tenant row was missed**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "
select t || ' unowned=' || n from (
  select 'clients' t, count(*) n from clients where org_id is null
  union all select 'members', count(*) from members where org_id is null
  union all select 'sites', count(*) from sites where org_id is null
  union all select 'floors', count(*) from floors where org_id is null
  union all select 'rooms', count(*) from rooms where org_id is null
  union all select 'racks', count(*) from racks where org_id is null
  union all select 'rack_devices', count(*) from rack_devices where org_id is null
  union all select 'connections', count(*) from connections where org_id is null
  union all select 'port_endpoints', count(*) from port_endpoints where org_id is null
  union all select 'floor_devices', count(*) from floor_devices where org_id is null
  union all select 'floor_plans', count(*) from floor_plans where org_id is null
  union all select 'activity_log', count(*) from activity_log where org_id is null
  union all select 'trusted_devices', count(*) from trusted_devices where org_id is null
  union all select 'phone_verifications', count(*) from phone_verifications where org_id is null
  union all select 'device_challenges', count(*) from device_challenges where org_id is null
  union all select 'app_settings', count(*) from app_settings where org_id is null
) s where n > 0"
```

Expected: **no output at all.** Any line printed names a table the backfill missed, and `0036` would then fail on it.

- [ ] **Step 4: Verify the library tables were left shared**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "select 'shared brands='||(select count(*) from brands where org_id is null)||' device_types='||(select count(*) from device_types where org_id is null)||' templates='||(select count(*) from device_templates where org_id is null)"
```

Expected: `shared brands=4 device_types=24 templates=6`

- [ ] **Step 5: Confirm the app still works**

```bash
./node_modules/.bin/tsc --noEmit
```

Expected: no output. The columns are additive and nullable, so nothing in `src/` changes yet.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0034_organisations_and_org_id.sql
git commit -m "Add organisations and an org_id on every table"
```

---

### Task 2: Triggers that derive `org_id` from the parent

**Files:**
- Create: `supabase/migrations/0035_org_id_triggers.sql`

**Interfaces:**
- Consumes: the `org_id` columns from Task 1.
- Produces: function `inherit_org_id()` (a generic `before insert` trigger reading `TG_ARGV[0]` as the parent table and `TG_ARGV[1]` as the local FK column) and `freeze_org_id()` (a `before update` guard). Thirteen triggers, one per child table.

- [ ] **Step 1: Write the migration**

```sql
-- Multi-tenancy slice 1, part 2 of 4: children inherit their owner.
--
-- This is what keeps this slice from touching all 141 exported server functions. Only three inserts
-- in the whole application supply org_id (clients, members, app_settings — the three tables with no
-- parent row to read). Every other insert gets it from the row it hangs off, here, in the database,
-- where it cannot be forgotten.
--
-- Generic rather than thirteen near-identical functions: the parent table and the local foreign-key
-- column arrive as trigger arguments. `format(%I)` quotes them as identifiers, so they cannot be
-- injected through — and they are written by this migration, not by a user, in any case.
create or replace function inherit_org_id() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  parent_table constant text := tg_argv[0];
  fk_column    constant text := tg_argv[1];
  fk_value     uuid;
  parent_org   uuid;
begin
  execute format('select ($1).%I', fk_column) into fk_value using new;

  -- A null foreign key means there is no parent to inherit from. Let it through: 0036's `not null`
  -- is what refuses the row, with a clearer message than anything invented here.
  if fk_value is null then
    return new;
  end if;

  execute format('select org_id from %I where id = $1', parent_table)
    into parent_org using fk_value;

  if parent_org is null then
    raise exception 'inherit_org_id: % row references %.% = %, which has no org_id',
      tg_table_name, parent_table, fk_column, fk_value;
  end if;

  -- An explicitly supplied org_id that disagrees with the parent is a bug, not a preference. Refuse
  -- rather than silently overwrite: silently correcting it would hide the caller that got it wrong.
  if new.org_id is not null and new.org_id <> parent_org then
    raise exception 'inherit_org_id: % supplied org_id % but its parent %.% belongs to %',
      tg_table_name, new.org_id, parent_table, fk_column, parent_org;
  end if;

  new.org_id := parent_org;
  return new;
end $$;

revoke all on function inherit_org_id() from public;

-- "Move this rack to another company" is not an operation this product has, and an UPDATE that
-- changed org_id would move a row across the wall while every composite foreign key still pointed
-- at the old owner.
create or replace function freeze_org_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'freeze_org_id: % row % cannot change organisation (% -> %)',
      tg_table_name, old.id, old.org_id, new.org_id;
  end if;
  return new;
end $$;

revoke all on function freeze_org_id() from public;

create trigger sites_inherit_org               before insert on sites               for each row execute function inherit_org_id('clients', 'client_id');
create trigger floors_inherit_org              before insert on floors              for each row execute function inherit_org_id('sites', 'site_id');
create trigger rooms_inherit_org               before insert on rooms               for each row execute function inherit_org_id('floors', 'floor_id');
create trigger racks_inherit_org               before insert on racks               for each row execute function inherit_org_id('rooms', 'room_id');
create trigger rack_devices_inherit_org        before insert on rack_devices        for each row execute function inherit_org_id('racks', 'rack_id');
create trigger connections_inherit_org         before insert on connections         for each row execute function inherit_org_id('racks', 'rack_id');
create trigger port_endpoints_inherit_org      before insert on port_endpoints      for each row execute function inherit_org_id('racks', 'rack_id');
create trigger floor_devices_inherit_org       before insert on floor_devices       for each row execute function inherit_org_id('sites', 'site_id');
create trigger floor_plans_inherit_org         before insert on floor_plans         for each row execute function inherit_org_id('floors', 'floor_id');
create trigger activity_log_inherit_org        before insert on activity_log        for each row execute function inherit_org_id('members', 'member_id');
create trigger trusted_devices_inherit_org     before insert on trusted_devices     for each row execute function inherit_org_id('members', 'member_id');
create trigger phone_verifications_inherit_org before insert on phone_verifications for each row execute function inherit_org_id('members', 'member_id');
-- Two hops from its root: device_challenges -> trusted_devices -> members. It reads the org that
-- trusted_devices already carries, so the chain does not have to be walked here.
create trigger device_challenges_inherit_org   before insert on device_challenges   for each row execute function inherit_org_id('trusted_devices', 'device_id');

create trigger clients_freeze_org             before update on clients             for each row execute function freeze_org_id();
create trigger members_freeze_org             before update on members             for each row execute function freeze_org_id();
create trigger sites_freeze_org               before update on sites               for each row execute function freeze_org_id();
create trigger floors_freeze_org              before update on floors              for each row execute function freeze_org_id();
create trigger rooms_freeze_org               before update on rooms               for each row execute function freeze_org_id();
create trigger racks_freeze_org               before update on racks               for each row execute function freeze_org_id();
create trigger rack_devices_freeze_org        before update on rack_devices        for each row execute function freeze_org_id();
create trigger connections_freeze_org         before update on connections         for each row execute function freeze_org_id();
create trigger port_endpoints_freeze_org      before update on port_endpoints      for each row execute function freeze_org_id();
create trigger floor_devices_freeze_org       before update on floor_devices       for each row execute function freeze_org_id();
create trigger floor_plans_freeze_org         before update on floor_plans         for each row execute function freeze_org_id();
create trigger trusted_devices_freeze_org     before update on trusted_devices     for each row execute function freeze_org_id();
```

**Note on the freeze triggers:** `activity_log`, `phone_verifications`, `device_challenges` and `app_settings` are deliberately absent. The first three are append-or-replace tables whose rows are never edited, and `freeze_org_id` reads `old.id`, which `phone_verifications`, `device_challenges` and `app_settings` do not have (their primary keys are `member_id`, `device_id` and `(org_id, key)`). Adding it there would raise a column-not-found error on every update.

- [ ] **Step 2: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0035_org_id_triggers.sql
```

Expected: 2 × `CREATE FUNCTION`, 2 × `REVOKE`, 25 × `CREATE TRIGGER`.

- [ ] **Step 3: Prove inheritance works, without leaving anything behind**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres <<'SQL'
begin;
insert into clients (code, name, org_id)
  values ('TRIGTEST', 'Trigger Test', (select id from organisations where name='QTSI'));
insert into sites (code, name, client_id)
  values ('S1', 'Site One', (select id from clients where code='TRIGTEST'));
select 'site inherited org = ' || (org_id = (select id from organisations where name='QTSI'))::text
  from sites where code='S1';
insert into floors (code, name, site_id)
  values ('F1', 'Floor One', (select id from sites where code='S1'));
select 'floor inherited org = ' || (org_id = (select id from organisations where name='QTSI'))::text
  from floors where code='F1';
rollback;
SQL
```

Expected: `site inherited org = true` and `floor inherited org = true`. The `rollback` is what keeps the real data clean — do not replace it with `commit`.

- [ ] **Step 4: Prove a mismatched org is refused**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres <<'SQL'
begin;
insert into organisations (name) values ('Decoy');
insert into clients (code, name, org_id)
  values ('TRIGTEST2', 'Trigger Test 2', (select id from organisations where name='QTSI'));
-- Deliberately lying about the owner:
insert into sites (code, name, client_id, org_id)
  values ('S2', 'Site Two', (select id from clients where code='TRIGTEST2'),
          (select id from organisations where name='Decoy'));
rollback;
SQL
```

Expected: `ERROR: inherit_org_id: sites supplied org_id … but its parent clients.client_id belongs to …`, then `ROLLBACK`.

- [ ] **Step 5: Confirm the existing suite still passes**

```bash
./node_modules/.bin/vitest run src/features/clients/repository.test.ts src/features/auth/withMember.test.ts
```

Expected: all pass. (If either file does not exist under that exact name, run `ls src/features/clients/*.test.ts src/features/auth/*.test.ts` and run the named files you find — never a directory.)

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0035_org_id_triggers.sql
git commit -m "Derive org_id from the parent row on insert"
```

---

### Task 3: The application supplies `org_id` at the three roots

**Files:**
- Modify: `src/features/auth/members.ts` (the `Member` interface and the select at line 61)
- Modify: `src/features/clients/repository.ts:206-217`
- Modify: `src/features/users/repository.ts:88-93`
- Modify: `src/features/settings/store.ts`

**Interfaces:**
- Consumes: `org_id` columns (Task 1).
- Produces: `Member.orgId: string` — available to every action through the existing `withMember` / `withEditor` / `withAdmin` wrappers, which already receive the `Member`. No wrapper signature changes.
- Produces: `createClient(db, input: { code: string; name: string; orgId: string })`, `insertMember(db, email, name, role, orgId)`, and settings functions taking an `orgId`.

- [ ] **Step 1: Add `orgId` to the `Member` type**

In `src/features/auth/members.ts`, add to the `Member` interface after `role: Role;`:

```ts
  /** The organisation this member belongs to. Every action reaches it through the Member that
   *  withMember already hands them, which is why adding tenancy here changes no wrapper signature
   *  and no call site. */
  orgId: string;
```

- [ ] **Step 2: Select the column**

In the same file, change the select at line 61 from:

```ts
    .select("id, email, name, auth_user_id, disabled_at, avatar_path, role")
```

to:

```ts
    .select("id, email, name, auth_user_id, disabled_at, avatar_path, role, org_id")
```

and add `orgId: row.org_id` to wherever that row is mapped into a `Member`. Run `./node_modules/.bin/tsc --noEmit` to find the mapping site if it is not obvious — it will error on the missing property.

- [ ] **Step 3: `createClient` takes an organisation**

In `src/features/clients/repository.ts`, replace lines 206-217 with:

```ts
export async function createClient(
  db: SupabaseClient,
  input: { code: string; name: string; orgId: string }
): Promise<ClientRow> {
  const { data, error } = await db
    .from("clients")
    .insert({ code: normaliseCode(input.code), name: input.name, org_id: input.orgId })
    .select("*")
    .single();
  if (error) throw new Error(`createClient: ${error.message}`);
  return data as ClientRow;
}
```

- [ ] **Step 4: `insertMember` takes an organisation**

In `src/features/users/repository.ts`, replace lines 88-93 with:

```ts
export async function insertMember(
  db: SupabaseClient, email: string, name: string, role: Role, orgId: string
): Promise<void> {
  const { error } = await db.from("members").insert({ email, name, role, org_id: orgId });
  if (error) throw new Error(`insertMember: ${error.message}`);
}
```

- [ ] **Step 5: Settings become per-organisation**

`app_settings` is the third root — it hangs off no parent, so no trigger can fill it in. In `src/features/settings/store.ts`, thread an `orgId` through all three functions, changing the queries to:

```ts
    const { data, error } = await db
      .from("app_settings").select("value").eq("org_id", orgId).eq("key", key).maybeSingle();
```

```ts
    const { error } = await db.from("app_settings")
      .upsert({ org_id: orgId, key, value, updated_at: new Date().toISOString() },
              { onConflict: "org_id,key" });
```

```ts
    const { error } = await db.from("app_settings")
      .delete().eq("org_id", orgId).eq("key", key);
```

The `onConflict` is load-bearing: after Task 5 the primary key is `(org_id, key)`, and an upsert that still conflicts on `key` alone would fail once a second organisation stores the same setting.

- [ ] **Step 6: Give the installer an organisation to create**

`deploy/install.sh` Step 5 inserts the first admin directly with
`insert into members (email, name, role, auth_user_id)`. Once Task 4 makes `members.org_id` not
null, a fresh install fails there — and `members` has no parent for a trigger to read. The installer
must create the organisation first.

Change that insert to create the organisation and use it, and prompt for the name alongside the
admin's details (Step 2 of the script already prompts for hostname, email and name):

```sql
with org as (
  insert into organisations (name) values (:'orgname')
  returning id
)
insert into members (email, name, role, auth_user_id, org_id)
values (:'email', :'name', 'admin', :'authid'::uuid, (select id from org))
on conflict (email) do update set auth_user_id = excluded.auth_user_id
returning id;
```

**Keep the existing `on conflict (email) do update … returning` — do NOT change it to `do nothing`.**
An earlier draft of this plan said `do nothing`; that is wrong, and review proved it twice over. The
comment block above that statement documents the relink as a fix for a real bug (a `members` row
surviving a GoTrue user recreation and left pointing at a dead `auth_user_id`), naming `do nothing`
as the cause. And the script's next line refuses to continue on an empty `RETURNING` — under
`do nothing` a conflicting re-run returns no rows, so the installer would die on the exact
safe-to-re-run path its own header advertises. The outer `do update` never touches `org_id`, so a
re-run cannot reassign an existing member's organisation.

Look the organisation up by name BEFORE inserting, rather than relying on `on conflict do nothing` —
`organisations` has no unique constraint on `name`, so that clause never fires and every re-run would
leave an orphan organisation behind. Add an `ORG_NAME` prompt next to the admin name, defaulting to
the admin's email domain if left blank.

- [ ] **Step 7: Fix every caller the compiler names**

```bash
./node_modules/.bin/tsc --noEmit
```

Each error is a call site that must now pass `member.orgId` — the `Member` is already in scope in every one, because they all sit inside a `withMember` / `withEditor` / `withAdmin` wrapper. Fix them until this command prints nothing.

- [ ] **Step 8: Run the affected tests**

```bash
./node_modules/.bin/vitest run src/features/clients/repository.test.ts src/features/users/repository.test.ts src/features/settings/store.test.ts
```

Expected: pass. Test fakes constructing a `Member` will need `orgId` added; use `"00000000-0000-0000-0000-000000000001"` where a literal is needed. (Run `ls src/features/settings/*.test.ts` first; if a file does not exist, skip it rather than substituting a directory.)

- [ ] **Step 9: Syntax-check the installer and commit**

```bash
bash -n deploy/install.sh && shellcheck deploy/install.sh
git add src/features/auth/members.ts src/features/clients/repository.ts src/features/users/repository.ts src/features/settings/store.ts deploy/install.sh
git commit -m "Carry the organisation on Member and supply it at the three roots"
```

---

### Task 4: `not null`, and composite foreign keys

**Files:**
- Create: `supabase/migrations/0037_org_id_not_null_and_composite_fks.sql`

**Interfaces:**
- Consumes: populated `org_id` everywhere (Task 1), triggers (Task 2), application writes (Task 3).
- Produces: `unique (org_id, id)` on every org-scoped parent, composite FKs on every org-scoped child, `not null` on the 15 tenant tables. (16 tables gained the column in `0034`; `activity_log` stays nullable — a refused sign-in from an unknown address has no member and so no organisation.)

- [ ] **Step 1: Write the migration**

```sql
-- Multi-tenancy slice 1, part 3 of 4: make a cross-organisation row impossible.
--
-- The trigger in 0035 supplies the right org_id. This makes a wrong one unrepresentable: every
-- relationship between two org-scoped tables carries org_id through the foreign key itself, so
-- attaching one company's site to another company's client is refused by Postgres regardless of
-- what any query says. That is the difference between isolation you can audit and isolation you
-- have to trust.
alter table clients         add constraint clients_org_id_unique         unique (org_id, id);
alter table sites           add constraint sites_org_id_unique           unique (org_id, id);
alter table floors          add constraint floors_org_id_unique          unique (org_id, id);
alter table rooms           add constraint rooms_org_id_unique           unique (org_id, id);
alter table racks           add constraint racks_org_id_unique           unique (org_id, id);
alter table rack_devices    add constraint rack_devices_org_id_unique    unique (org_id, id);
alter table members         add constraint members_org_id_unique         unique (org_id, id);
alter table trusted_devices add constraint trusted_devices_org_id_unique unique (org_id, id);

-- `not null` FIRST: a composite foreign key with a nullable column is satisfied by a null, which
-- would leave exactly the hole this migration exists to close.
alter table clients             alter column org_id set not null;
alter table members             alter column org_id set not null;
alter table app_settings        alter column org_id set not null;
alter table sites               alter column org_id set not null;
alter table floors              alter column org_id set not null;
alter table rooms               alter column org_id set not null;
alter table racks               alter column org_id set not null;
alter table rack_devices        alter column org_id set not null;
alter table connections         alter column org_id set not null;
alter table port_endpoints      alter column org_id set not null;
alter table floor_devices       alter column org_id set not null;
alter table floor_plans         alter column org_id set not null;
-- activity_log is DELIBERATELY ABSENT from this list. `member_id` is nullable and
-- src/features/activity/authLog.ts passes `memberId ?? null`, because a REFUSED SIGN-IN FROM AN
-- UNKNOWN ADDRESS has no member — and therefore no organisation. Making this not null would make
-- that insert fail and silently destroy the sign-in-refusal audit trail, which is one of the
-- reasons the activity log exists. NULL here means "a platform-level event belonging to no
-- organisation", and slice 2's policies leave those rows invisible to every tenant, which is
-- correct: they are the platform operator's business, not a customer's.
alter table trusted_devices     alter column org_id set not null;
alter table phone_verifications alter column org_id set not null;
alter table device_challenges   alter column org_id set not null;

-- Replace each single-column foreign key with its composite form. `on delete cascade` is preserved
-- where it already existed; check each with \d before dropping, and keep what was there.
alter table sites drop constraint sites_client_id_fkey;
alter table sites add constraint sites_client_fk
  foreign key (org_id, client_id) references clients (org_id, id) on delete cascade;

alter table floors drop constraint floors_site_id_fkey;
alter table floors add constraint floors_site_fk
  foreign key (org_id, site_id) references sites (org_id, id) on delete cascade;

alter table rooms drop constraint rooms_floor_id_fkey;
alter table rooms add constraint rooms_floor_fk
  foreign key (org_id, floor_id) references floors (org_id, id) on delete cascade;

alter table racks drop constraint racks_room_id_fkey;
alter table racks add constraint racks_room_fk
  foreign key (org_id, room_id) references rooms (org_id, id) on delete cascade;

alter table rack_devices drop constraint rack_devices_rack_id_fkey;
alter table rack_devices add constraint rack_devices_rack_fk
  foreign key (org_id, rack_id) references racks (org_id, id) on delete cascade;

alter table connections drop constraint connections_rack_id_fkey;
alter table connections add constraint connections_rack_fk
  foreign key (org_id, rack_id) references racks (org_id, id) on delete cascade;

alter table port_endpoints drop constraint port_endpoints_rack_id_fkey;
alter table port_endpoints add constraint port_endpoints_rack_fk
  foreign key (org_id, rack_id) references racks (org_id, id) on delete cascade;

alter table floor_devices drop constraint floor_devices_site_id_fkey;
alter table floor_devices add constraint floor_devices_site_fk
  foreign key (org_id, site_id) references sites (org_id, id) on delete cascade;

alter table floor_plans drop constraint floor_plans_floor_id_fkey;
alter table floor_plans add constraint floor_plans_floor_fk
  foreign key (org_id, floor_id) references floors (org_id, id) on delete cascade;

alter table activity_log drop constraint activity_log_member_id_fkey;
alter table activity_log add constraint activity_log_member_fk
  foreign key (org_id, member_id) references members (org_id, id);

alter table trusted_devices drop constraint trusted_devices_member_id_fkey;
alter table trusted_devices add constraint trusted_devices_member_fk
  foreign key (org_id, member_id) references members (org_id, id) on delete cascade;

alter table phone_verifications drop constraint phone_verifications_member_id_fkey;
alter table phone_verifications add constraint phone_verifications_member_fk
  foreign key (org_id, member_id) references members (org_id, id) on delete cascade;

alter table device_challenges drop constraint device_challenges_device_id_fkey;
alter table device_challenges add constraint device_challenges_device_fk
  foreign key (org_id, device_id) references trusted_devices (org_id, id) on delete cascade;

-- DELIBERATELY NOT CONVERTED: references into the shared library — rack_devices.device_template_id,
-- port_endpoints.device_type_id, floor_devices.device_type_id, device_templates.brand_id and
-- device_templates.device_type_id. Those parents carry a NULLABLE org_id (NULL = shared), and a
-- composite foreign key cannot express "either the shared row or my own". Today every library row is
-- shared, so nothing can point across a wall. SLICE 4, which lets an organisation create its own
-- device types, must close this: at that point a rack_device could reference another organisation's
-- private template. It is recorded here rather than left to be rediscovered.
```

- [ ] **Step 2: Check the real constraint names and cascade behaviour before applying**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "
select conrelid::regclass::text || '  ' || conname || '  ' || pg_get_constraintdef(oid)
from pg_constraint where contype = 'f' and connamespace = 'public'::regnamespace order by 1"
```

Compare against the `drop constraint` names above. If any differs, correct the migration to the real name — and preserve each constraint's existing `ON DELETE` clause, which this listing shows.

- [ ] **Step 3: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0037_org_id_not_null_and_composite_fks.sql
```

Expected: a long run of `ALTER TABLE` with no `ERROR`.

- [ ] **Step 4: Prove a cross-organisation attachment is refused**

The trigger cannot be used to demonstrate this — it stamps the child with the parent's org, so an
insert always agrees with itself. The composite key has to be tested where the trigger is *not* in
the path, which is an UPDATE:

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres <<'SQL'
begin;
insert into organisations (name) values ('Rival MSP');
insert into clients (code, name, org_id)
  values ('RIVAL', 'Rival Client', (select id from organisations where name='Rival MSP'));
-- Bypass the trigger by updating an existing QTSI site to point at Rival's client:
update sites set client_id = (select id from clients where code='RIVAL')
  where id = (select id from sites limit 1);
rollback;
SQL
```

Expected: `ERROR: insert or update on table "sites" violates foreign key constraint "sites_client_fk"`. This is the assertion that matters — it proves the wall holds even when the trigger is not in the path.

- [ ] **Step 5: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add supabase/migrations/0037_org_id_not_null_and_composite_fks.sql
git commit -m "Make a cross-organisation row impossible in the database"
```

---

### Task 5: Unique constraints that were global

**Files:**
- Create: `supabase/migrations/0041_org_scoped_unique_constraints.sql`
- Modify: `supabase/migrations/README.md`

**Interfaces:**
- Consumes: `org_id not null` (Task 4).
- Produces: org-scoped uniqueness on `clients.code`, `brands.name`, `device_templates.name`, `device_types.code`, `device_types (category, name)`, and `app_settings`' primary key.

- [ ] **Step 1: Write the migration**

```sql
-- Multi-tenancy slice 1, part 4 of 4: uniqueness that was global becomes per-organisation.
--
-- Two IT firms both having a client coded ACME is ordinary, not a conflict. Each of these would
-- otherwise reject the second organisation's perfectly reasonable data.
alter table clients drop constraint clients_code_key;
alter table clients add constraint clients_org_code_key unique (org_id, code);

-- `nulls not distinct` is load-bearing, not tidiness. On these three tables NULL org_id means
-- "shared standard", so without it Postgres treats every shared row as distinct and two shared
-- brands both named Cisco would BOTH be accepted — the constraint would silently stop constraining
-- exactly the rows it exists to protect. Requires Postgres 15+; this runs 17.6.
alter table brands drop constraint brands_name_key;
alter table brands add constraint brands_org_name_key unique nulls not distinct (org_id, name);

alter table device_templates drop constraint device_templates_name_key;
alter table device_templates add constraint device_templates_org_name_key
  unique nulls not distinct (org_id, name);

alter table device_types drop constraint device_types_code_key;
alter table device_types add constraint device_types_org_code_key
  unique nulls not distinct (org_id, code);

alter table device_types drop constraint device_types_category_name_key;
alter table device_types add constraint device_types_org_category_name_key
  unique nulls not distinct (org_id, category, name);

-- app_settings' primary key is NOT here — it moved to Task 3, migration 0036. Task 3's settings
-- upsert names `onConflict: "org_id,key"`, and Postgres rejects an ON CONFLICT target with no
-- matching unique index (42P10), so leaving the key change until now meant every settings save
-- failed for the two tasks in between. Found in review.

-- UNCHANGED, DELIBERATELY:
--   members.email stays globally unique. auth.users permits one account per address and members
--   links to it one-to-one, so a per-org email would allow two member rows where only one could
--   ever sign in. One person, one organisation — see the spec.
--   trusted_devices.token_hash stays globally unique. It is a secret; a collision across
--   organisations would be a real collision, not a naming coincidence.
--   The nine constraints already scoped by an org-scoped parent — sites(client_id, code),
--   floors(site_id, code), rooms(floor_id, code), racks(room_id, code),
--   rack_devices(rack_id, code), floor_devices(site_id, code), floor_plans(floor_id),
--   port_endpoints(rack_device_id, ...) and connections(rack_id, ...) — need no change.
```

- [ ] **Step 2: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0041_org_scoped_unique_constraints.sql
```

Expected: `ALTER TABLE` throughout, no `ERROR`. If a `drop constraint` fails on a name, list the real names with the query in Task 4 Step 2 and correct it.

- [ ] **Step 3: Prove two organisations can share a client code**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres <<'SQL'
begin;
insert into organisations (name) values ('Second MSP');
insert into clients (code, name, org_id)
  values ('SHARED', 'QTSI version', (select id from organisations where name='QTSI'));
insert into clients (code, name, org_id)
  values ('SHARED', 'Second version', (select id from organisations where name='Second MSP'));
select 'both accepted: ' || count(*)::text from clients where code = 'SHARED';
rollback;
SQL
```

Expected: `both accepted: 2`. This is the single sentence that says the slice worked.

- [ ] **Step 4: Prove `nulls not distinct` actually bites**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres <<'SQL'
begin;
insert into brands (name) values ('Cisco');
rollback;
SQL
```

Expected: `ERROR: duplicate key value violates unique constraint "brands_org_name_key"` — because a shared `Cisco` already exists with a NULL org. Without `nulls not distinct` this would have been accepted.

- [ ] **Step 5: Document the rule for future migrations**

Append a section to `supabase/migrations/README.md` stating: every new table gets `org_id uuid not null references organisations(id)`, a `unique (org_id, id)`, an inheritance trigger if it has an org-scoped parent, and composite foreign keys rather than single-column ones; every new unique constraint that is not already scoped by an org-scoped parent must include `org_id`; and `src/lib/supabase/tenancy.test.ts` fails if any of this is skipped.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0041_org_scoped_unique_constraints.sql supabase/migrations/README.md
git commit -m "Scope the global unique constraints to the organisation"
```

---

### Task 6: The schema guard

**Files:**
- Create: `src/lib/supabase/tenancy.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 4 and 5.
- Produces: a read-only live-database test in the same style as `src/lib/supabase/grants.test.ts`, honouring the same `GRANTS_TEST_CONTAINER` override so it can be pointed at a deployed stack.

This is what makes the slice durable. Without it, table 20 arrives with no `org_id` and nobody finds out until slice 2's policies have a hole.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** Every row has an owner — asserted against the live catalogue, not against a convention nobody
 *  reads. Read-only: it queries catalogue views and creates nothing. Deliberately NOT named
 *  *.integration.test.ts, because those wipe the database and are excluded from every run.
 *
 *  Same container override as grants.test.ts, so the same guard can be pointed at a deployed stack
 *  after its first migration run. */
const CONTAINER = process.env.GRANTS_TEST_CONTAINER || "supabase_db_network-doc-platform";

function sql(query: string): string[] {
  const out = execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query],
    { encoding: "utf8" }
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Tables where a NULL org_id is legitimate, and why — sorted, because the assertion compares
 *  against a sorted list.
 *
 *  The three library tables: NULL means "standard, shared by every organisation".
 *
 *  activity_log: NULL means "a platform-level event belonging to no organisation". A refused
 *  sign-in from an address that belongs to nobody has no member and therefore no org, and
 *  authLog.ts records exactly that. Forcing not null there would make the insert fail and take the
 *  sign-in-refusal audit trail with it. */
const NULLABLE_ORG_TABLES = ["activity_log", "brands", "device_templates", "device_types"];

describe("every row has an owning organisation", () => {
  it("gives every table in public an org_id", () => {
    const missing = sql(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname <> 'organisations'
        and not exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped
        )
      order by 1
    `);
    // A name here is a table added without deciding who owns its rows. Decide, then add the column.
    expect(missing).toEqual([]);
  });

  it("makes org_id not null everywhere a null would be meaningless", () => {
    const nullable = sql(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id'
      where n.nspname = 'public' and c.relkind = 'r' and not a.attnotnull
      order by 1
    `);
    // Exact equality both ways: a new nullable table fails here, and so does one of these four
    // quietly being tightened, which would break the sign-in-refusal log or the shared library.
    expect(nullable).toEqual(NULLABLE_ORG_TABLES);
  });

  it("carries org_id through every foreign key between two org-scoped tables", () => {
    // A single-column foreign key to an org-scoped parent is the hole: it permits a child of one
    // organisation to point at a parent of another. Library parents are exempt — their org_id is
    // nullable, so a composite key cannot express "the shared row or my own" (see 0036).
    const singleColumn = sql(`
      select conrelid::regclass::text || '.' || conname
      from pg_constraint fk
      join pg_class child on child.oid = fk.conrelid
      join pg_class parent on parent.oid = fk.confrelid
      join pg_namespace n on n.oid = child.relnamespace
      where fk.contype = 'f' and n.nspname = 'public'
        and array_length(fk.conkey, 1) = 1
        and parent.relname <> 'organisations'
        and parent.relname not in ('brands','device_types','device_templates')
      order by 1
    `);
    expect(singleColumn).toEqual([]);
  });

  it("scopes to the organisation every unique constraint that is not already scoped by a parent", () => {
    const rows = sql(`
      select conrelid::regclass::text || ' ' || conname
      from pg_constraint
      where contype in ('u','p') and connamespace = 'public'::regnamespace
        and conrelid::regclass::text in
            ('clients','brands','device_templates','device_types','app_settings')
        and not exists (
          select 1 from unnest(conkey) k
          join pg_attribute a on a.attrelid = conrelid and a.attnum = k
          where a.attname = 'org_id'
        )
      order by 1
    `);
    // Primary keys on `id` alone are fine — a uuid is globally unique by construction. Anything
    // else listed here is a constraint that would reject a second organisation's ordinary data.
    expect(rows).toEqual([
      "brands brands_pkey",
      "clients clients_pkey",
      "device_templates device_templates_pkey",
      "device_types device_types_pkey",
    ]);
  });

  it("keeps the shared library's uniqueness nulls-not-distinct", () => {
    // Without this, two shared rows with a NULL org are both accepted and the constraint silently
    // stops constraining the rows it exists to protect.
    const distinct = sql(`
      select conrelid::regclass::text || '.' || conname
      from pg_constraint
      where contype = 'u' and connamespace = 'public'::regnamespace
        and conrelid::regclass::text in ('brands','device_types','device_templates')
        and pg_get_constraintdef(oid) not like '%NULLS NOT DISTINCT%'
      order by 1
    `);
    expect(distinct).toEqual([]);
  });

  it("keeps the two deliberate global uniques global", () => {
    // Pinned so they are decisions rather than oversights. members.email: auth.users permits one
    // account per address. trusted_devices.token_hash: it is a secret, so a cross-org collision
    // would be a real one.
    const rows = sql(`
      select conname from pg_constraint
      where connamespace = 'public'::regnamespace and contype = 'u'
        and conname in ('members_email_key','trusted_devices_token_hash_key')
      order by 1
    `);
    expect(rows).toEqual(["members_email_key", "trusted_devices_token_hash_key"]);
  });
});
```

- [ ] **Step 2: Run it**

```bash
./node_modules/.bin/vitest run src/lib/supabase/tenancy.test.ts
```

Expected: 6 passed. If assertion 4's expected list differs, print the actual list and check each entry is genuinely a primary key on `id` alone before widening the expectation — a constraint that slipped in is exactly what this catches.

- [ ] **Step 3: Prove the guard actually guards**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "alter table clients drop constraint clients_org_code_key;"
./node_modules/.bin/vitest run src/lib/supabase/tenancy.test.ts
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "alter table clients add constraint clients_org_code_key unique (org_id, code);"
./node_modules/.bin/vitest run src/lib/supabase/tenancy.test.ts
```

Expected: fails in the middle, passes again at the end. A guard nobody has watched fail is not known to work.

- [ ] **Step 4: Confirm the grants guard is still green**

```bash
./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts
```

Expected: 6 passed. This slice adds no grants; if it dropped to 5 something in a migration carried a tail.

- [ ] **Step 5: Commit**

```bash
git add src/lib/supabase/tenancy.test.ts
git commit -m "Assert every row has an owner, and that it cannot cross the wall"
```

---

### Task 7: Storage becomes org-namespaced

**Files:**
- Modify: `src/features/profile/avatarStorage.ts:11-13`
- Modify: `src/features/clients/planStorage.ts` (add a path builder)
- Modify: `src/features/clients/actions.ts:564,581`
- Create: `scripts/migrate-storage-to-org-paths.ts`

**Interfaces:**
- Consumes: `Member.orgId` (Task 3), `floor_plans.org_id` (Task 1).
- Produces: `avatarPathFor(orgId: string, memberId: string): string` → `` `${orgId}/${memberId}/avatar` ``; `planPathFor(orgId: string, siteId: string, floorId: string, ext: "png" | "pdf"): string` → `` `${orgId}/${siteId}/${floorId}.${ext}` ``.

**This is the only step a migration revert cannot undo.** Objects moved in storage stay moved.

- [ ] **Step 1: Take a backup first**

```bash
bash deploy/backup.sh
```

Expected: `Backup complete: …/deploy/backups/<timestamp>`. Do not continue without it.

- [ ] **Step 2: Add the path builders**

In `src/features/profile/avatarStorage.ts`, replace lines 11-13 with:

```ts
/** One object per member, overwritten on replace, so pictures never accumulate. Prefixed with the
 *  organisation because slice 2's storage policies key on the first path segment — without it there
 *  is no way to express "this organisation's files". */
export function avatarPathFor(orgId: string, memberId: string): string {
  return `${orgId}/${memberId}/avatar`;
}
```

In `src/features/clients/planStorage.ts`, add:

```ts
/** The stored object for a floor's plan. Organisation first, for the same reason as avatarPathFor:
 *  slice 2's storage policies match on the leading path segment. */
export function planPathFor(
  orgId: string, siteId: string, floorId: string, ext: "png" | "pdf"
): string {
  return `${orgId}/${siteId}/${floorId}.${ext}`;
}
```

- [ ] **Step 3: Use them**

In `src/features/clients/actions.ts`, replace line 564:

```ts
  const path = planPathFor(member.orgId, siteId, floorId, "png");
```

and line 581:

```ts
        const pdfPath = planPathFor(member.orgId, siteId, floorId, "pdf");
```

Add `planPathFor` to the existing import from `./planStorage`. Then fix every caller the compiler names:

```bash
./node_modules/.bin/tsc --noEmit
```

- [ ] **Step 4: Write the one-off move script**

```ts
/** Moves every stored object under its organisation's prefix, and updates the rows that point at
 *  them. Run once, after the migrations. Re-runnable: an object already at its new path is skipped.
 *
 *  Verify-then-delete, never the reverse — `move` is atomic in the Storage API, but the database
 *  update that follows is not part of it, so the row is updated only after the move returns
 *  successfully, and a failure leaves the object findable at one path or the other.
 *
 *  Usage: npx tsx scripts/migrate-storage-to-org-paths.ts [--dry-run]
 */
import { createClient } from "@supabase/supabase-js";

const DRY_RUN = process.argv.includes("--dry-run");

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
const db = createClient(url, key);

async function movePlans(): Promise<void> {
  const { data, error } = await db
    .from("floor_plans")
    .select("id, org_id, floor_id, storage_path, pdf_storage_path, floors(site_id)");
  if (error) throw new Error(`movePlans: ${error.message}`);

  for (const row of data ?? []) {
    const siteId = (row as { floors: { site_id: string } | null }).floors?.site_id;
    if (!siteId) {
      console.warn(`floor_plan ${row.id}: no site, skipped`);
      continue;
    }
    for (const [column, ext] of [["storage_path", "png"], ["pdf_storage_path", "pdf"]] as const) {
      const from = (row as Record<string, string | null>)[column];
      if (!from) continue;
      // Must match planPathFor(orgId, siteId, floorId, ext) exactly — the app reads storage_path
      // from the row, so a path this script invents that the app would never build produces a
      // missing plan rather than an error.
      const to = `${row.org_id}/${siteId}/${row.floor_id}.${ext}`;
      if (from === to) continue;
      console.log(`${DRY_RUN ? "[dry-run] " : ""}floor-plans: ${from} -> ${to}`);
      if (DRY_RUN) continue;
      const { error: moveErr } = await db.storage.from("floor-plans").move(from, to);
      if (moveErr) throw new Error(`move ${from}: ${moveErr.message}`);
      const { error: updErr } = await db.from("floor_plans").update({ [column]: to }).eq("id", row.id);
      if (updErr) throw new Error(`update floor_plans.${column} for ${row.id}: ${updErr.message}`);
    }
  }
}

async function moveAvatars(): Promise<void> {
  const { data, error } = await db.from("members").select("id, org_id, avatar_path");
  if (error) throw new Error(`moveAvatars: ${error.message}`);

  for (const row of data ?? []) {
    const from = row.avatar_path as string | null;
    if (!from) continue;
    const to = `${row.org_id}/${row.id}/avatar`;
    if (from === to) continue;
    console.log(`${DRY_RUN ? "[dry-run] " : ""}avatars: ${from} -> ${to}`);
    if (DRY_RUN) continue;
    const { error: moveErr } = await db.storage.from("avatars").move(from, to);
    if (moveErr) throw new Error(`move ${from}: ${moveErr.message}`);
    const { error: updErr } = await db.from("members").update({ avatar_path: to }).eq("id", row.id);
    if (updErr) throw new Error(`update members.avatar_path for ${row.id}: ${updErr.message}`);
  }
}

await movePlans();
await moveAvatars();
console.log(DRY_RUN ? "dry run complete — nothing was moved" : "storage migration complete");
```

**Before running it, confirm the source paths are what this expects:**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "select storage_path || '  |  ' || coalesce(pdf_storage_path,'(no pdf)') from floor_plans"
```

Expected: paths of the form `<siteId>/<floorId>.png`. If any row already carries an organisation
prefix the script skips it (`from === to`), which is what makes a second run safe.

- [ ] **Step 5: Dry run**

```bash
set -a && . .env.local && set +a && npx tsx scripts/migrate-storage-to-org-paths.ts --dry-run
```

Expected: one `[dry-run] … -> …` line per stored object, and no errors. Confirm each destination starts with the QTSI organisation's uuid.

- [ ] **Step 6: Run it for real, then confirm the app still renders plans**

```bash
set -a && . .env.local && set +a && npx tsx scripts/migrate-storage-to-org-paths.ts
```

Then start the dev server and open a site that has a floor plan. Expected: the plan renders. The app reads `storage_path` from the row, so a mismatch shows as a missing plan rather than an error — this must be checked visually, not inferred.

- [ ] **Step 7: Run the affected tests, typecheck, commit**

```bash
./node_modules/.bin/vitest run src/features/clients/planStorage.test.ts src/features/profile/avatarStorage.test.ts
./node_modules/.bin/tsc --noEmit
```

(Run `ls src/features/clients/*.test.ts src/features/profile/*.test.ts` first and run the named files that exist; never pass a directory.)

```bash
git add src/features/profile/avatarStorage.ts src/features/clients/planStorage.ts src/features/clients/actions.ts scripts/migrate-storage-to-org-paths.ts
git commit -m "Namespace stored objects by organisation"
```

---

## Final verification, before the branch is finished

- [ ] `./node_modules/.bin/tsc --noEmit` — clean
- [ ] `./node_modules/.bin/vitest run src/lib/supabase/tenancy.test.ts src/lib/supabase/grants.test.ts` — 9 + 6 passed (the tenancy guard grew past the 6 planned here: five assertions were added when review found ways it could stay green while the schema was broken, and a sixth for the `inherit_org_id` triggers, which it had never asserted at all)
- [ ] Replay all migrations from empty on a throwaway stack, proving they work on a fresh install and not only as increments against this developer's database:

```bash
bash deploy/install.sh   # hostname ndp.localhost, admin admin@ndp.test, name Throwaway Admin
GRANTS_TEST_CONTAINER=$(docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps -q db) \
  ./node_modules/.bin/vitest run src/lib/supabase/tenancy.test.ts
docker compose -f deploy/docker-compose.yml --env-file deploy/.env down -v
```

Note that `install.sh` creates the first admin member directly, and `members.org_id` is now `not null` — so **the installer must also create an organisation and assign it**, or a fresh install fails at that step. If it does, that is a real gap in this plan; fix it in `deploy/install.sh` as part of Task 3 and note it in the report.

- [ ] The app runs and behaves identically: clients list, a site with a floor plan, the activity log, and a profile with an avatar all render as before.
