# Multi-Tenancy, Slice 2: Database-Enforced Isolation

**Goal:** Make a cross-organisation query return nothing, enforced by Postgres, so that isolation
stops depending on every one of 141 server functions being written correctly.

**What this closes.** Slice 1 gave every row an owner and made a cross-organisation *reference*
impossible. It did not stop a *query* from reading another organisation's rows — every data access
still goes through `createServiceClient()`, and `service_role` carries `bypassrls` (verified in the
catalogue). Today one forgotten `.eq("org_id", …)` is a leak with nothing underneath it. That is
tolerable with one company on the system and is the reason the spec for slice 1 ends with a gate:
**do not create a second organisation until this slice lands.**

**Deliberately not in this slice:** self-serve registration, per-org settings UI, the shared device
library split, billing, a platform-owner console.

## The mechanism

Everything in this app queries Supabase from the **server**. There is no `createBrowserClient`
anywhere — checked. That single fact makes a better design available than the conventional one.

The usual Supabase pattern grants `authenticated` real table privileges and constrains them with
policies. But `authenticated` is the role a *browser* reaches PostgREST as, so that would turn
`/rest/v1` into a live API for every signed-in user — a genuine increase in attack surface, bought
for a capability this app does not use, and one that migrations `0027`, `0028` and `0032` were
written to close.

Instead:

1. **A dedicated role, `app_tenant`** — DML on the tenant tables, `NOBYPASSRLS`, granted to
   `authenticator` so PostgREST can switch into it. It cannot log in directly.
2. **A short-lived token, minted per request by the server.** After the member is resolved — which
   already checks `disabled_at` — the server signs an HS256 token carrying `role: app_tenant` and
   `org_id`, using the `JWT_SECRET` the stack already has. **`exp` is 60 seconds**: long enough to
   outlast any single request including a slow plan upload, short enough that a token captured from
   a log or a crash dump is useless before anyone can act on it. It is minted once per request and
   reused for every query in that request, not once per query — signing is cheap, but not free.
3. **Policies read the organisation from the token**, through one helper so there is a single place
   to change:

```sql
create function current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'org_id', '')::uuid
$$;
```

`current_setting(..., true)` returns NULL rather than raising when the setting is absent, so a
request with no claim, or a token carrying no `org_id`, yields NULL — and `org_id = NULL` is never
true. **The failure mode is no rows, not all rows.** That is the property this whole slice rests on
and it must be tested directly, not assumed.

### Why this is better here than the conventional pattern

- **`anon` and `authenticated` keep zero privileges.** The public REST surface stays exactly as
  closed as it is today. Nothing a browser holds can reach the database.
- **No per-row lookup.** The organisation is a constant in the query, not a subquery against
  `members`.
- **Revocation is immediate.** The token is minted *after* the membership check, and expires in a
  minute regardless — unlike a claim stamped into the user's own access token at sign-in, which
  would keep a revoked engineer working until it expired.
- **One place to get wrong instead of 141.** The risk moves from "every action remembers its
  filter" to "the mint is correct", which is a single function with a single test.

### What it costs

`JWT_SECRET` must reach the app. It currently does not: `deploy/docker-compose.yml` passes the app
`NEXT_PUBLIC_SUPABASE_URL`, `ANON_KEY` and `SERVICE_ROLE_KEY`, but not the secret those were signed
with. That is a deployment change (compose, `.env.example`, and `.env.local` for development), and
it means the app container holds a credential that can mint any role — including `service_role`. It
already holds `SERVICE_ROLE_KEY`, so this grants no new power, but it is worth stating plainly
rather than discovering later.

## The database side lands inertly

Nobody can obtain an `app_tenant` token without `JWT_SECRET`, which lives only on the server. So
creating the role, granting it privileges, and enabling policies on all 19 tables changes **nothing
observable** until the application starts minting tokens. The database half can therefore land,
be proven, and sit in production while the application half is done incrementally.

This is the same shape as slice 1, for the same reason: it separates the part that is mechanical and
provable from the part that can break the app, so a failure in one is not mistaken for the other.

## Policy shapes

Three kinds of table, three shapes:

**The 15 tenant tables** — `org_id` is `not null`:

```sql
alter table clients enable row level security;
create policy clients_tenant on clients for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());
```

`with check` matters as much as `using`: without it an insert or update could *write* a row into
another organisation while being unable to read it back.

**`activity_log`** — `org_id` is nullable, meaning "a platform event belonging to no organisation",
such as a sign-in refused for an address belonging to nobody. `org_id = current_org_id()` is false
for NULL, so those rows are invisible to every tenant with no special case. That is the intended
outcome; the operator reads them through the service role.

**The 3 library tables** — NULL means "standard, shared by every organisation":

```sql
using (org_id is null or org_id = current_org_id())
```

Note this deliberately lets a tenant *read* shared rows and not write them; the write side of the
library split belongs to slice 4, along with making the foreign keys into it composite.

**`force row level security` is not used.** It would also constrain the table owner, `postgres`,
which is who migrations run as — so a future migration would silently see no rows. `app_tenant` is
not the owner, so ordinary RLS binds it fully.

## What stays on the service role, and why

Some work genuinely happens before an organisation is known. That list must be short, explicit, and
enforced rather than remembered:

| Path | Why it cannot be tenant-scoped |
|---|---|
| `src/features/auth/members.ts` — `getCurrentMember` | Resolves the member *from* the session email. It is what discovers the organisation, so it cannot already have one. |
| `src/features/activity/authLog.ts` | Records sign-in refusals for addresses that belong to nobody — no member, no organisation. |
| `src/features/devices/actions.ts` | The trusted-device flow runs before the device is trusted, and `consume_device_attempt` is already `security definer` and service-role-only. |
| `src/features/auth/authActions.ts` | Sign-in and sign-out, either side of a session existing. |
| `src/lib/supabase/server.ts` | Defines the client. |
| `deploy/install.sh` | Creates the first member and organisation before anything exists. Outside the app. |

Everything else moves to a tenant-scoped client. Measured: **29 files import
`createServiceClient` today**, four of them are the allowlist above, so **25 move** — including all
13 page components.

**This is enforced.** A guard test lists the files permitted to import `createServiceClient` and
fails when any other does. It starts at 29 and shrinks to four. That is the same
enforce-don't-document approach as `grants.test.ts` and `tenancy.test.ts`, and it is what stops the
next feature quietly reaching for the service role because it was easier.

## Storage

Objects are namespaced by organisation as of slice 1 — `{orgId}/{siteId}/{floorId}.png`. Both
buckets are private and every URL is signed server-side.

Storage policies on `storage.objects` keyed on the leading path segment give the same
database-enforced property for files that the table policies give for rows. This is worth doing and
is the reason the namespacing exists — but it is genuinely defence in depth here, because the path is
derived from a row that RLS already governs. If it proves awkward, it is the part to defer, and the
spec says so rather than letting it silently drop.

## Proof before anything is built on it

**The first task is a spike, not a migration.** The design assumes PostgREST will switch to a role
named in a custom JWT claim, and that a policy can read another custom claim from
`request.jwt.claims`. Both are documented behaviour; neither has been verified on *this* stack.

Prove, on a throwaway install: mint a token with `role: app_tenant` and an `org_id`; confirm
PostgREST authenticates as that role; confirm `current_org_id()` returns the claim; confirm a select
returns only that organisation's rows; confirm a token with no `org_id` returns **nothing**; and
confirm an insert naming another organisation is refused by `with check`.

If PostgREST will not honour the custom role claim, this design does not work and the fallback is
the conventional pattern — grant `authenticated`, look the member up from `auth.uid()`, and accept
the wider REST surface. Finding that out in an hour is cheap; finding it out after writing 19
policies and moving 25 files is not.

## How this is verified

**A policy guard, in the manner of the existing two** — read-only, live-database, in the normal
suite. It asserts that RLS is enabled on every table carrying an `org_id`, that each has a policy
for `app_tenant` with both `using` and `with check`, that `app_tenant` holds no privilege on any
table lacking a policy, and that `anon` and `authenticated` still hold nothing at all.

**A cross-tenant test that actually tries.** Two organisations, two tokens, and an attempt to read
and to write across the wall — asserting empty results and refused writes, not merely that the
policies exist. The lesson from slice 1 is that a guard comparing lists stays green when the thing
it guards is deleted, so at least one assertion must exercise the behaviour rather than the
catalogue.

**The existing suites must stay green throughout.** Each file moved to the tenant client is a
behaviour change with a real chance of returning nothing where it used to return rows — which looks
like an empty page, not an error. The page components are the risky ones, because they have the
least test coverage.

## Risks

**A file left on the service role is silently unprotected.** It keeps working, so nothing draws
attention to it. The guard's shrinking list is the only thing that makes the remainder visible.

**An empty result is indistinguishable from "no data".** If the mint is wrong, or a claim is
missing, pages render as though the organisation has nothing in it. The fail-closed property is
correct, but it means testing must assert that *expected rows appear*, not merely that nothing
errored.

**The app container gains `JWT_SECRET`.** It can then mint any role, including `service_role`. It
already holds the service-role key, so nothing is newly exposed — but a future decision to remove
that key would not, on its own, reduce the app's power.

**Migrations continue to run as `postgres`**, which bypasses RLS because it owns the tables. That is
deliberate and necessary, and it means a migration can still write across organisations. The
composite foreign keys from slice 1 remain the constraint that governs migrations.
