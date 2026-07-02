-- Organizations (single default now; tenant-ready)
create table organizations (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

create table sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  code text not null,
  name text not null,
  address text,
  created_at timestamptz not null default now(),
  unique (organization_id, code)
);

create table floors (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  code text not null,
  name text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (site_id, code)
);

create table rooms (
  id uuid primary key default gen_random_uuid(),
  floor_id uuid not null references floors(id) on delete cascade,
  code text not null,
  name text,
  type text not null default 'other' check (type in ('MDF', 'IDF', 'other')),
  created_at timestamptz not null default now(),
  unique (floor_id, code)
);

create table racks (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  code text not null,
  name text,
  height_u int not null check (height_u > 0 and height_u <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (room_id, code)
);

-- Enable RLS. NOTE: single-org placeholder policy — replace with
-- organization-scoped policies when auth lands (Phase: multi-tenant auth).
alter table organizations enable row level security;
alter table sites enable row level security;
alter table floors enable row level security;
alter table rooms enable row level security;
alter table racks enable row level security;

create policy "single_org_all" on organizations for all using (true) with check (true);
create policy "single_org_all" on sites for all using (true) with check (true);
create policy "single_org_all" on floors for all using (true) with check (true);
create policy "single_org_all" on rooms for all using (true) with check (true);
create policy "single_org_all" on racks for all using (true) with check (true);

-- Seed the single default organization.
insert into organizations (code, name) values ('DEFAULT', 'Default Organization');

-- Privileges for the PostgREST API roles. Phase 1's server uses service_role
-- (no auth yet); anon/authenticated are granted for when auth lands and remain
-- gated by the RLS policies above. (Not in the original plan SQL — required for
-- the service_role client in Task 6 to read/write.)
grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
