-- Slice 2, part 3: give `authenticated` back the ONE row it must be able to read.
--
-- WHAT 0043 BROKE. That migration ran `alter table members enable row level security` and created a
-- single policy, `members_tenant`, granted to `app_tenant`. `authenticated` was left with a column
-- grant (0028: `select (email, disabled_at) on members`) and no policy at all — and a table with RLS
-- enabled and no applicable policy returns zero rows, silently, with no error.
--
-- That is not a cosmetic gap. `src/middleware.ts` checks membership on EVERY request, using the
-- publishable key plus the user's session, which reaches PostgREST as `authenticated` — it cannot use
-- the service-role client, which is `server-only` and cannot be imported into the Edge runtime.
-- `isActiveMember` returns `data !== null && data.disabled_at === null`, so zero rows reads as "not a
-- member" (NOT as an error — `maybeSingle()` on an empty result is a success with `data: null`, so
-- the fail-open branch for `null` never fires) and every real member is redirected to /login forever.
-- Measured on this database before this migration:
--
--   set local role authenticated;  select count(*) from members;  -->  0
--   (as postgres)                  select count(*) from members;  -->  2
--
-- Nothing caught it because every other query in the application runs as `service_role`, which
-- bypasses RLS entirely. Only interactive sign-in touches this path.
--
-- WHY THIS IS NARROWER THAN WHAT CAME BEFORE, NOT WIDER. Before 0043 there was no RLS on `members`,
-- so the 0028 column grant let `authenticated` read `email` and `disabled_at` for EVERY member row —
-- the member-enumeration surface this directory's README complains about, reachable by anyone holding
-- the publishable key and any valid session. This policy admits one row: the caller's own. The
-- enumeration surface is closed by it, not reopened.
--
-- EMAIL CASE. `members.email` is pinned lowercase by the `members_email_normalised` check constraint,
-- and `src/middleware.ts`'s `normaliseEmail` lowercases before querying, so both sides of the
-- middleware's own filter are normalised. The JWT claim was measured rather than assumed: signing in
-- as `RSingh@QTSI.us` through the GoTrue password grant returns an access token whose `email` claim
-- is `rsingh@qtsi.us` — GoTrue normalises it. `lower()` is applied here anyway, because the cost is
-- nothing and the failure it prevents is total: a member whose `auth.users.email` ever reached the
-- table un-normalised (an admin-API insert, an OAuth provider that preserves case) would match no row
-- and be locked out of the entire application with no error anywhere. It cannot widen anything —
-- `members.email` is lowercase by constraint, so `lower(claim)` still matches at most one row.
--
-- THE TWO `nullif`s ARE NOT THE SAME GUARD, and the order of the inner one against the cast is
-- load-bearing. `current_setting(..., true)` returns NULL only when the GUC was never defined in the
-- session; when it is defined but EMPTY it returns the empty string, and `''::json` does not yield
-- NULL, it raises `invalid input syntax for type json`. Measured, with the cast written first:
--
--   set local request.jwt.claims = '';  select ... from members;
--   -->  ERROR:  invalid input syntax for type json
--
-- An error is worse here than it looks. `isActiveMember` fails OPEN on a query error, deliberately
-- (an outage must not lock out the whole company), so an error on this path would not redirect
-- anyone — it would wave every request through with the membership gate silently off, which is the
-- one failure mode this policy exists to make impossible. Hence the INNER `nullif` runs before the
-- cast: '' becomes NULL, `NULL::json ->> 'email'` is NULL, and no row is visible. The OUTER `nullif`
-- covers the different case of a well-formed claims object carrying `"email": ""`.
--
-- This is a `for select` policy, so it has no `with check` — unlike every policy in 0043, which
-- covers `for all`. There is deliberately nothing to check: `authenticated` holds no insert, update
-- or delete grant on `members` (0027/0028), and a `with check` clause on a SELECT-only policy is not
-- merely redundant, it is not permitted. `src/lib/supabase/policies.test.ts` carries the matching
-- exemption, by name.
--
-- NOTHING IS GRANTED TO `anon` HERE. `anon` had its `members` grant revoked in 0028 and still reads
-- nothing at all; this policy names `authenticated` alone, and a policy cannot grant a table
-- privilege that the role does not already hold.

drop policy if exists members_self on members;
create policy members_self on members for select to authenticated
  using (
    email = lower(
      nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')
    )
  );
