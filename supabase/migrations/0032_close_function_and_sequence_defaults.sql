-- Close the FUNCTION and SEQUENCE default privileges.
--
-- 0027 closed the default privileges for TABLES and stopped there. That was incomplete, and the gap
-- was invisible on the development machine: this was found by pointing grants.test.ts at a freshly
-- installed self-hosted stack (deploy/install.sh) rather than at the local Supabase CLI stack, and
-- the two ship different defaults. The CLI's database has
--
--   postgres | f | postgres=X/postgres
--
-- while a fresh supabase/postgres image has
--
--   postgres | f | postgres=X/postgres | anon=X/postgres | authenticated=X/postgres | service_role=X/postgres
--
-- so on the image — i.e. on every real deployment — every function created by a migration is born
-- with an explicit EXECUTE grant to anon and authenticated.
--
-- The per-function `revoke all on function ... from public` that 0029, 0030 and 0031 each end with
-- does NOT undo that. Revoking from PUBLIC removes the implicit world grant; it does nothing to an
-- explicit grant held by the roles anon and authenticated. Both survived.
--
-- The consequence was demonstrated, not inferred, against the installed stack: a POST to
-- /rest/v1/rpc/consume_device_attempt carrying nothing but the publishable key returned
--
--   [{"code":"424242","expires_at":"...","attempts":1}]
--
-- consume_device_attempt is SECURITY DEFINER and returns the device-approval code itself, so anyone
-- holding the publishable key — which is public by design and shipped to every browser — could read
-- the emailed code for any pending device and approve their own machine. The trusted-device factor
-- was defeated end to end on any fresh install, while the local stack showed nothing wrong.

-- 1. Future functions and sequences, for both roles. This is the actual fix; everything below is
--    cleanup of what the missing default already produced.
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- 2. Belt and braces on top of the convention. Postgres grants EXECUTE on a new function to PUBLIC
--    regardless of default privileges, which is why 0029-0031 each carry a `revoke ... from public`
--    line. Revoking it from PUBLIC *by default* means forgetting that line on a future migration
--    leaves the function closed rather than open — the failure mode stops being silent. Keep writing
--    the per-function revoke anyway; this is the backstop, not a replacement.
alter default privileges in schema public revoke execute on functions from public;

-- 3. The functions and sequences that already exist inherited the grants above when they were
--    created. On a stack installed before this migration, is_device_trusted and
--    consume_device_attempt are both executable by anon right now.
revoke all on all functions in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- 4. Restore the one function grant the application genuinely needs. src/middleware.ts calls
--    is_device_trusted on every request with the publishable key, as `authenticated` — the request
--    always carries a JWT, because the middleware returns early when getUser() finds no user.
--    consume_device_attempt is deliberately NOT re-granted: it is called only from a server action
--    through the service-role client, and handing it to a public role is what this migration exists
--    to undo.
grant execute on function is_device_trusted(text, text) to authenticated;

-- The same known limit as 0027 applies: there is a second set of default privileges owned by
-- supabase_admin which still grants anon and authenticated on functions, and `postgres` cannot alter
-- it. It does not bite, because every function in this schema is owned by `postgres` (migrations run
-- as `psql -U postgres`), so the postgres set is the one that governs. grants.test.ts asserts the
-- privileges that actually exist on the actual functions, so an exposed function is caught whichever
-- set of defaults produced it — and it now asserts these defaults directly as well.
