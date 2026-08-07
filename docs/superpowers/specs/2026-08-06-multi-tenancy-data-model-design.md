# Multi-Tenancy, Slice 1: The Data Model

**Goal:** Give every row an owner, so that a second company can exist. Nothing else.

**Deliberately not in this slice:** row-level security, grant changes, self-serve registration,
per-org settings UI, the shared device library split, billing, a platform-owner console. Those are
slices 2 to 5. When this slice lands, the application behaves **exactly** as it does today and its
security posture is **unchanged** — still service-role access, still application-level checks. What
changes is that the schema can express "whose data is this", which is the part that gets more
expensive with every feature added and cannot be retrofitted cheaply later.

## Why this is separated from the enforcement work

Slice 2 makes the database refuse cross-company rows. That is the decision already taken, and it is
the right one for network documentation belonging to other people's infrastructure. But it is a
re-architecture: `authenticated` gains real table privileges, RLS constrains them, and all 53 files
that call `createServiceClient` change how they reach the database. `grants.test.ts` inverts from
"assert no grants exist" to "assert RLS covers every table".

None of that can begin until every row has an `org_id`. Doing them together produces one enormous
change where a mistake in the mechanical half is indistinguishable from a mistake in the security
half. Separated, this slice is verifiable by a single question — *does the app still work, and does
every row now have an owner?* — and can sit in production safely while slice 2 is designed.

## The shape of the data

Measured, not assumed. 19 tables, no tenancy column anywhere, and every table reaches a root by
foreign key:

```
organisations  (new)
├── clients ── sites ── floors ─┬─ rooms ── racks ── rack_devices ─┬─ connections
│                               │                                  └─ port_endpoints
│                               ├─ floor_plans
│                               └─ floor_devices
├── members ─┬─ trusted_devices ── device_challenges
│            ├─ phone_verifications
│            └─ activity_log
├── app_settings
└── (shared library) brands, device_types, device_templates
```

Two roots — `clients` and `members` — and everything else hangs beneath one of them. That is why a
tenancy column slots in rather than having to be threaded through the middle.

## Decisions

### Every table carries `org_id`, denormalised

The alternative is deriving ownership by joining up the chain — `connections` → `racks` → `rooms` →
`floors` → `sites` → `clients`. That works for a query written carefully today and fails as an RLS
policy tomorrow: a policy containing a five-table join is both slow on every row and easy to get
subtly wrong. Slice 2's policies must be one-liners, and that requires the column to be present.

- **`org_id uuid not null`** on 15 tenant tables: `clients`, `sites`, `floors`, `rooms`,
  `racks`, `rack_devices`, `connections`, `port_endpoints`, `floor_devices`, `floor_plans`,
  `members`, `trusted_devices`, `phone_verifications`, `device_challenges`, `app_settings`.
- **`org_id uuid null` on `activity_log`**, which was originally in the list above and should not
  have been. `activity_log.member_id` is nullable and `src/features/activity/authLog.ts` passes
  `memberId ?? null`, because **a refused sign-in from an address belonging to nobody has no
  member — and therefore no organisation.** Forcing not null would make that insert fail and
  silently destroy the sign-in-refusal audit trail, which is one of the reasons this table exists.
  NULL here means "a platform-level event belonging to no organisation"; slice 2's policies leave
  those rows invisible to every tenant, which is correct — they are the operator's business, not a
  customer's. Found by review, after the first draft of this spec asserted otherwise.
- **`org_id uuid null`** on the 3 library tables: `brands`, `device_types`, `device_templates`.
  **NULL means "standard, shared by every organisation"**; a value means "created by, and private
  to, that organisation". All 24 existing `device_types` (`is_standard = true`), 4 brands and 6
  templates become NULL — shared. Slice 4 builds the UI for custom entries; adding the column now
  costs one line and saves migrating three tables again later.

### A wrong `org_id` is made impossible, not merely avoided

A denormalised column drifts. Two mechanisms, because they do different jobs:

**Composite foreign keys carry the org through every relationship.** Each parent gains
`unique (org_id, id)`, and each child's foreign key becomes composite:

```sql
alter table sites add constraint sites_client_fk
  foreign key (org_id, client_id) references clients (org_id, id);
```

Attaching a site to a client in another organisation now fails in the database, whatever the
application says. This is the same enforcement principle already used for grants — the check lives
where it cannot be bypassed, not in a comment.

**A trigger derives `org_id` from the parent on insert.** Composite keys reject a wrong value but do
not supply a right one. A `before insert` trigger on each child table copies `org_id` from the row it
hangs off. Consequences worth stating plainly:

- The application only ever supplies `org_id` in three places: creating a client, creating a member,
  and writing a setting. The first two are the roots of the hierarchy; `app_settings` is the third
  because it hangs off no parent row at all, so there is nothing for a trigger to read. Every other
  insert is untouched. (For scale: `src/` exports 141 async functions across 15 `"use server"` files,
  and 53 files reach the database through `createServiceClient`. Leaving that surface alone is the
  entire point of the trigger design.)
- `org_id` becomes non-updatable on child tables (a `before update` guard raises if it changes),
  because "move this rack to another company" is not an operation this product has.

### Unique constraints that are wrong the moment a second company exists

Five unique constraints and one primary key are global today and must become org-scoped. Two IT firms
both having a client coded `ACME` is ordinary, not a conflict:

| Constraint | Becomes |
|---|---|
| `clients_code_key (code)` | `unique (org_id, code)` |
| `brands_name_key (name)` | `unique nulls not distinct (org_id, name)` |
| `device_templates_name_key (name)` | `unique nulls not distinct (org_id, name)` |
| `device_types_code_key (code)` | `unique nulls not distinct (org_id, code)` |
| `device_types_category_name_key (category, name)` | `unique nulls not distinct (org_id, category, name)` |
| `app_settings` primary key `(key)` | primary key `(org_id, key)` |

`nulls not distinct` is load-bearing on the library tables and requires Postgres 15+; this runs 17.6.
Without it Postgres treats every NULL as unique, so two shared brands both named `Cisco` would both
be permitted — the constraint would silently stop constraining exactly the rows it exists to protect.

Nine other unique constraints — `sites (client_id, code)`, `floors (site_id, code)`,
`rooms (floor_id, code)`, `racks (room_id, code)`, `rack_devices (rack_id, code)`,
`floor_devices (site_id, code)`, `floor_plans (floor_id)`, `port_endpoints (rack_device_id, …)`,
`connections (rack_id, …)` — are already scoped by an org-scoped parent and need no change.

**`trusted_devices.token_hash` stays globally unique.** It is a secret, and a collision across
organisations would be a real collision, not a naming coincidence.

### One email, one organisation — a deliberate limitation

`members.email` **stays globally unique.** Supabase's `auth.users` permits one account per email
address, and this app links `members.auth_user_id` to it one-to-one. Making `members.email` unique
per org would let two member rows exist for one email while only one of them could ever sign in —
worse than the restriction it removes.

The visible consequence: a consultant working for two firms on the platform cannot use one address
for both, and registration must refuse an email already in use anywhere with a clear message rather
than a database error. Lifting it means decoupling members from auth users, which is its own piece of
work and is not justified before anyone asks.

### Storage becomes org-namespaced

Floor plans are written to `floor-plans/{siteId}/{floorId}.png`, the source PDF alongside as `.pdf`,
and avatars to the `avatars` bucket. None carry the organisation.

New layout: **`{orgId}/` prefixed on every object in both buckets.** Slice 2's storage policies key on
the first path segment, so without this there is no way to express "this org's files" — and storage
policies cannot be written retrospectively over objects already scattered without a prefix.

This is the only part of the slice that touches data outside Postgres, and the only part that cannot
be rolled back by reverting a migration. It requires a one-off script that, for every existing object:
copies it to the new path, updates `floor_plans.storage_path`, `floor_plans.pdf_storage_path` and
`members.avatar_path`, verifies the new object is readable and byte-identical, and only then removes
the old one. It must be re-runnable, and it must not delete anything it has not first confirmed it can
read back — the same rule the backup work arrived at the hard way.

### `app_settings` becomes per-organisation

Two keys exist: `device_wizard.enabled` and `device_wizard.gemini_api_key`. Both are per-company
settings — one firm enabling the Device Wizard, or paying for its own Gemini key, should not decide
that for another. The primary key becomes `(org_id, key)` and both existing rows are assigned to
QTSI. The platform-level `GEMINI_API_KEY` environment variable already present in
`deploy/docker-compose.yml` remains the fallback when an org has set no key of its own.

### Backfill

One migration creates the `organisations` row for **QTSI**, stamps it onto every existing row, and
only then applies `not null`. Ordering matters: `not null` before the backfill fails on the first
table with rows in it, and the local database holds real data (3 clients, 31 sites, 1 rack, 2 members,
8 activity entries).

## What changes in the application

Deliberately small, because the triggers do the work:

1. **`withMember` resolves the org.** It is already the single point where a member is resolved for
   every action; it gains `orgId` on the context it passes through. `withEditor` and `withAdmin` are
   built on it and inherit this for free.
2. **The two root writes supply `org_id`** — creating a client, and creating a member (invite).
3. **Storage path builders take an org id** — `planStorage.ts` and `avatarStorage.ts`.

Nothing else. If a fourth thing needs changing, that is a signal the trigger design is wrong and worth
stopping over rather than working around.

## How this is verified

**A schema guard, in the manner of `grants.test.ts`** — read-only, queries the live catalogue, runs in
the normal suite, and fails when someone adds a table without thinking about tenancy. It asserts:

- every table in `public` has an `org_id` column;
- the 16 tenant tables have it `not null`, and the 3 library tables permit NULL;
- every parent-child foreign key includes `org_id` (no single-column FK to an org-scoped parent
  survives);
- the six org-scoped unique constraints exist, and the library ones are `nulls not distinct`;
- `members.email` and `trusted_devices.token_hash` remain globally unique, so the two deliberate
  exceptions are pinned rather than remembered.

This is the piece that makes the slice durable. Without it, table 20 arrives without an `org_id` and
nobody notices until slice 2's policies have a hole.

**Behaviour is unchanged, and that is testable.** The existing suite must pass untouched. Beyond it:

- Apply the migrations to a throwaway stack via `deploy/install.sh`, then replay them against a copy
  of the real data — the local database has genuine content, so a migration that works on an empty
  schema proves little.
- Create a *second* organisation by hand, give it a client with the code `ACME` while QTSI also has
  one, and confirm both are accepted. That is the whole point of the slice and takes one SQL
  statement to check.
- Attempt to attach one org's site to another org's client and confirm the database refuses it.
- Run the storage migration against real uploaded plans, and confirm every plan still renders in the
  app afterwards — the app reads `storage_path` from the row, so a mismatch shows up as a broken
  floor plan rather than an error.

**Never run vitest against a directory or glob** — `*.integration.test.ts` files wipe the local
database, which holds this real data. Named files only.

## Risks

**The storage move is one-way.** Reverting a migration restores the schema; it does not put objects
back. The script must verify before deleting, and a backup must be taken first — `deploy/backup.sh`
now captures both halves and has been proven to restore.

**The trigger design is the load-bearing assumption.** It is what keeps this slice from touching 141
functions. If some insert path bypasses the parent relationship — a bulk import, a data fix applied
directly in SQL — it will hit the `not null` and fail loudly rather than write an unowned row. That is
the correct failure, but it should be expected rather than surprising.

**`device_challenges` is keyed by `device_id`, not by an org-scoped parent.** It inherits through
`trusted_devices`. Worth checking during implementation that its trigger reaches the org correctly,
since it is the one table two hops from its root.
