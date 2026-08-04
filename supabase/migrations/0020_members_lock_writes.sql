-- The blanket grant repeated at the tail of every migration gives anon and authenticated select,
-- insert, update, delete on ALL tables in public, including members -- and there is no row level
-- security anywhere in this schema. That means anyone holding the anon key (public, shipped to the
-- browser) could INSERT their own address into members, making themselves an active member, and
-- then sign in -- defeating the entire invite-only gate this branch exists to build.
--
-- Revoke insert/update/delete on members from anon and authenticated. Leave select alone:
-- src/middleware.ts queries members using the ANON key on the Edge runtime, and it FAILS OPEN when
-- that query errors. Revoking select would make every middleware membership lookup error, which
-- would silently admit everyone -- disabling the exact read gate this migration is meant to
-- protect. Writes only.

-- Standard blanket grant, byte-identical to the tail of every other migration in this repo.
grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- IMPORTANT: this revoke must run AFTER the blanket grant above, and must stay the LAST statement
-- in this file. If the blanket grant is ever reordered to run after this revoke, it will silently
-- re-grant the writes this migration exists to remove. Do not reorder.
revoke insert, update, delete on members from anon, authenticated;
