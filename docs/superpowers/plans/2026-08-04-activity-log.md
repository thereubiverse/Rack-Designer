# Activity Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An automatic, read-only record of every change made in the app — who, what, when, and whether it succeeded — readable by any signed-in member at `/activity`.

**Architecture:** Capture happens once, inside `withMember`, which every server action already passes through. Each action supplies a stable key (`client.rename`). Arguments are captured by allowlist per key so a secret can never reach the table. Rendering the key into readable text is a pure function, tested without a database.

**Tech Stack:** Next.js 16 (app router, server actions), TypeScript strict, Supabase (local via Docker), Vitest + @testing-library/react, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-04-activity-log-design.md`

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** Files named `*.integration.test.ts` WIPE THE LOCAL DATABASE, which holds real data. Run named files only, or: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package. **The branch must be tsc-clean at every commit.**
- Use `command grep`, not bare `grep`. Quote globs: `--include='*.ts'`.
- Piping SQL into psql REQUIRES `docker exec -i`. Container: `supabase_db_network-doc-platform`.
- Every migration ends with the three blanket grants from `0001_location_hierarchy.sql`'s tail, byte-identical, **and then re-applies the narrowings** — read the tail of `supabase/migrations/0025_member_roles.sql` and copy the whole thing. The blanket grant re-opens what 0020, 0022 and 0023 closed. Latest migration is 0025.
- **Postgres grants EXECUTE on new functions to PUBLIC** — revoking from `anon, authenticated` alone does nothing.
- NEVER put a real secret in a git-tracked file, a test fixture, or a log entry.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Forms use `onSubmit` + `e.preventDefault()` + `new FormData(e.currentTarget)`, NEVER `<form action={fn}>`.
- Every exported function in a `"use server"` module must be wrapped in `withMember`, `withEditor` or `withAdmin`.

---

### Task 1: Migration — the log table

**Files:**
- Create: `supabase/migrations/0026_activity_log.sql`

- [ ] **Step 1: Read the tail you must copy**

`tail -20 supabase/migrations/0025_member_roles.sql` — copy its grant-and-narrow tail verbatim, and
add one more revoke for the new table.

- [ ] **Step 2: Write the migration**

```sql
-- Who did what, when. Written by withMember after every action resolves; never written by hand.
create table activity_log (
  id           uuid primary key default gen_random_uuid(),
  -- SET NULL, not CASCADE: deleting a member must never delete the evidence of what they did.
  member_id    uuid references members (id) on delete set null,
  -- Snapshot, so an entry still says WHO even if the row above is gone. Denormalised on purpose.
  actor_email  text        not null,
  actor_name   text        not null default '',
  action       text        not null,
  outcome      text        not null check (outcome in ('ok', 'refused', 'failed')),
  -- ALLOWLISTED arguments only — see redact.ts. This column must never receive a password, an API
  -- key, or a verification code. If you are adding a field here, read the spec's section 4 first.
  details      jsonb       not null default '{}'::jsonb,
  error        text,
  created_at   timestamptz not null default now()
);

-- The three filters the screen offers, each newest-first.
create index activity_log_created_idx on activity_log (created_at desc);
create index activity_log_member_idx  on activity_log (member_id, created_at desc);
create index activity_log_action_idx  on activity_log (action, created_at desc);
```

then the tail copied from 0025, plus, as the very last line:

```sql
revoke all on activity_log from anon, authenticated;
```

- [ ] **Step 3: Apply, then verify — four probes**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0026_activity_log.sql
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "\d activity_log"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select * from activity_log;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select disabled_at from members;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "insert into activity_log (actor_email, action, outcome) values ('x@y.z','t','bogus');"
```
Expected: the table with three indexes; **permission denied**; **succeeds** (the middleware needs it);
the insert **FAILS** on the outcome check constraint.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0026_activity_log.sql
git commit -m "Add the activity log table

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Redaction — the load-bearing task

**Files:**
- Create: `src/features/activity/redact.ts`
- Test: `src/features/activity/redact.test.ts`

**Interfaces:**
```ts
export const LOGGED_FIELDS: Readonly<Record<string, readonly string[]>>;
export const MAX_VALUE_LENGTH: number;   // 200
export function redact(action: string, raw: unknown): Record<string, string>;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { redact, LOGGED_FIELDS, MAX_VALUE_LENGTH } from "./redact";

describe("redact", () => {
  it("keeps only the fields its action allows", () => {
    expect(redact("client.rename", { id: "c1", code: "ACME", name: "Acme", secretSauce: "x" }))
      .toEqual({ code: "ACME", name: "Acme" });
  });

  it("NEVER records a password, even though the form carries three of them", () => {
    // changePasswordAction receives current/next/confirm. This is the whole reason redaction is an
    // allowlist: the log is readable by every member of the company.
    expect(redact("password.change", { current: "hunter2", next: "s3cret", confirm: "s3cret" }))
      .toEqual({});
  });

  it("NEVER records the Gemini API key", () => {
    expect(redact("settings.deviceWizard.update", { apiKey: "AIza-live-key", enabled: "true" }))
      .toEqual({});
  });

  it("NEVER records a phone verification code", () => {
    expect(redact("phone.confirm", { code: "123456" })).toEqual({});
  });

  it("records NOTHING for an action it does not know, rather than everything", () => {
    // The safe direction: an unknown action is a gap in a report, not a credential in a table.
    expect(redact("some.action.added.later", { anything: "at all", password: "leak" })).toEqual({});
  });

  it("survives being handed something that is not an object", () => {
    for (const junk of [null, undefined, "str", 7, []]) {
      expect(redact("client.rename", junk)).toEqual({});
    }
  });

  it("stringifies and truncates, so one pasted essay cannot bloat the table", () => {
    const long = "x".repeat(MAX_VALUE_LENGTH + 50);
    const out = redact("client.rename", { code: long, name: 42 });
    expect(out.code).toHaveLength(MAX_VALUE_LENGTH);
    expect(out.name).toBe("42");
  });

  it("omits absent fields rather than writing empty strings", () => {
    expect(redact("client.rename", { code: "ACME" })).toEqual({ code: "ACME" });
  });
});

describe("the allowlist itself", () => {
  // A guard against the next person adding a field without thinking. Note `code` is deliberately NOT
  // in this list: a client/site/floor code is a short public identifier like ACME, and logging it is
  // the point. The phone verification code is kept out by `phone.confirm` having an EMPTY allowlist,
  // asserted separately below — a name-based rule cannot tell those two `code`s apart.
  const FORBIDDEN = /^(password|current|next|confirm|apikey|api_key|token|secret|auth|credential)$/i;

  it("allows no field whose name is a known secret", () => {
    for (const [action, fields] of Object.entries(LOGGED_FIELDS)) {
      for (const f of fields) {
        expect(FORBIDDEN.test(f), `${action} allows "${f}"`).toBe(false);
      }
    }
  });

  it("keeps the three secret-carrying actions completely empty", () => {
    for (const action of ["password.change", "settings.deviceWizard.update", "phone.confirm"]) {
      expect(LOGGED_FIELDS[action], `${action} must be present and empty`).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** `./node_modules/.bin/vitest run src/features/activity/redact.test.ts`

- [ ] **Step 3: Implement**

```ts
/** What may be written into an activity entry, per action. PURE.
 *
 *  This is an ALLOWLIST and must stay one. A denylist protects only against the field names someone
 *  thought of; the next secret field added to a form is logged by default and nobody notices. An
 *  allowlist fails the other way — a new field is invisible until someone adds it, and a gap in a
 *  report is a far better failure than a live credential in a table every member can read. */

export const MAX_VALUE_LENGTH = 200;

/** Empty array = "record that it happened, and nothing about it". Absent key = the same, by default.
 *  Every action that carries a secret MUST appear here with an empty array, so the intent is stated
 *  rather than relying on someone never adding it. */
export const LOGGED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // Clients and locations
  "client.create": ["code", "name"],
  "client.rename": ["code", "name"],
  "client.archive": ["id"],
  "client.restore": ["id"],
  "site.create": ["code", "name", "address"],
  "site.rename": ["code", "name", "address"],
  "site.archive": ["id"],
  "site.restore": ["id"],
  "site.locate": ["id"],
  "floor.create": ["code", "name"],
  "floor.rename": ["code", "name"],
  "floor.archive": ["id"],
  "floor.restore": ["id"],
  "floor.delete": ["id"],
  "room.create": ["code", "name", "type"],
  "room.rename": ["code", "name", "type"],
  "room.delete": ["id"],
  "room.polygon.set": ["id"],
  "room.polygon.clear": ["id"],
  "floorDevice.create": ["code", "name", "typeId"],
  "floorDevice.update": ["code", "name", "typeId"],
  "floorDevice.delete": ["id"],
  "floorDevice.place": ["id"],
  "floorDevice.clearPlacement": ["id"],
  "floorPlan.upload": ["floorId"],
  "floorPlan.delete": ["floorId"],
  "rack.create": ["code", "name"],
  "rack.update": ["code", "name"],
  "rack.delete": ["id"],
  "rack.place": ["id"],
  "rack.clearPlacement": ["id"],
  "rack.layout.save": ["rackId"],
  "rack.connections.save": ["rackId"],
  "rack.endpoints.save": ["rackId"],

  // Device library
  "deviceTemplate.create": ["name"],
  "deviceTemplate.update": ["name"],
  "deviceTemplate.delete": ["id"],
  "deviceTemplate.duplicate": ["id"],
  "brand.create": ["name"],
  "brand.delete": ["id"],
  "deviceType.create": ["code", "name"],
  "deviceType.save": [],
  "deviceType.delete": ["id"],

  // AI — the inputs are floor/plan ids; the outputs are not logged.
  "ai.discoverRooms": ["floorId"],
  "ai.discoverDevices": ["floorId"],
  "ai.discoverSymbols": ["floorId"],
  "ai.extractGeometry": ["floorId"],
  "ai.detectPorts": [],
  "ai.identifyDevice": ["modelName"],

  // Members
  "member.invite": ["email", "name", "role"],
  "member.setRole": ["id", "role"],
  "member.setActive": ["id", "active"],

  // Own profile
  "profile.update": ["name", "position"],
  "profile.avatar.upload": [],
  "profile.avatar.remove": [],
  "phone.sendCode": [],

  // SECRET-CARRYING. These stay empty. That the action happened is the entire record.
  "password.change": [],
  "settings.deviceWizard.update": [],
  "phone.confirm": [],
};

export function redact(action: string, raw: unknown): Record<string, string> {
  const allowed = LOGGED_FIELDS[action];
  // Unknown action: record nothing about it. Defaulting to "everything" here would mean any action
  // added later logs its whole payload, secrets included, until someone notices.
  if (!allowed || allowed.length === 0) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};

  const source = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of allowed) {
    const value = source[field];
    if (value === undefined || value === null || value === "") continue;
    out[field] = String(value).slice(0, MAX_VALUE_LENGTH);
  }
  return out;
}
```

- [ ] **Step 4: Run the tests.** Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit.**

---

### Task 3: Rendering an entry into English

**Files:**
- Create: `src/features/activity/summarise.ts`
- Test: `src/features/activity/summarise.test.ts`

**Interfaces:**
```ts
export interface Describable { action: string; details: Record<string, string>; outcome: "ok" | "refused" | "failed" }
export function summarise(e: Describable): string;
export function actionLabel(action: string): string;
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { summarise, actionLabel } from "./summarise";

const ok = (action: string, details: Record<string, string> = {}) =>
  summarise({ action, details, outcome: "ok" as const });

describe("summarise", () => {
  it("names the thing that changed when the details carry it", () => {
    expect(ok("client.rename", { code: "ACME", name: "Acme Corp" })).toContain("ACME");
    expect(ok("client.rename", { code: "ACME", name: "Acme Corp" })).toMatch(/renamed/i);
  });

  it("still reads sensibly with no details at all", () => {
    const s = ok("password.change");
    expect(s).toMatch(/password/i);
    expect(s.length).toBeGreaterThan(0);
  });

  it("falls back to the key for an action it does not know, rather than throwing", () => {
    expect(ok("some.action.added.later")).toContain("some.action.added.later");
  });

  it("reads differently for a refusal than for a success", () => {
    const a = summarise({ action: "client.rename", details: { code: "ACME" }, outcome: "ok" });
    const b = summarise({ action: "client.rename", details: { code: "ACME" }, outcome: "refused" });
    expect(a).not.toBe(b);
    expect(b).toMatch(/not allowed|refused|denied/i);
  });

  it("marks a failure as attempted, not done", () => {
    const s = summarise({ action: "client.rename", details: {}, outcome: "failed" });
    expect(s).toMatch(/tried|failed|attempt/i);
  });
});

describe("actionLabel", () => {
  it("gives a short human label for the filter menu", () => {
    expect(actionLabel("client.rename")).toMatch(/client/i);
    expect(actionLabel("unknown.key")).toBe("unknown.key");
  });
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement**

Create `src/features/activity/summarise.ts`. PURE — no database, no React.

A `VERBS` map from action key to `{ verb: string; noun: string }`, e.g.
`"client.rename": { verb: "Renamed", noun: "client" }`. Cover every key present in
`LOGGED_FIELDS` (import it and let a test assert full coverage is unnecessary — the fallback handles
gaps, and duplicating the list is worse than a graceful default).

`summarise` composes: the verb, the noun, and the best available identifier from `details` — prefer
`code`, then `name`, then `email`, then nothing. Then it adjusts for outcome:
- `ok` → `"Renamed client ACME"`
- `refused` → `"Not allowed to rename client ACME"`
- `failed` → `"Tried to rename client ACME"`

An unknown key renders the key itself with the same outcome treatment, so an entry is never blank.

`actionLabel` returns the noun-and-verb pair for the filter dropdown, or the raw key when unknown.

- [ ] **Step 4: Run the tests, typecheck, commit.**

---

### Task 4: The repository

**Files:**
- Create: `src/features/activity/repository.ts`

**Interfaces:**
```ts
export interface ActivityEntry { id, actorEmail, actorName, action: string; memberId: string | null; outcome: "ok"|"refused"|"failed"; details: Record<string,string>; error: string | null; createdAt: string }
export interface ActivityFilter { memberId?: string; action?: string; outcome?: string; from?: string; to?: string; limit?: number; offset?: number }
export async function writeEntry(db, e: Omit<ActivityEntry, "id" | "createdAt">): Promise<void>;
export async function listEntries(db, f: ActivityFilter): Promise<{ entries: ActivityEntry[]; total: number }>;
export async function listActors(db): Promise<{ id: string; name: string; email: string }[]>;
```

`import "server-only"`, house error style. `listEntries` applies only the filters present, orders
`created_at desc`, and uses `{ count: "exact" }` for `total`. Default `limit` 50, cap it at 200 so a
crafted request cannot ask for the whole table.

- [ ] Typecheck and commit.

---

### Task 5: Capture inside the wrapper

**Files:**
- Modify: `src/features/auth/withMember.ts`
- Test: `src/features/auth/withMemberLogging.test.ts`

**The signature changes.** All three wrappers take a stable key first:

```ts
export function withMember<A extends unknown[], R>(
  key: string,
  action: (member: Member, ...args: A) => Promise<R>,
  opts?: { log?: boolean }
): (...args: A) => Promise<R | { ok: false; error: string }>;
```
`withEditor(key, action, opts)` and `withAdmin(key, action, opts)` mirror it.

**Rules, all of which have tests:**

1. Logging happens **after** the action resolves — the entry records the outcome, so it cannot be
   written before there is one.
2. **A failed log write must not fail the action.** Wrap the write in try/catch and `console.error`.
   An outage in the audit trail must not stop someone saving their work.
3. **No member → no entry.** The refusal still returns, but there is nobody to attribute it to and
   `actor_email` is NOT NULL. Unattributable pokes are the middleware's business.
4. Outcome mapping:
   - the action threw → `failed`, `error` = the message
   - the result is `{ ok: false }` whose error is `NEEDS_EDITOR` or `NEEDS_ADMIN` → `refused`
   - any other `{ ok: false }` → `failed` with its error
   - anything else → `ok`
5. `opts.log === false` skips the write entirely (the two pure reads).
6. The details come from `redact(key, firstArgAsPlainObject)`. The first argument is usually
   `FormData`; convert with `Object.fromEntries(fd.entries())` **before** redacting, and pass a plain
   object straight through when it is not FormData. A `File` value must not be stringified into the
   log — drop any value that is not a string or number during that conversion.

- [ ] **Step 1: Write `withMemberLogging.test.ts`** covering every rule above, mocking
  `./members`' `getCurrentMember` and the activity repository. The load-bearing ones: rule 2 (throwing
  writer, action still returns its result) and rule 3.

- [ ] **Step 2: Run it and watch it fail. Step 3: implement. Step 4: run.**

- [ ] **Step 5: Typecheck and commit.** Existing `withMember.test.ts` / `withRole.test.ts` calls need
  the new first argument — update them, do not change what they assert.

---

### Task 6: Name every action

**Files:** every `"use server"` module except `src/features/auth/authActions.ts`.

- [ ] **Step 1: Add the key to each of the 61 wrapped actions**, using exactly the keys in
  `LOGGED_FIELDS` (Task 2). The mapping is by name and is unambiguous —
  `renameClientAction` → `"client.rename"`, `createSiteAction` → `"site.create"`, and so on.

- [ ] **Step 2: Opt the two pure reads out**: `listTemplatesForTypeAction` and
  `getDeviceTemplateAction` get `{ log: false }`.

- [ ] **Step 3: Prove completeness — every wrapped action has a key, and every key is known**

```bash
command grep -rhoE "with(Member|Editor|Admin)\(\"[a-zA-Z.]+\"" src --include='*.ts' | sort -u
```
Cross-check that list against `LOGGED_FIELDS`. Every key used must exist in the allowlist (or the
entry silently logs no details); every wrapped action must pass one. Paste both lists.

- [ ] **Step 4: Full suite, typecheck, commit.** Test files that mock the wrappers need the mocks
  updated to accept the extra leading argument.

---

### Task 7: The screen

**Files:**
- Create: `src/app/activity/page.tsx`, `src/features/activity/ActivityFeed.tsx`
- Test: `src/features/activity/ActivityFeed.test.tsx`
- Modify: `src/features/shell/AppSidebar.tsx` (the nav item becomes a link)

- [ ] **Step 1: The page.** `force-dynamic`; `getCurrentMember()`, redirect to `/login` when null.
  **No role check — every member reads the feed.** Read filters from `searchParams`, call
  `listEntries` and `listActors`, render `<ActivityFeed …/>`.

- [ ] **Step 2: The feed.** House style, matching `ClientsTable.tsx`. Columns: When, Who, What
  (the `summarise` output), Outcome. Refusals muted and visually distinct — present for the record,
  not competing with real changes. Filter controls for member, action, outcome and a date range,
  driven through the URL so a filtered view can be linked. Pagination via `offset`. An empty result
  renders an empty state, not a blank card.

- [ ] **Step 3: Tests** — filters compose into the query; a refusal renders distinctly from a
  success; an empty list renders the empty state.

- [ ] **Step 4: Nav item** → `href="/activity"`, `active={pathname.startsWith("/activity")}`.

- [ ] **Step 5: Typecheck, tests, `next build`, full suite, commit.**

---

### Task 8: Live verification

**Files:** none — evidence. Run by the controller.

- [ ] **Step 1: Three real entries.** Sign in as admin. Rename a client. Invite a throwaway member.
  Then demote yourself to viewer by SQL and attempt a rename (refused). Restore yourself to admin.
  `/activity` must show all three with the right actor, summary and outcome.

- [ ] **Step 2: THE CHECK THAT MATTERS — no secret reached the table.** Change your password through
  `/profile`, then:

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select action, outcome, details from activity_log order by created_at desc limit 20;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select count(*) from activity_log where details::text ~* '(pass|secret|token|apikey|AIza)';"
```
The `password.change` entry must exist with `details = {}`. The second query must return **0**.

- [ ] **Step 3: The log survives its own failure.** Confirm the app still works with the log table
  made unwritable:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "alter table activity_log rename to activity_log_tmp;"
```
Rename a client through the UI — it must still succeed. Then:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "alter table activity_log_tmp rename to activity_log;"
```

- [ ] **Step 4: Clean up** the throwaway member and its auth user; confirm the members table matches
  its state before this task.

---
