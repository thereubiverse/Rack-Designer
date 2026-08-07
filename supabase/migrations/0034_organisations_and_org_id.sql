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
