-- supabase/migrations/0004_rack_devices.sql
-- Placed device instances: a rack position referencing a Device Library template.
-- Faces are looked up from the template at render time (no snapshot; impact/rebuild
-- semantics arrive with connections in Phase 2c).

create table rack_devices (
  id uuid primary key default gen_random_uuid(),
  rack_id uuid not null references racks(id) on delete cascade,
  device_template_id uuid not null references device_templates(id) on delete restrict,
  code text not null check (code ~ '^[A-Z0-9_-]{1,10}$'),
  name text,
  start_u int not null check (start_u >= 1),
  side text not null default 'front' check (side in ('front','back')),
  status text not null default 'installed' check (status in ('planned','installed','verified')),
  manufacturer text,
  model_name text,
  serial_number text,
  purchase_date date,
  operation_start date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Deferred so a single reconcile statement can SWAP two devices' codes; checked at commit. Not the upsert arbiter (that's the PK), so ON CONFLICT (id) still works.
  constraint rack_devices_rack_id_code_key unique (rack_id, code) deferrable initially deferred
);

alter table rack_devices enable row level security;
create policy "single_org_all" on rack_devices for all using (true) with check (true);

grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
