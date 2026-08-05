-- Two corrections to 0027, both found by review before either could bite.

-- 1. THE ONE THAT WOULD HAVE BROKEN THE NEXT MIGRATION.
--
-- 0027 told the next author (in its own comment, and in supabase/migrations/README.md) that a new
-- table "needs no grants at all, because service_role is what the application runs on". That was
-- wrong. The postgres-owned default ACL grants service_role only `Dxtm` — TRUNCATE, REFERENCES,
-- TRIGGER, MAINTAIN — and no DML at all. Proven in a rolled-back transaction:
--
--   create table public._probe (id int);
--   select has_table_privilege('service_role','public._probe','select');  -- f
--   select has_table_privilege('service_role','public._probe','insert');  -- f
--
-- Every migration up to 0026 masked this with its `grant all privileges on all tables in schema
-- public to service_role` tail, which 0027's advice removed along with the anon tail. The first
-- table written under that advice would have been unreadable and unwritable by all 61 server
-- actions, and grants.test.ts would not have noticed — it only asserts what anon and authenticated
-- LACK.
--
-- Fixing it in the defaults rather than in each migration means a new table is usable by the
-- application the moment it exists, with no tail to remember.
alter default privileges in schema public grant all on tables to service_role;

-- 2. anon never needed to read members.
--
-- 0027 kept `select (email, disabled_at) on members` for BOTH anon and authenticated, on the
-- assumption the Edge middleware might query as either. It cannot: src/middleware.ts returns early
-- when `getUser()` finds no user, so the membership query only ever runs for a request carrying a
-- JWT — which reaches PostgREST as `authenticated`.
--
-- Leaving anon that grant let anyone holding the publishable key list every member:
--   curl "$URL/rest/v1/members?select=email,disabled_at" -H "apikey: $ANON_KEY"
--   → [{"email":"..."},{"email":"..."}]
--
-- which is exactly the email enumeration the authentication spec's uniform refusal message exists
-- to prevent. `authenticated` keeps it, because that is the role the middleware actually uses.
revoke select (email, disabled_at) on members from anon;
