-- Archive: deleting a client, site or floor flags the row instead of destroying it. The flag lives
-- ONLY on the archived row, never on its children — that is what makes a restore exact rather than
-- reconstructed. Row ids survive, so racks.room_id, floor_devices.floor_id and the storage paths
-- that embed site and floor ids all keep pointing at live rows.
alter table clients add column archived_at timestamptz;
alter table sites   add column archived_at timestamptz;
alter table floors  add column archived_at timestamptz;

-- Partial, on the NON-NULL side, because they serve the archive page reading the rare archived
-- rows. The list queries filter `archived_at is null`, which is the overwhelming majority of every
-- table and is better served by a sequential scan than an index.
create index clients_archived_idx on clients (archived_at) where archived_at is not null;
create index sites_archived_idx   on sites   (archived_at) where archived_at is not null;
create index floors_archived_idx  on floors  (archived_at) where archived_at is not null;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
