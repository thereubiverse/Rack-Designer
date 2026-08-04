-- 0021 added phone, position and address to members. That table has no row-level security, and the
-- blanket grant every migration carries gives `anon` SELECT on every column of every table in
-- public — so the profile columns were readable by anyone holding the anon key:
--
--   curl "$URL/rest/v1/members?select=email,name,phone,address" -H "apikey: $ANON_KEY"
--   -> every member's personal phone number and home address
--
-- The anon key is `NEXT_PUBLIC_` by design: it is meant to be publishable, and today it is only
-- referenced server-side purely by accident of which files happen to use it. Employee home
-- addresses must not sit behind it either way.
--
-- 0020 already revoked the write verbs. This narrows the read to the two columns that actually need
-- anon access: src/middleware.ts runs on the Edge runtime, where the server-only service-role client
-- cannot be imported, so it checks membership with the anon key — selecting `disabled_at` and
-- filtering on `email`. Postgres requires SELECT on a column to filter by it, so both are granted.
-- Everything else that reads members uses the service-role client, which column grants do not touch.
--
-- ORDER MATTERS. The three blanket grants come first; the narrowing comes last, or the blanket
-- grant simply hands the columns back. Same trap as 0020's revoke — keep this shape in any future
-- migration that touches members.
grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

revoke insert, update, delete on members from anon, authenticated;

revoke select on members from anon, authenticated;
grant select (email, disabled_at) on members to anon, authenticated;
