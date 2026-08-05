# Migrations

Applied with:

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/NNNN_name.sql
```

`docker exec` needs the `-i`. Without it psql silently receives nothing and reports success.

## Do not add a grant tail

Every migration from `0001` to `0026` ended with:

```sql
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

It was copied forward twenty-six times, including into `0020`, `0022`, `0023`, `0025` and `0026` —
migrations whose *purpose* was to restrict access, and which therefore each had to undo it again in
the same file. The result was that the publishable key held 202 grants across 15 tables: full CRUD
plus TRUNCATE on every application table, bypassing all 61 server actions, the three roles, and the
`withMember` gate, because none of them sit in that path.

`0027` closed it. **New migrations grant nothing to `anon` or `authenticated`.**

A new table needs no grants at all: `service_role` is what the application runs on, and every server
action reaches the database through `createServiceClient`. A table should start closed.

## What those two roles can still reach

Exactly one thing:

```sql
grant select (email, disabled_at) on members to anon, authenticated;
```

`src/middleware.ts` checks membership on every request with the publishable key, because it runs on
the Edge runtime where the `server-only` service client cannot be imported. It selects `disabled_at`
filtered by `email`, and Postgres requires `SELECT` on a column to filter by it — hence both. Both
roles are granted because a signed-in request carries the user's JWT and arrives as `authenticated`
rather than `anon`.

If a new feature appears to need more than this, that is a design question rather than a grant
question. The application uses the service role for all data access.

## This is enforced, not just documented

`src/lib/supabase/grants.test.ts` queries the live database and fails if either role holds any table
privilege in `public`, or any column privilege beyond the two above. It is read-only, and it runs in
the normal test suite — it is deliberately **not** named `*.integration.test.ts`, because those wipe
the database and are excluded from every run.

If it fails after you write a migration, you almost certainly copied an old tail.

## One known limit

`0027` also revoked the schema's *default* privileges, so a newly created table inherits nothing.
That closed the set owned by `postgres` only. There is a second set owned by `supabase_admin` which
still grants `anon` a full `arwdDxtm`, and it cannot be altered from the `postgres` role — that role
is neither a superuser nor a member of `supabase_admin`.

It does not bite here, because every table in `public` is owned by `postgres` (migrations run as
`psql -U postgres`), so the `postgres` set is the one that governs what a new table inherits. And the
first assertion in `grants.test.ts` checks the privileges that actually exist on actual tables, so an
exposed table is caught regardless of which set of defaults produced it.

## Row-level security

There is none, deliberately. The service-role client bypasses RLS, and that is what the whole
application uses — so policies would govern only the direct-REST path, which `0027` closed outright.
RLS becomes the right tool if the browser ever queries Supabase directly, or if a role must be
genuinely unable to read something independently of application code. Neither is true today, and
nothing here makes it harder later.
