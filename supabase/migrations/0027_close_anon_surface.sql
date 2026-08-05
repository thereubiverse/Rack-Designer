-- Close the public REST surface.
--
-- Until now every migration ended with `grant select, insert, update, delete on all tables in
-- schema public to anon, authenticated`, copied forward 26 times — including migrations whose
-- purpose was to RESTRICT access, which is why members, phone_verifications and activity_log each
-- had to re-apply their narrowing after it in the same file. The result, measured: the publishable
-- key held 202 grants across 15 tables — full CRUD plus TRUNCATE on every application table —
-- bypassing all 61 server actions, the three roles and the withMember gate, none of which are in
-- that path.
--
-- The application does not use this access. Every action goes through createServiceClient (the
-- service role); the publishable key touches `public` in exactly one place, re-granted at the end.
--
-- FROM THIS MIGRATION ON, DO NOT ADD THE BLANKET GRANT. service_role already holds everything the
-- app needs, and a new table should start closed. See supabase/migrations/README.md.
revoke all on all tables in schema public from anon, authenticated;

-- Future tables. Supabase's default privileges grant anon and authenticated on every table created
-- in this schema from now on, independent of any migration. Without this line the next
-- `create table` is reachable by the publishable key on the day it is written, and the revoke above
-- would look complete while not being it.
--
-- KNOWN LIMIT, deliberately not worked around. There are TWO sets of default privileges on this
-- schema: one owned by `postgres` and one owned by `supabase_admin` (which still grants anon and
-- authenticated a full arwdDxtm). This statement closes the `postgres` set only — `postgres` is not
-- a superuser here and is not a member of `supabase_admin`, so altering that second set raises
-- "permission denied to change default privileges".
--
-- It does not matter in practice: every table in this schema is owned by `postgres` (all 17 of
-- them), because migrations are applied with `psql -U postgres`, so it is the `postgres` set that
-- governs what a new table inherits. It WOULD matter if something ever created a table as
-- supabase_admin. That is precisely what src/lib/supabase/grants.test.ts catches — it asserts the
-- actual privileges on the actual tables, so it fails on an exposed table regardless of which set
-- of defaults produced it.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- The single exception. src/middleware.ts checks membership on EVERY request using the publishable
-- key, because it runs on the Edge runtime where the server-only service client cannot be imported.
-- It selects disabled_at filtered by email, and Postgres requires SELECT on a column to filter by
-- it — hence both columns. `authenticated` is included because a signed-in request carries the
-- user's JWT and reaches PostgREST as that role rather than as anon.
--
-- If this grant is ever lost, the middleware's query errors on every request and the check FAILS
-- OPEN by design — the app keeps serving pages with the gate silently off. That is why it is the
-- probe this migration is verified against first.
grant select (email, disabled_at) on members to anon, authenticated;
