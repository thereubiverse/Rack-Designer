# Close the Anon REST Surface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The publishable `anon` key can no longer read or write any application table. The one query the middleware needs keeps working, and a test fails if a future migration re-opens the surface.

**Architecture:** One migration revoking table privileges and the schema's default privileges, plus a single column grant. No application code changes at all.

**Tech Stack:** Supabase (local via Docker), Postgres, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-close-anon-surface-design.md`

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** Files named `*.integration.test.ts` WIPE THE LOCAL DATABASE, which holds real data. Run named files only, or: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- Use `command grep`, not bare `grep`. Quote globs.
- Piping SQL into psql REQUIRES `docker exec -i`. Container: `supabase_db_network-doc-platform`.
- **This migration BREAKS the established tail convention deliberately.** Every migration up to 0026 ended with three blanket grants; 0027 is the one that stops. Do NOT copy that tail into it.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- NEVER put a real secret in a git-tracked file.

---

### Task 1: The migration

**Files:**
- Create: `supabase/migrations/0027_close_anon_surface.sql`

- [ ] **Step 1: Record the "before" state, so the change is provable**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select count(distinct table_name) as tables_exposed from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public';"
```
Expected before: a non-zero count (15 tables). Paste it.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0027_close_anon_surface.sql`:

```sql
-- Close the public REST surface.
--
-- Until now every migration ended with `grant select, insert, update, delete on all tables in
-- schema public to anon, authenticated`, copied forward 26 times — including migrations whose
-- purpose was to RESTRICT access, which is why members, phone_verifications and activity_log each
-- had to re-apply their narrowing after it. The result: the publishable key held full CRUD plus
-- TRUNCATE on every application table, bypassing all 61 server actions, the three roles and the
-- withMember gate, none of which are in that path.
--
-- The application does not use this access. Every action goes through createServiceClient (the
-- service role); the publishable key touches `public` in exactly one place, re-granted at the end.
--
-- FROM THIS MIGRATION ON, DO NOT ADD THE BLANKET GRANT. service_role already holds what the app
-- needs, and a new table should start closed. See supabase/migrations/README.md.
revoke all on all tables in schema public from anon, authenticated;

-- Future tables. Supabase's default privileges grant anon and authenticated `Dxtm` (TRUNCATE,
-- REFERENCES, TRIGGER, MAINTAIN) on every table created in this schema from now on, independent of
-- any migration. Without this line the next `create table` is TRUNCATE-able by the publishable key
-- on the day it is written, and the revoke above would look complete while not being it.
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- The single exception. src/middleware.ts checks membership on EVERY request using the publishable
-- key, because it runs on the Edge runtime where the server-only service client cannot be imported.
-- It selects disabled_at filtered by email, and Postgres requires SELECT on a column to filter by
-- it — hence both columns. `authenticated` is included because a signed-in request carries the
-- user's JWT and reaches PostgREST as that role, not as anon.
grant select (email, disabled_at) on members to anon, authenticated;
```

Note there is deliberately **no** `grant usage on schema public` line: the existing grant is not
removed by anything above, and the middleware needs it. Confirm it survived in Step 4.

- [ ] **Step 3: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0027_close_anon_surface.sql
```

- [ ] **Step 4: Verify — six probes, all of which must come out exactly**

```bash
# 1. No table privileges remain for either role.
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select grantee, table_name, privilege_type from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema='public';"
# 2. The column grant survives, and is only these two columns.
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select grantee, table_name, column_name, privilege_type from information_schema.column_privileges where grantee in ('anon','authenticated') and table_schema='public' order by grantee, column_name;"
# 3. Default privileges no longer name anon or authenticated for tables.
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select defaclacl from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace where n.nspname='public' and d.defaclobjtype='r';"
# 4. THE MIDDLEWARE'S QUERY MUST STILL WORK.
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select disabled_at from members where email='rsingh@qtsi.us';"
# 5. Reading a client as anon must now FAIL.
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select * from clients;"
# 6. Writing as anon must now FAIL.
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; delete from clients where code='___no_such_code___';"
```

Expected: (1) **zero rows**; (2) exactly four rows — `email` and `disabled_at` SELECT for each of
`anon` and `authenticated`, and nothing else; (3) an ACL naming only `postgres` and `service_role`;
(4) **succeeds**; (5) **permission denied**; (6) **permission denied**.

Probe 4 is the one that matters most. If it fails, the middleware's membership check errors on every
request and — because it fails OPEN by design — the app keeps serving pages with the gate silently
off. Do not proceed past a failing probe 4.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0027_close_anon_surface.sql
git commit -m "Close the anon REST surface

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: The guard that stops it coming back

**Files:**
- Create: `src/lib/supabase/grants.test.ts`

This is a **read-only** test. It queries grants and asserts; it creates nothing, drops nothing and
writes nothing. It is deliberately NOT named `*.integration.test.ts` — those wipe the database and
are excluded from every run; this one must be part of the normal suite, because its whole purpose is
to fail the next time a migration re-opens the surface.

- [ ] **Step 1: Write it**

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** The convention "every migration ends with the blanket grant" was copied forward 26 times,
 *  including into three migrations written specifically to RESTRICT access. A note in a template did
 *  not hold, so this asserts the actual state of the live database instead.
 *
 *  Read-only: it queries information_schema and pg_default_acl. It is NOT named
 *  *.integration.test.ts because those wipe the database and are excluded from every run — this one
 *  needs to run every time.
 *
 *  It shells out to psql through Docker, the same way every other database interaction in this repo
 *  does. If the container is not running this FAILS rather than skipping: a security guard that
 *  quietly stops guarding is worse than no guard. */
const CONTAINER = "supabase_db_network-doc-platform";

function sql(query: string): string[] {
  const out = execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query],
    { encoding: "utf8" }
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

describe("the publishable key's reach into schema public", () => {
  it("holds no table privilege on anything", () => {
    const rows = sql(`
      select grantee || ' ' || table_name || ' ' || privilege_type
      from information_schema.role_table_grants
      where grantee in ('anon','authenticated') and table_schema = 'public'
    `);
    // A failure here almost certainly means a new migration copied the old blanket grant tail.
    expect(rows).toEqual([]);
  });

  it("holds exactly one documented column grant, and nothing else", () => {
    const rows = sql(`
      select grantee || ' ' || table_name || '.' || column_name || ' ' || privilege_type
      from information_schema.column_privileges
      where grantee in ('anon','authenticated') and table_schema = 'public'
      order by 1
    `);
    // src/middleware.ts reads disabled_at filtered by email, on the Edge runtime where the
    // server-only service client cannot be imported. Postgres needs SELECT on a column to filter
    // by it, so both are granted, to both roles.
    expect(rows).toEqual([
      "anon members.disabled_at SELECT",
      "anon members.email SELECT",
      "authenticated members.disabled_at SELECT",
      "authenticated members.email SELECT",
    ]);
  });

  it("grants a future table nothing, so the next migration starts closed", () => {
    const acl = sql(`
      select coalesce(array_to_string(defaclacl, ','), '')
      from pg_default_acl d join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname = 'public' and d.defaclobjtype = 'r'
    `);
    for (const line of acl) {
      expect(line).not.toMatch(/(^|,)anon=/);
      expect(line).not.toMatch(/(^|,)authenticated=/);
    }
  });
});
```

- [ ] **Step 2: Run it**

```bash
./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts
```
Expected: PASS, 3 tests.

- [ ] **Step 3: Prove the guard actually guards**

Temporarily re-open the surface, confirm the test FAILS, then close it again:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "grant select on clients to anon;"
./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts   # must FAIL
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "revoke select on clients from anon;"
./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts   # must PASS again
```
A guard never seen to fail is not known to work. Paste both runs.

- [ ] **Step 4: Commit**

---

### Task 3: Write the convention down where the next migration will be written

**Files:**
- Create: `supabase/migrations/README.md`

- [ ] **Step 1: Write it**

Short — half a page. It must say:

- **Do not add a `grant ... to anon, authenticated` tail.** Every migration from `0001` to `0026`
  ended with one; `0027` removed the surface it created. `service_role` already holds everything the
  application needs, and every table should start closed.
- **`anon` and `authenticated` reach exactly one thing in `public`**: `select (email, disabled_at)`
  on `members`, for the Edge middleware. If a new feature seems to need more, that is a design
  question — the application uses the service role for all data access.
- **`src/lib/supabase/grants.test.ts` enforces this** and will fail if a migration widens it.
- The historical narrowings in `0020`, `0022`, `0023`, `0025` and `0026` exist only because each had
  to undo the blanket grant that preceded them in the same file. New migrations need nothing
  equivalent.
- Migrations are applied with
  `docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/NNNN_name.sql`.

- [ ] **Step 2: Commit**

---

### Task 4: Live verification

**Files:** none — evidence. Run by the controller.

- [ ] **Step 1: The app still works.** Load `/clients`, `/activity`, `/users` and `/profile`. All
  must render. These all read through the service role, so the expectation is that nothing changed.

- [ ] **Step 2: THE ONE THAT MATTERS — the gate is still live, not failing open.** Revoke the member
  by SQL, load a page, and confirm the redirect to `/login`. Then restore.

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "update members set disabled_at = now() where email='rsingh@qtsi.us';"
# load a page in the browser — must bounce to /login
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "update members set disabled_at = null where email='rsingh@qtsi.us';"
```
If the page still renders while the member is revoked, the middleware's query is erroring and the
gate has failed open. That is the failure this whole step exists to catch.

- [ ] **Step 3: The negative, over the real REST API**, with the publishable key from `.env.local`:

```bash
curl -s -o /dev/null -w "read clients: %{http_code}\n" "http://127.0.0.1:54321/rest/v1/clients?select=*" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
curl -s -o /dev/null -w "delete a client: %{http_code}\n" -X DELETE "http://127.0.0.1:54321/rest/v1/clients?code=eq.___none___" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
curl -s -o /dev/null -w "read members PII: %{http_code}\n" "http://127.0.0.1:54321/rest/v1/members?select=phone,address" -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY"
```
All three must be refused — 401/403/404, anything but 2xx. Before this migration the first returned
200 and the second was permitted.

- [ ] **Step 4: Record the before/after in the ledger**, including the exact counts from Task 1 Step 1.

---
