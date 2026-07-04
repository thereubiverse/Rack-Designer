-- Brands (org-scoped reference list)
create table brands (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- Device types (org-scoped reference list; managed on the Device Types tab)
create table device_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- Device templates (authored in the Rack Device Editor; front/back faces are JSON)
create table device_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  brand_id uuid references brands(id) on delete set null,
  device_type_id uuid not null references device_types(id) on delete restrict,
  rack_units int not null default 1 check (rack_units > 0 and rack_units <= 60),
  width_in numeric not null default 19 check (width_in > 0 and width_in <= 30),
  rack_mounted boolean not null default true,
  front_face jsonb,
  back_face jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- RLS: single-org placeholder policies (replace with org-scoped policies when auth lands)
alter table brands enable row level security;
alter table device_types enable row level security;
alter table device_templates enable row level security;
create policy "single_org_all" on brands for all using (true) with check (true);
create policy "single_org_all" on device_types for all using (true) with check (true);
create policy "single_org_all" on device_templates for all using (true) with check (true);

-- Privileges for the PostgREST API roles (same pattern as migration 0001)
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- Seed: a Generic brand and a starter device-type list for the default org
insert into brands (organization_id, name)
  select id, 'Generic' from organizations where code = 'DEFAULT';
insert into device_types (organization_id, name)
  select o.id, t.name
  from organizations o
  cross join (values
    ('Switch'),('Router'),('Firewall'),('Gateway'),('Patch Panel'),
    ('Server'),('UPS'),('PDU'),('KVM'),('Cable Manager'),('Shelf/Tray'),('Other')
  ) as t(name)
  where o.code = 'DEFAULT';
