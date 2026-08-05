# Closing the Anon REST Surface (Slice H5) — Design

Raised as a follow-up by three consecutive final reviews — the authentication, profile and roles
slices each ended with a note that the roles gate the application and not the database. This closes
it.

## 1. What is actually exposed

Measured, not inferred. With the publishable `anon` key today:

```
select ... from information_schema.role_table_grants where grantee='anon'
→ 14 tables with DELETE, INSERT, SELECT, UPDATE, TRUNCATE, REFERENCES, TRIGGER

set role anon; delete from clients where code='___no_such_code___';
→ DELETE 0        -- permitted; it simply matched nothing

curl "$URL/rest/v1/clients?select=*" -H "apikey: $ANON_KEY"
→ HTTP 200        -- every client returned
```

Every client, site, floor, room, rack, device, connection, floor plan and app setting is readable,
writable, deletable and **truncatable** by anyone holding that key. The 61 server actions, the three
roles and the `withMember` gate are all bypassed, because none of them are in the path.

There are two independent sources:

1. **The blanket grant.** Every migration since `0001` ends with
   `grant select, insert, update, delete on all tables in schema public to anon, authenticated;`.
   It was copied forward twenty-six times, including in migrations written this week to *narrow*
   access — which is why `members`, `phone_verifications` and `activity_log` each needed their
   narrowing re-applied after it.
2. **Supabase's default privileges.** `\ddp` shows `anon=Dxtm` on tables in `public` — TRUNCATE,
   REFERENCES, TRIGGER, MAINTAIN — granted automatically to every table created from now on,
   independent of any migration. Revoking the existing fourteen would leave the fifteenth table
   truncatable on the day it is created.

Both must be closed or the fix is cosmetic.

## 2. The app does not use this access

The browser never talks to Supabase for data. All 61 server actions go through
`createServiceClient()`, which uses the service-role key and is `server-only`. The publishable key
appears in exactly two files, and only one of them touches `public`:

- `src/middleware.ts:35` — reads `disabled_at` from `members`, filtered by `email`, on every request.
  It runs on the Edge runtime, where the `server-only` service client cannot be imported.
- `src/lib/supabase/auth.ts` — the cookie session client, which touches the `auth` schema only.

So the public REST surface exists by accident of Supabase's defaults, not by design. Closing it costs
the app one grant.

## 3. The change

### `0027_close_anon_surface.sql`

```sql
-- Existing tables.
revoke all on all tables in schema public from anon, authenticated;

-- Future tables. Without this, the next `create table` is TRUNCATE-able by the publishable key on
-- the day it is written, because Supabase's default privileges grant anon Dxtm in this schema.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- The one exception, and the whole reason anon retains any reach into public: src/middleware.ts
-- checks membership on every request using the publishable key, because it runs on the Edge runtime
-- where the server-only service client cannot be imported. It selects disabled_at filtered by email,
-- and Postgres requires SELECT on a column to filter by it — hence both.
grant select (email, disabled_at) on members to anon, authenticated;
```

`usage on schema public` stays: without it the middleware cannot reach `members` at all.
`service_role` keeps everything — it is what the entire application runs on.

**Sequences are left alone.** `anon` holds `w` on sequences in `public`, but every table here uses a
`uuid` default rather than a sequence, and the privilege is useless without table access. Noted so
the omission is a decision rather than an oversight.

### The migration template changes

From `0027` onward, migrations do **not** carry the blanket grant. A new table is reachable by
`service_role`, which is all the app needs. The narrowing tails that 0020, 0022, 0023, 0025 and 0026
each had to re-apply become unnecessary, because there is no longer anything re-opening them.

## 4. Why not row-level security

RLS is the canonical Supabase answer and it is the wrong tool here *today*.

The service-role client **bypasses RLS entirely**, and it is what all 61 actions use. So policies
would govern only the direct-REST path — the one this migration closes completely. Writing policies
for fourteen tables would protect an access path that no longer exists, while requiring the database
to express a notion of "the current user" that this application does not currently have.

RLS becomes the right answer the moment the browser queries Supabase directly, or when a role must be
genuinely unable to read something independent of application code. Neither is true yet, and this
change does not make either harder — the grants can be widened and policies added whenever that day
comes.

## 5. Stopping it coming back

The convention has already failed six times: every migration since `0001` copied the grant, including
three written this week whose entire purpose was to restrict access. A note in a template will not
hold.

So the check is automated. `src/lib/supabase/grants.test.ts` queries the live database's
`information_schema.role_table_grants` and asserts that `anon` and `authenticated` hold **no**
privilege on any table in `public`, with exactly one documented exception: `select` on `members`,
limited to `email` and `disabled_at` via `information_schema.column_privileges`.

It is **read-only** — it queries grants and asserts; it creates nothing and drops nothing. That
matters, because the integration tests in this repo wipe the database and this must never join them.
It is named `grants.test.ts`, not `grants.integration.test.ts`, so the standard full-suite run
includes it, and it fails the moment the seventh migration re-opens the surface.

## 6. What could break, and how we will know

If something does depend on anon access that this analysis missed, it fails **loudly** — PostgREST
returns `permission denied for table X`, not an empty result. That is the right failure direction and
it is why this is safe to do in one migration rather than incrementally.

The specific thing to verify live, because the whole app depends on it: the middleware's membership
check must still work. If it breaks, every request fails its check and the middleware **fails open**
by design (§6 of the authentication spec), so the app would keep serving pages while the gate
silently stopped working. That is the one failure this change could cause that would not be obvious,
so it is verified directly rather than assumed.

Storage is unaffected: `storage.objects` has RLS enabled with no policies, avatars and floor plans
are read through service-role-signed URLs, and the blanket grant was scoped to schema `public` and
never reached schema `storage`.

## 7. Testing

- **Grants** (`grants.test.ts`, read-only): anon and authenticated hold nothing on every table in
  `public`; the sole exception is `select` on `members.email` and `members.disabled_at`; a new table
  created later inherits nothing (asserted via `\ddp`'s underlying `pg_default_acl`).
- **Live, and the load-bearing check**: sign in and load a page — the middleware's membership query
  must still succeed. Then revoke a member by SQL and confirm they are still bounced, proving the
  gate is working rather than failing open.
- **Live, the negative**: `curl` the REST API with the publishable key for `clients`, and for a
  write — both must be refused, where both succeeded before.
- Tests run by EXPLICIT FILENAME or with the three `--exclude` flags — the integration files wipe the
  local database.

## 8. Out of scope

Row-level security (§4). Sequence privileges (§3). The `storage` schema, which was never exposed by
this grant. Rotating the publishable key — it was never secret, and after this change it grants
almost nothing. Any change to how the application authenticates or authorises: this slice moves no
application logic at all.
