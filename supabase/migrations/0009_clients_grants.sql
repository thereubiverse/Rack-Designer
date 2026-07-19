-- 0008_clients.sql created `clients` after the one-time
--   grant select, insert, update, delete on all tables in schema public
-- from 0001_location_hierarchy.sql, so the new table never picked up API-role
-- privileges (it only had the implicit owner grants). Without this, every
-- PostgREST call against `clients` — including via the service_role key used
-- by src/features/clients/repository.ts — fails with "permission denied for
-- table clients". Mirror the grant 0001 issued for the original tables.
grant select, insert, update, delete on clients to anon, authenticated;
grant all privileges on clients to service_role;
