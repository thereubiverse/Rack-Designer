-- Floor devices: the inventory of physical devices that live on a floor (cameras, APs, data
-- drops...). Spec slice A of the floor-plans programme. site_id is DELIBERATELY denormalized so
-- device codes can be unique per SITE (CAM01..CAM14 count across the whole building — it's what
-- goes on the physical label); the repository derives it from the floor row on every write.
-- room_id is optional (hallway cameras) and deleting a room orphans devices to floor level
-- rather than deleting them.
create table floor_devices (
  id             uuid primary key default gen_random_uuid(),
  site_id        uuid not null references sites(id) on delete cascade,
  floor_id       uuid not null references floors(id) on delete cascade,
  room_id        uuid references rooms(id) on delete set null,
  device_type_id uuid not null references device_types(id) on delete restrict,
  code           text not null,
  name           text not null default '',
  status         text not null default 'planned' check (status in ('planned', 'installed')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (site_id, code)
);

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
