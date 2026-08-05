# Activity Log (Slice H4) — Design

The feature that started the sequence. It could not be built until there was a *who* to attribute to,
which is why [authentication](./2026-08-04-authentication-design.md) came first and
[roles](./2026-08-04-users-and-permissions-design.md) came third. This is the fourth and last.

## 1. What it is

An automatic, read-only record of every change made in the app: who did it, what they did, to which
thing, when, and whether it succeeded. Any signed-in member can read it.

Three uses, in the order they will actually happen: *what changed here* after something looks wrong;
*who changed it* when the answer matters; and oversight of people who are new.

It is **read-only**. The original ask mentioned reverting to a previous state, but the destructive
case that motivated it — accidental deletion — is already solved: the archive slice made client, site
and floor deletion recoverable. Undoing arbitrary edits is a different, much larger feature (§9).

## 2. Where it is captured

`withMember` already resolves the acting member for every server action, and `withEditor` and
`withAdmin` compose on it. So capture lives there and nowhere else — one function, not a fourth pass
adding a logging call to sixty-one bodies that the sixty-second would forget.

**Logging is opt-OUT, not opt-in.** Every wrapped action is recorded unless it explicitly asks not to
be. The failure mode of that choice is a noisier log; the failure mode of opt-in is a change nobody
recorded, which is the one thing an audit trail must not do. Only two actions opt out —
`listTemplatesForTypeAction` and `getDeviceTemplateAction` — because they are pure reads that fire on
every device-library page load and would bury real entries.

Refusals are recorded too, marked distinctly. A viewer trying to delete a rack is precisely what an
audit trail exists to show, and the wrapper already knows the outcome, so it costs nothing.

## 3. Every action needs a name, and that means touching all of them

The wrapper cannot discover what it is wrapping. `withEditor(async (member, formData) => …)` receives
an anonymous function; there is no runtime handle on the `export const renameClientAction` it will be
assigned to. Without a name, every entry reads "a change was made", which is not worth building.

So each wrapper takes a stable machine key as its first argument:

```ts
export const renameClientAction = withEditor("client.rename", async (member, formData) => { … });
```

This is a third mechanical sweep over the same sixty-one actions, and it is worth it: the key is what
turns the table from a list of timestamps into something a foreman can read. Keys are
`resource.verb`, lower case, and stable — they are data, so renaming one orphans the history that
used it.

The key is machine-readable on purpose. Turning `client.rename` plus its arguments into *"Renamed
client ACME"* is done by a pure `summarise()` function, which is where readability lives and where it
can be tested without a database. An unrecognised key falls back to the key itself: a slightly ugly
entry, never a missing one.

## 4. The log must never store a secret

This is the property that matters most, and it is not hypothetical. `changePasswordAction` receives
`current`, `next` and `confirm` in its form data. `updateDeviceWizardSettings` receives the Gemini
API key. A wrapper that naively records its arguments writes a live password, and a paid API key,
into a table every member of the company can read.

So arguments are captured by **allowlist, per action key** — never a denylist. A denylist protects
against the fields someone thought of; the next secret field added to a form is logged by default and
nobody notices. An allowlist fails the other way: a new field is invisible until someone adds it, and
an invisible field is a gap in a report rather than a credential in a table.

Anything not on its action's allowlist is dropped before the entry is built. `password.change` and
`settings.deviceWizard.update` have empty allowlists — that an action occurred is the whole record.

## 5. Data

### `0026_activity_log.sql`

```sql
create table activity_log (
  id           uuid primary key default gen_random_uuid(),
  -- SET NULL, not CASCADE: deleting a member must never delete the evidence of what they did. The
  -- app only ever revokes, but a hard delete at the database would otherwise erase history silently.
  member_id    uuid references members (id) on delete set null,
  -- Snapshot, so an entry still says WHO even if the row above is gone. Denormalised on purpose.
  actor_email  text        not null,
  actor_name   text        not null default '',
  action       text        not null,               -- the stable key, e.g. 'client.rename'
  outcome      text        not null check (outcome in ('ok', 'refused', 'failed')),
  -- Allowlisted arguments only. See section 4 — this column must never receive a secret.
  details      jsonb       not null default '{}'::jsonb,
  error        text,                               -- the refusal or failure message, when not 'ok'
  created_at   timestamptz not null default now()
);

create index activity_log_created_idx on activity_log (created_at desc);
create index activity_log_member_idx  on activity_log (member_id, created_at desc);
create index activity_log_action_idx  on activity_log (action, created_at desc);
```

Three outcomes rather than a boolean: `ok`, `refused` (a role or rule said no) and `failed` (it was
allowed and broke). They mean different things to whoever is reading, and collapsing them loses the
distinction exactly when it matters.

The table gets the same grant treatment as `members`: re-narrowed after the blanket grant so `anon`
cannot read it. The log names people and what they touched; it is not public.

## 6. Logging must not break the thing it is logging

If the insert fails, the action still succeeds. An outage in the audit trail must not stop a foreman
saving a device, and the alternative — failing real work because a log write did not land — is worse
than a gap.

That gap is not silent: a failed insert is `console.error`ed server-side. This is the same fail-open
reasoning as the middleware's membership check, and it is written down here because it is a genuine
trade rather than an oversight. If the log ever becomes a compliance record rather than an
operational one, this is the decision to revisit.

Logging happens **after** the action resolves, never before — the entry records what happened,
including the outcome, so it cannot be written until there is one.

## 7. The screen

`/activity`, on the existing nav item, for any signed-in member. Newest first, paginated.

Each row: when, who, what (the rendered summary), and outcome. Refusals are visually distinct and
muted — present for the record, not competing with real changes.

Filters, combinable, matching what PatchDocs offers: **member**, **action**, **outcome**, and a
**date range**. The indexes in §5 exist for exactly these.

Everyone sees the whole feed. The point was tracking who does what across installers, foremen, PMs
and help desk, and a foreman checking what a tech changed on site is the main use — which fails if
only admins can look.

## 8. Testing

- **Pure** (`summarise.test.ts`): a known key with arguments renders readable text; an unknown key
  falls back to the key rather than throwing; a refusal renders differently from a success.
- **Redaction** (`redact.test.ts`): **the load-bearing test of the slice** — `password.change` yields
  `{}` even when handed `current`/`next`/`confirm`; `settings.deviceWizard.update` yields `{}` even
  when handed an `apiKey`; a key with no allowlist entry yields `{}` rather than everything. A test
  asserts that for every action key in the registry, no allowlisted field name matches
  `/pass|secret|token|key|code/i` — so the next person to add one is stopped by a test rather than by
  an incident.
- **Wrapper**: a successful action writes one entry with outcome `ok`; a refused one writes `refused`
  and the wrapped action still never ran; a throwing action writes `failed`; **an insert that throws
  does not fail the action** — the caller still gets its result.
- **Screen**: filters compose; a member with no entries renders an empty state rather than a blank
  page.
- **Live**: perform a rename, a refused write as a viewer, and an invite; confirm three entries with
  the right actors and outcomes, and confirm by direct SQL that **no entry contains a password or an
  API key**.
- Tests run by EXPLICIT FILENAME or with the three `--exclude` flags — the integration files wipe the
  local database.

## 9. Out of scope

Undo or revert of any kind (§1). Retention and trimming — the table grows unbounded, which is correct
until it is not; the index on `created_at` is what a future trim will use. Before-and-after values
for edits: the log records that a rename happened and what it was renamed to, not what it was called
before. Exporting the log. Logging reads. Alerting on refusals.
