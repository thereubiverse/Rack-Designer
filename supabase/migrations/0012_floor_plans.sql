-- Slice B of the floor-plans programme: one plan per floor, placements normalized 0..1 against
-- it. width/height are the stored PNG's true dimensions (decoded server-side at upload) — needed
-- for aspect ratio and for Slice C to map vision-model output back onto normalized space.
create table floor_plans (
  id                uuid primary key default gen_random_uuid(),
  floor_id          uuid not null references floors(id) on delete cascade,
  storage_path      text not null,
  width_px          integer not null check (width_px > 0),
  height_px         integer not null check (height_px > 0),
  original_filename text not null default '',
  source            text not null default 'image' check (source in ('image', 'pdf')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (floor_id)
);

-- Placement: BOTH null (unplaced) or BOTH set (placed). App-enforced; the check makes the
-- half-set state unrepresentable at the DB level too.
alter table floor_devices add column x double precision;
alter table floor_devices add column y double precision;
alter table floor_devices add constraint floor_devices_xy_together
  check ((x is null) = (y is null));

alter table rooms add column plan_polygon jsonb;

-- First persisted binaries in the app: private bucket, server-side writes only.
insert into storage.buckets (id, name, public)
  values ('floor-plans', 'floor-plans', false)
  on conflict (id) do nothing;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
