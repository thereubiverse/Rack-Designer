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

## Functions and sequences had the same hole, and only a deployment showed it

`0027` closed the default privileges for **tables** and stopped there. Functions and sequences kept
theirs, and that gap was invisible on this machine, because the local Supabase CLI stack and a fresh
`supabase/postgres` image ship different defaults:

| | local CLI stack | fresh image (every real deployment) |
|---|---|---|
| `postgres` default ACL, functions | `postgres=X` | `postgres=X, anon=X, authenticated=X, service_role=X` |

So on a deployment — and only there — every function a migration creates is born with an explicit
`EXECUTE` grant to `anon` and `authenticated`. The `revoke all on function … from public` line that
`0029`, `0030` and `0031` each end with does **not** undo that: revoking from `PUBLIC` removes the
implicit world grant, and does nothing to an explicit grant held by the roles themselves.

Demonstrated against a real install, not inferred. A POST to `/rest/v1/rpc/consume_device_attempt`
carrying nothing but the publishable key returned:

```json
[{"code":"424242","expires_at":"…","attempts":1}]
```

`consume_device_attempt` is `security definer` and returns the device-approval code, so anyone
holding the publishable key — which is public by design — could read the emailed code for any
pending device and approve their own machine. The trusted-device factor was defeated end to end on
every fresh install while this machine showed nothing wrong.

`0032` closes it: the function and sequence defaults, plus the grants the missing default had already
produced on the two existing functions.

It also revokes `execute` on functions from `PUBLIC` by default. **That line does not work as a
backstop, and it was added believing it would.** Measured afterwards: a schema-scoped
`alter default privileges` is merged with Postgres's hard-wired default rather than replacing it, so
a brand-new function still comes out `=X/postgres, postgres=X, service_role=X` with
`has_function_privilege('anon', …)` true. Only a cluster-wide `alter default privileges` removes it,
and that reaches `auth` and `storage` too.

**So every new function still needs its own `revoke all on function … from public`,** exactly as
`0024` and `0029`–`0031` do it. There is no safety net for forgetting it except `grants.test.ts`,
which asks `has_function_privilege` and therefore sees PUBLIC grants.

`grants.test.ts` now asserts these defaults directly, in addition to the privileges on the functions
themselves. This is also the reason `GRANTS_TEST_CONTAINER` exists: a guard that can only ever look
at the development database will keep passing while the deployment is open.

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

## One organisation, until slice 2

The schema now permits a second organisation. **The application is not yet safe to have one.** Every
server action still queries without an organisation filter and with full service-role privileges —
enforcement is slice 2. **Do not create a second organisation, or open registration, until slice 2
lands.**

Concretely: the last-admin invariant is computed over every `members` row in the database, the member
role and disable writes key on member id alone, and the device-library writers insert `org_id NULL`,
which means "shared with every organisation". Full reasoning, including why the library writers and
the single-column foreign keys into the library are one slice-4 decision rather than three, is in
`docs/superpowers/specs/2026-08-06-multi-tenancy-data-model-design.md`.

## Every table is scoped to an organisation

This is not optional decoration on top of the schema; it is the mechanism that keeps one
organisation's data from being visible to, or colliding with, another's. If you add table 21, it
needs all five of the following, or it is silently unscoped:

1. **`org_id uuid not null references organisations(id)`.** Every row belongs to exactly one
   organisation. `not null` matters — a nullable `org_id` on an application table means some rows
   answer to no organisation at all, which is a hole, not an edge case. (The three library tables —
   `brands`, `device_templates`, `device_types` — are the deliberate exception: `NULL` there means
   "standard, shared by every organisation," a distinct and intentional meaning, not an omission.)

2. **`unique (org_id, id)`, only if something will reference this table.** This is what makes the
   table usable as the parent in a composite foreign key from a child table — see point 3. Without
   it, nothing downstream can reference this table's rows scoped to their organisation. If nothing
   ever will — a leaf table with no children — it needs no `unique (org_id, id)` of its own; adding
   one anyway is an index to maintain for no reason. `sites`, `racks`, `members`, `floors`, `rooms`,
   `rack_devices`, `trusted_devices` and `clients` have it because something references them
   compositely. `activity_log`, `app_settings`, `brands`, `connections`, `device_challenges`,
   `device_templates`, `device_types`, `floor_devices`, `floor_plans`, `phone_verifications` and
   `port_endpoints` correctly don't.

3. **An inheritance trigger, if the table has an org-scoped parent.** A child row's `org_id` must
   come from its parent, not from whatever the caller happens to pass — copy the pattern from
   `0035_org_id_triggers.sql`. And the foreign key to that parent must be a **composite** key,
   `(org_id, parent_id) references parent(org_id, id)`, not a single-column `parent_id` reference —
   a single-column FK lets a row point at a parent in a *different* organisation, which is exactly
   the cross-tenant link this whole design exists to prevent.

4. **`org_id` in every unique constraint that isn't already covered by an org-scoped parent.** A
   plain `unique (code)` rejects a second organisation's perfectly ordinary data — two organisations
   both having a client coded `ACME` is normal, not a conflict. Scope it: `unique (org_id, code)`.
   If the column's meaning allows a row to be shared across every organisation (as with the three
   library tables above), use `unique nulls not distinct (org_id, code)` instead of plain `unique` —
   plain `unique` treats every `NULL org_id` as distinct from every other, so two shared rows with
   the same name would both be silently accepted and the constraint would stop protecting the exact
   rows it exists for. This requires Postgres 15+ (this stack runs 17.6).

   Not every unique constraint needs this. If the table already hangs off an org-scoped parent —
   e.g. `sites(client_id, code)`, `racks(room_id, code)` — the parent's own `org_id` scoping already
   makes the row unreachable across organisations, so the child's constraint needs no `org_id` of
   its own. And two constraints are deliberately left global: `members.email` (one auth account,
   one member row) and `trusted_devices.token_hash` (a secret, where cross-org collision would be a
   real collision). See `0041_org_scoped_unique_constraints.sql` for the reasoning on both.

   Uniqueness declared as a bare `create unique index` counts too, and is easy to forget precisely
   *because* it counts: `pg_constraint` does not list it, so a check that only reads that catalogue
   will call the table clean while an unscoped index sits right next to it. `connections_edge_uniq`
   is the one example today, and it needs no `org_id` of its own for the same reason as point 4's
   parent-scoped constraints — it is already keyed by `rack_id`, an org-scoped parent.

5. **The `freeze_org_id` trigger, on every table from point 1 that carries an `id` column.**
   Point 1's `not null` and the inheritance trigger from point 3 only govern INSERT. Nothing stops a
   plain `UPDATE ... SET org_id = <another org>` afterwards, and if it succeeds the row moves to a
   new owner while every composite foreign key from point 3 still points at the old one — the wall
   point 3 builds has a door in it. `freeze_org_id` (`0035_org_id_triggers.sql`) is a `BEFORE UPDATE`
   trigger that raises when `new.org_id is distinct from old.org_id`; wire it up the same way the
   twelve existing `*_freeze_org` triggers do. Skip it and `org_id` is stamped correctly on the way
   in and free to move on the way out.

   The three library tables and `activity_log` are the deliberate exception, for the same reason
   they are nullable at point 1: a freeze trigger on `activity_log` would block the
   `ON DELETE SET NULL` that demotes a deleted member's log rows to platform-level events, and the
   library tables are not yet org-editable at all.

`src/lib/supabase/tenancy.test.ts` checks all of this against the live schema — every table has
`org_id`, every table that is referenced by another has `unique (org_id, id)`, every foreign key to
an org-scoped table is composite (and the full set of composite foreign keys is pinned by name and
definition, so a dropped or redefined one fails too), every child of an org-scoped parent carries an
enabled `inherit_org_id` trigger (with the parent table and foreign-key column it reads pinned as
trigger arguments, so one aimed at the wrong parent fails as well), every unique constraint and
primary key in `public` — bare index or named constraint — is pinned by name and definition as either
org-scoped or on the short, explicit exception list, and every table that can be updated after insert
carries `freeze_org_id`. Skip any of the five steps above and that test fails.

That last sentence was false until review caught it. Step 3 is two things — an inheritance trigger
*and* a composite foreign key — and only the foreign-key half was asserted; `inherit_org_id` appeared
in the guard as a word in a comment and in no query. Every trigger `0035` creates could have been
dropped with the suite still green. Both halves are checked now, and both checks ignore a trigger
left `DISABLE`d, because `alter table … disable trigger` keeps the `pg_trigger` row and a mere
existence check would call it present.
