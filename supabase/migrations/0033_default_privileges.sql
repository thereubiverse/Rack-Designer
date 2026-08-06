-- The default privileges for schema `public`, as one idempotent block.
--
-- THIS IS NOT A NEW POLICY. All but one of the statements below already exist in 0027, 0028 or 0032,
-- and those files remain the record of WHY each one was written — read them, not this one, to
-- understand the reasoning. What was missing was a single authoritative place to RE-APPLY the
-- resulting state, because a restore destroys all of it.
--
-- THE ONE EXCEPTION is the last statement, `alter default privileges ... grant execute on functions
-- to service_role`, which appears in none of those three files (its own paragraph below says as much
-- — "It anchors the row"). It changes no real install's state: it is what the supabase/postgres
-- image already ships as the stock default for this schema, so on a live stack it is a no-op, and on
-- a restored one it puts back what DROP SCHEMA removed. It is written down here because after a
-- restore nothing else would.
--
-- WHAT DESTROYS IT. deploy/restore.sh replays db-public.sql.gz, which pg_dump produced with
-- --clean --if-exists, so it opens with
--
--     DROP SCHEMA IF EXISTS public;
--     CREATE SCHEMA public;
--
-- and dropping a schema takes every pg_default_acl row attached to it along with it. pg_dump
-- re-emits exactly two of them — `GRANT ALL ON SEQUENCES TO postgres` and `TO service_role` — and
-- nothing at all for tables or functions. Measured on a restored stack, before this file existed:
--
--     anon select on a new table         = false   <- fine, but only by accident (see below)
--     service_role select on a new table = false   <- broken
--
-- service_role is how all 61 server actions read every table, so the next migration to add a table
-- would have produced one the application could neither read nor write. That is precisely the
-- failure 0028 was written to prevent, reintroduced by the restore path.
--
-- ONE SOURCE OF TRUTH. deploy/restore.sh applies THIS FILE after the public replay. A copy of these
-- statements must never be pasted into restore.sh: two places to edit, one of which nobody reads
-- when writing a migration, is a worse bug than the one being fixed here — the defaults would drift
-- apart silently and only a restore would reveal it.
--
-- WHAT IS DELIBERATELY NOT HERE. The schema also carried a second set of default privileges owned
-- by `supabase_admin`, granting anon and authenticated a full arwdDxtm on every new table. 0027
-- documented it as a known limit because `postgres` is not a superuser here and cannot alter it.
-- DROP SCHEMA destroyed that one too, and it is not recreated below. Losing it is an improvement,
-- not a regression; do not add it back.

-- TABLES ------------------------------------------------------------------------------------------
-- From 0027: the publishable key gets nothing on a table that does not exist yet.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- From 0028: and service_role gets everything, so a new table is usable by the application the
-- moment it exists, with no grant tail to remember. Postgres's own default gives service_role only
-- Dxtm — no DML at all.
--
-- This grant is also what makes the pg_default_acl row for tables EXIST. Measured: a revoke that
-- merely restores Postgres's built-in default does not create a row, it deletes one, and
-- src/lib/supabase/grants.test.ts treats a missing row as a failure. The revoke above therefore
-- anchors nothing on its own; this line does. The row it produces is `service_role=arwdDxtm/postgres`
-- with no `postgres=` entry, and that is correct: a new table still comes out
-- `postgres=arwdDxtm/postgres, service_role=arwdDxtm/postgres` because Postgres merges the stored
-- default ACL with the hard-wired owner default rather than replacing it.
alter default privileges in schema public grant all on tables to service_role;

-- FUNCTIONS AND SEQUENCES -------------------------------------------------------------------------
-- From 0032. The supabase/postgres image ships default privileges that grant anon and authenticated
-- EXECUTE on every function created in this schema; the local Supabase CLI stack does not, which is
-- why this was invisible in development until grants.test.ts was pointed at a real deployment.
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;

-- The functions equivalent of the service_role line above, and needed for both of the same reasons.
--
-- 1. It anchors the row. The three revokes above create no pg_default_acl row for functions at all
--    (measured: they only remove entries, and with no row already present they remove nothing), and
--    for functions "no row" is not neutral — it means the built-in default, which is PUBLIC EXECUTE,
--    the wide-open state. grants.test.ts fails on the missing row for exactly that reason.
-- 2. It is load-bearing, not cosmetic. claim_phone_verification and is_device_trusted both hold
--    `service_role=X/postgres` today, and neither migration granted it explicitly — only 0031 does.
--    They inherited it from this default. Drop it and the next security-definer function is
--    unexecutable by the service client unless its author remembers a grant, which is the same trap
--    0028 closed for tables.
--
-- It mirrors the `GRANT ALL ON SEQUENCES TO service_role` that pg_dump already re-emits for
-- sequences, which is why sequences need no anchor here and functions do.
alter default privileges in schema public grant execute on functions to service_role;

-- A MEASURED CAVEAT, carried over from 0032 rather than introduced here. The
-- `revoke execute on functions from public` above does NOT stop a new function being executable by
-- PUBLIC, and never did. A schema-level default ACL is MERGED with Postgres's hard-wired default
-- (which grants PUBLIC EXECUTE), not substituted for it, so the union still contains PUBLIC:
--
--     create function public._pf() returns int language sql as 'select 1';
--     -- proacl: =X/postgres, postgres=X/postgres, service_role=X/postgres
--     select has_function_privilege('anon', 'public._pf()', 'execute');  -- t
--
-- Only a cluster-wide `alter default privileges revoke execute on functions from public` (no IN
-- SCHEMA clause) actually removes it, and that is out of scope for a schema-level restore. The
-- statement is kept because it is part of the state 0032 established and this file must reproduce
-- that state exactly. What actually closes PUBLIC is the per-function
-- `revoke all on function ... from public` that 0024 and 0029-0031 each carry — keep writing it.
-- See supabase/migrations/README.md.
