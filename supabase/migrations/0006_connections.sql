-- supabase/migrations/0006_connections.sql
-- Slice 1 patching: freeze each placed device's port layout onto the instance so patches
-- survive later template edits, and add the patch-cable (user connection) table.

-- 1. Snapshot columns on rack_devices (nullable; backfilled from templates for existing rows).
alter table rack_devices
  add column front_face jsonb,
  add column back_face  jsonb,
  add column height_u   int;

update rack_devices rd
   set front_face = dt.front_face,
       back_face  = dt.back_face,
       height_u   = dt.rack_units
  from device_templates dt
 where rd.device_template_id = dt.id;

-- 2. Patch cables. Both endpoints reference rack_devices in the same rack.
create table connections (
  id                uuid primary key default gen_random_uuid(),
  rack_id           uuid not null references racks(id) on delete cascade,
  a_rack_device_id  uuid not null references rack_devices(id) on delete cascade,
  a_side            text not null check (a_side in ('front','back')),
  a_group_id        uuid not null,
  a_port_index      int  not null check (a_port_index >= 0),
  b_rack_device_id  uuid not null references rack_devices(id) on delete cascade,
  b_side            text not null check (b_side in ('front','back')),
  b_group_id        uuid not null,
  b_port_index      int  not null check (b_port_index >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Backstop against exact duplicate edges (order-independent). App logic enforces the
-- stronger one-connection-per-port rule and re-validates server-side.
create unique index connections_edge_uniq on connections (
  rack_id,
  least(a_rack_device_id::text || a_side || a_group_id::text || a_port_index::text,
        b_rack_device_id::text || b_side || b_group_id::text || b_port_index::text),
  greatest(a_rack_device_id::text || a_side || a_group_id::text || a_port_index::text,
           b_rack_device_id::text || b_side || b_group_id::text || b_port_index::text)
);

alter table connections enable row level security;
create policy "single_org_all" on connections for all using (true) with check (true);

grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
