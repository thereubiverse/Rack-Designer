-- Fix current_org_id(): the GUC-defined-but-empty case raised instead of reading as no organisation.
--
-- 0042 wrote:
--
--   select nullif(current_setting('request.jwt.claims', true)::json ->> 'org_id', '')::uuid
--
-- `current_setting(..., true)` returns NULL only when the GUC was never defined in the session. When
-- it is defined but EMPTY it returns the empty string, and the cast to json happens BEFORE the
-- `nullif` guards it, so `''::json` raises rather than producing NULL. Measured on this database:
--
--   set local request.jwt.claims = '';
--   select current_org_id();
--   ERROR:  invalid input syntax for type json
--   DETAIL:  The input string ended unexpectedly.
--
-- The design's stated property is that a request with no valid organisation reads NOTHING, because
-- current_org_id() returns NULL and `org_id = NULL` is never true. Raising is still fail-closed for
-- app_tenant — the query aborts rather than returning rows — but it does not match that documented
-- behaviour, and an exception raised inside a policy surfaces as a server error rather than an empty
-- result: a materially different thing to debug. The same bug, in the same shape, was found and fixed
-- for the `members_self` policy in 0044; this migration brings current_org_id() in line with it.
--
-- THE TWO `nullif`s ARE NOT THE SAME GUARD, and the order of the inner one against the cast is
-- load-bearing, exactly as in 0044's members_self policy:
--
--   - The INNER nullif runs BEFORE the cast to json. It catches the GUC itself being defined but
--     empty (`current_setting` returned '' rather than NULL) — the case that otherwise raises before
--     the outer nullif is ever reached.
--   - The OUTER nullif runs AFTER the ->> extraction. It catches a well-formed claims object that
--     carries `"org_id": ""` — proven load-bearing in the original spike, where an empty org_id
--     string must read as no organisation rather than as an invalid uuid cast.
--
-- `create or replace function` preserves the existing ACL (the 0042 `revoke ... from public` /
-- `grant ... to app_tenant` pair), it does not need to be repeated here. Confirmed, not assumed: see
-- the ACL check in this task's proof.
create or replace function current_org_id() returns uuid
language sql stable as $$
  select nullif(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'org_id',
    ''
  )::uuid
$$;
