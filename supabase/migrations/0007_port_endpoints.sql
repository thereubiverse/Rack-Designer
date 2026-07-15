-- supabase/migrations/0007_port_endpoints.sql
-- Slice 2a: the far end of a run leaving a rack port. An endpoint belongs to a PORT (not to a
-- patch cable), so it survives unplugging/re-patching.

create table port_endpoints (
  id                 uuid primary key default gen_random_uuid(),
  rack_id            uuid not null references racks(id) on delete cascade,
  -- the rack port this endpoint hangs off (same identity `connections` uses)
  rack_device_id     uuid not null references rack_devices(id) on delete cascade,
  side               text not null check (side in ('front','back')),
  group_id           uuid not null,
  port_index         int  not null check (port_index >= 0),

  kind               text not null check (kind in ('described','device','rack')),

  -- kind='described'
  device_type_id     uuid references device_types(id) on delete restrict,
  name               text not null default '',
  -- 0 = a blank plate (the run is unterminated or covered); it has no landing port.
  port_count         int  not null default 1 check (port_count in (0,1,2,3,4,6)),
  landing_port_index int  not null default 0 check (landing_port_index >= 0),
  landing_port_label text not null default '',

  -- kind='device' / kind='rack'
  target_rack_device_id uuid references rack_devices(id) on delete cascade,
  target_rack_id        uuid references racks(id)        on delete cascade,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Deferred so a single reconcile statement (replacePortEndpoints' upsert) can swap two
  -- endpoints' ports in one save without transiently colliding; checked at commit. Not the upsert
  -- arbiter (that's the PK), so ON CONFLICT (id) still works. Same reasoning as
  -- rack_devices_rack_id_code_key in 0004_rack_devices.sql.
  constraint port_endpoints_port_uniq unique (rack_device_id, side, group_id, port_index) deferrable initially deferred,
  -- A blank plate has no ports, so no landing index can be < port_count; it stores 0 and means
  -- "nothing to land on". Every other count must name a real opening.
  constraint port_endpoints_landing_ck check (port_count = 0 or landing_port_index < port_count),
  constraint port_endpoints_kind_ck check (
    (kind='described' and device_type_id is not null and target_rack_device_id is null and target_rack_id is null)
 or (kind='device'    and target_rack_device_id is not null and device_type_id is null and target_rack_id is null)
 or (kind='rack'      and target_rack_id is not null and device_type_id is null and target_rack_device_id is null)
  )
);

alter table port_endpoints enable row level security;
create policy "single_org_all" on port_endpoints for all using (true) with check (true);

grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
