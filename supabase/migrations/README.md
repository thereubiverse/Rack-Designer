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

A new table also needs no `service_role` grant, but *only because `0028` arranged that* — and this
is the part that is easy to get wrong. Postgres's default privileges for this schema originally gave
`service_role` just `Dxtm` (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) and no DML at all; every
migration up to `0026` papered over that with its own
`grant all privileges on all tables in schema public to service_role` tail. Drop the tail without
fixing the default and the next table you create is unreadable and unwritable by all 61 server
actions:

```sql
create table public._probe (id int);
select has_table_privilege('service_role','public._probe','select');  -- was f, now t
```

`0028` ran `alter default privileges in schema public grant all on tables to service_role;`, so a
new table is usable by the application the moment it exists. `grants.test.ts` asserts that default
is still in place, in both directions.

## What those two roles can still reach

Exactly one thing:

```sql
grant select (email, disabled_at) on members to authenticated;
```

`src/middleware.ts` checks membership on every request with the publishable key, because it runs on
the Edge runtime where the `server-only` service client cannot be imported. It selects `disabled_at`
filtered by `email`, and Postgres requires `SELECT` on a column to filter by it — hence both columns.

**`authenticated` only.** `0027` granted this to `anon` as well, on the assumption the middleware
might query as either. It cannot: the middleware returns early when `getUser()` finds no user, so
that query only ever runs for a request carrying a JWT, which reaches PostgREST as `authenticated`.
The `anon` half was dead weight that let anyone holding the publishable key list every member's
email address — the same enumeration the authentication spec's uniform refusal message exists to
prevent. `0028` revoked it.

If a new feature appears to need more than this, that is a design question rather than a grant
question. The application uses the service role for all data access.

## This is enforced, not just documented

`src/lib/supabase/grants.test.ts` queries the live database and fails if either role holds any table
privilege in `public`, or any column privilege beyond the two above. It is read-only, and it runs in
the normal test suite — it is deliberately **not** named `*.integration.test.ts`, because those wipe
the database and are excluded from every run.

If it fails after you write a migration, you almost certainly copied an old tail.

It shells out to `docker exec` against a container named by the `CONTAINER` constant, which defaults
to the local dev stack (`supabase_db_network-doc-platform`) so a plain test run is unchanged. Set
`GRANTS_TEST_CONTAINER` to point it at a different Postgres container instead — for example, at a
self-hosted deployment's `db` container after running its first migrations (`deploy/install.sh`
Step 4, or `docker compose -f deploy/docker-compose.yml ps -q db`). That is the only way to confirm
the anon/authenticated surface is actually closed on that stack, rather than only on this machine:

```bash
GRANTS_TEST_CONTAINER=<container name or id> ./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts
```

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
