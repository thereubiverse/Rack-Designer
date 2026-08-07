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

-- The first organisation, and the backfill that gives it every row already here.
--
-- Conditional on there BEING rows already here, which is the whole point. On a fresh install this
-- migration runs against an empty schema: the backfill below would attach nothing, and the 'QTSI'
-- row would be pure vestige — a second, empty organisation sitting next to the one
-- `deploy/install.sh` creates from the operator's own answer, named after a company that has
-- nothing to do with their deployment. Two organisations on every fresh install, one of which the
-- product is not yet safe to have (see README.md, "One organisation, until slice 2").
--
-- Amending this file after it has been applied is safe: the installer records applied migrations by
-- filename in `installer.schema_migrations`, so it does not re-run, and on the database this was
-- first written for the outcome is identical — the row exists already, with data attached.
--
-- Every existing row belongs to the one organisation that exists, so the backfill does not need to
-- walk the hierarchy — it will once there is more than one, which is exactly why 0035's triggers
-- exist for every row written from now on.
do $$
declare
  tenant_tables constant text[] := array[
    'clients','members','app_settings','sites','floors','rooms','racks','rack_devices',
    'connections','port_endpoints','floor_devices','floor_plans','activity_log',
    'trusted_devices','phone_verifications','device_challenges'
  ];
  qtsi uuid;
  t text;
  occupied boolean := false;
begin
  foreach t in array tenant_tables loop
    execute format('select exists (select 1 from %I)', t) into occupied;
    exit when occupied;
  end loop;

  if not occupied then
    raise notice 'no existing rows to attach — skipping the QTSI organisation; install.sh creates the first one';
    return;
  end if;

  -- Looked up before inserting, so re-applying this file by hand converges rather than minting a
  -- second QTSI. `organisations` deliberately has no unique constraint on `name` (two real companies
  -- may share one), so `on conflict` is not available here.
  select id into qtsi from organisations where name = 'QTSI' order by created_at limit 1;
  if qtsi is null then
    insert into organisations (name) values ('QTSI') returning id into qtsi;
  end if;

  foreach t in array tenant_tables loop
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
