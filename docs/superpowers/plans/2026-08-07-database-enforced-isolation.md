# Multi-Tenancy Slice 2: Database-Enforced Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a cross-organisation query return nothing, enforced by Postgres, so isolation stops depending on all 141 server functions being written correctly.

**Architecture:** A Postgres role `app_tenant` that cannot bypass RLS, reachable only through a 60-second token the server mints with `JWT_SECRET`. Policies read the organisation from a custom JWT claim, so it is a constant per query rather than a join. `anon` and `authenticated` keep zero privileges, so the public REST surface is unchanged. The database half lands inertly — nobody can obtain an `app_tenant` token without the secret — then 25 files move to the scoped client incrementally behind a guard.

**Tech Stack:** Postgres 17.6, PostgREST 13.0.7, Supabase self-hosted, TypeScript strict, Next.js 16 server actions, vitest.

**Spec:** `docs/superpowers/specs/2026-08-07-database-enforced-isolation-design.md`

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** `*.integration.test.ts` files WIPE THE LOCAL DATABASE, which holds real data (3 clients, 31 sites, 1 rack, 2 members). Named files only.
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- Apply migrations with `docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < FILE`. The `-i` is required.
- **New migrations grant nothing to `anon` or `authenticated`.** That is unchanged by this slice and is the whole point of the design — see `supabase/migrations/README.md`.
- **Every new function needs `revoke all on function … from public`.** The schema-level default is not a backstop — see migration `0032`.
- **Every tenant policy must `drop policy if exists single_org_all` on the same table.** Twelve tables carry `using (true) with check (true)` granted to PUBLIC from migrations `0001`–`0008`; Postgres ORs permissive policies, so without the drop the new policy does nothing. Proven in the spike.
- **A token with no `org_id` claim must return zero rows, never all rows.** Assert it directly, every time it is plausible.
- **Never judge success from a command piped into `tail`/`head`** — the pipeline returns the last command's status. This project has had four false "it passed" readings that way.
- Use `command grep`, not bare `grep`. Quote globs. NEVER put a real secret in a git-tracked file; the repo is PUBLIC.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- British spelling (`organisations`, `normaliseEmail`).

## The 20 tables, and what each needs

Measured from the live catalogue.

| Group | Tables | Policy `using` | `app_tenant` grant |
|---|---|---|---|
| 13 application tables | `clients`, `sites`, `floors`, `rooms`, `racks`, `rack_devices`, `connections`, `port_endpoints`, `floor_devices`, `floor_plans`, `members`, `activity_log`, `app_settings` | `org_id = current_org_id()` | `select, insert, update, delete` |
| 3 library tables | `brands`, `device_types`, `device_templates` | `org_id is null or org_id = current_org_id()` | `select, insert, update, delete` |
| `organisations` | — | `id = current_org_id()` | `select` only |
| 3 secret-bearing tables | `trusted_devices`, `device_challenges`, `phone_verifications` | `org_id = current_org_id()` | **none** |

The last group holds device token hashes and verification codes. They are reached only through the service role (the device flow runs before device trust exists), so `app_tenant` gets no grant at all — least privilege. They still get RLS and a policy, so that a future feature reaching for them through the tenant client fails loudly rather than silently working.

`activity_log.org_id` is nullable and means "a platform event belonging to no organisation". `org_id = current_org_id()` is false for NULL, so those rows are invisible to every tenant with no special case — which is the intended outcome.

Twelve tables already have RLS enabled and carry `single_org_all`: `app_settings`, `brands`, `clients`, `connections`, `device_templates`, `device_types`, `floors`, `port_endpoints`, `rack_devices`, `racks`, `rooms`, `sites`. The other eight need `enable row level security` as well as a policy.

## File Structure

**Create:**
- `supabase/migrations/0042_app_tenant_role.sql` — the role, its grants, `current_org_id()`
- `supabase/migrations/0043_tenant_policies.sql` — RLS and a policy on all 20 tables; drops the 12 `single_org_all`
- `supabase/migrations/0044_storage_policies.sql` — object policies keyed on the org path prefix
- `src/lib/supabase/tenant.ts` — `createTenantClient(member)` and the token mint
- `src/lib/supabase/tenant.test.ts` — mint unit tests (claims, expiry, signature)
- `src/lib/supabase/policies.test.ts` — the live policy guard
- `src/lib/supabase/isolation.test.ts` — two organisations, two tokens, real cross-tenant attempts
- `src/lib/supabase/serviceRoleAllowlist.test.ts` — the shrinking import guard

**Modify:**
- `deploy/docker-compose.yml`, `deploy/.env.example`, `.env.local.example` — pass `JWT_SECRET` to the app
- 25 files, listed in Tasks 7-9

---

### Task 1: The `app_tenant` role, its grants, and `current_org_id()`

**Files:** Create `supabase/migrations/0042_app_tenant_role.sql`

**Interfaces:**
- Produces: role `app_tenant`; function `current_org_id() returns uuid`, `stable`, executable by `app_tenant`.

- [ ] **Step 1: Write the migration**

```sql
-- Slice 2, part 1: the role isolation will be enforced against.
--
-- Nothing here is reachable without JWT_SECRET, which lives only on the server, so this migration
-- changes nothing observable. That is deliberate: the database half lands and is proven before the
-- application half starts using it.
--
-- NOT `authenticated`. That is the role a BROWSER reaches PostgREST as, and granting it table
-- privileges would turn /rest/v1 into a live API for every signed-in user — exactly what migrations
-- 0027, 0028 and 0032 were written to close. Everything in this app queries from the server, so a
-- private role reachable only via a server-minted token keeps that surface shut.
create role app_tenant nologin;

-- Mandatory, and the failure is obscure without it: PostgREST returns
-- `permission denied to set role "app_tenant"` (403). Verified in the spike.
grant app_tenant to authenticator;

-- Also verified in the spike, and omitted from the first draft of the spec: without schema usage
-- every query fails regardless of table grants.
grant usage on schema public to app_tenant;

-- The one place the organisation is read from the request. `current_setting(..., true)` returns
-- NULL rather than raising when the setting is absent, and `nullif(..., '')` catches a claim present
-- but empty — the spike proved both paths reach here, and that the empty-string case is load-bearing.
--
-- The consequence is the property this whole slice rests on: no claim means NULL, and
-- `org_id = NULL` is never true, so a request without a valid organisation reads NOTHING rather
-- than EVERYTHING. It fails closed.
create function current_org_id() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'org_id', '')::uuid
$$;

revoke all on function current_org_id() from public;
grant execute on function current_org_id() to app_tenant;

-- The 13 application tables plus the 3 library tables. RLS in 0043 is what scopes these.
grant select, insert, update, delete on
  clients, sites, floors, rooms, racks, rack_devices, connections, port_endpoints,
  floor_devices, floor_plans, members, activity_log, app_settings,
  brands, device_types, device_templates
to app_tenant;

-- Read-only: a tenant may see its own organisation's name, never rename it or find another.
grant select on organisations to app_tenant;

-- DELIBERATELY NOT GRANTED: trusted_devices, device_challenges, phone_verifications. They hold
-- device token hashes and verification codes, and are reached only through the service role because
-- the device flow runs before device trust exists. They still get RLS and a policy in 0043, so a
-- future feature reaching for them through the tenant client fails loudly instead of quietly working.
```

- [ ] **Step 2: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0042_app_tenant_role.sql
```

Expected: `CREATE ROLE`, `GRANT` ×2, `CREATE FUNCTION`, `REVOKE`, `GRANT` ×3. No `ERROR`.

- [ ] **Step 3: Verify the role cannot bypass RLS, which is the entire point**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "select rolname||' bypassrls='||rolbypassrls::text||' login='||rolcanlogin::text from pg_roles where rolname='app_tenant'"
```

Expected: `app_tenant bypassrls=false login=false`. If `bypassrls` is true, stop — every policy in Task 2 would be decorative.

- [ ] **Step 4: Verify the secret-bearing tables were not granted**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "
select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r'
  and has_table_privilege('app_tenant', c.oid, 'select')
order by 1"
```

Expected: exactly the 16 tables from the grant, plus `organisations`. `trusted_devices`, `device_challenges` and `phone_verifications` must NOT appear.

- [ ] **Step 5: Verify nothing changed for anyone else**

```bash
./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts src/lib/supabase/tenancy.test.ts
```

Expected: 15 passed. `anon` and `authenticated` are untouched by this migration and the existing guards prove it.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0042_app_tenant_role.sql
git commit -m "Add the app_tenant role and current_org_id()"
```

---

### Task 2: Policies on all 20 tables, and the twelve that must be dropped

**Files:** Create `supabase/migrations/0043_tenant_policies.sql`

**Interfaces:**
- Consumes: `app_tenant`, `current_org_id()` (Task 1).
- Produces: RLS enabled on all 20 tables, one policy each named `<table>_tenant`, and no `single_org_all` anywhere.

- [ ] **Step 1: Write the migration**

Write it out per table rather than in a loop — twenty explicit statements are greppable, and three tables genuinely differ. The pattern for the 13 application tables plus the 3 secret-bearing ones:

```sql
-- Slice 2, part 2: the wall itself.
--
-- THE TRAP THIS MIGRATION EXISTS AROUND. Twelve of these tables already have RLS enabled and carry
-- a policy from migrations 0001-0008:
--
--   create policy single_org_all on clients for all using (true) with check (true);
--
-- Granted to PUBLIC, permitting everything. Nobody noticed because that is indistinguishable from
-- RLS being off, and the application reaches the database as service_role, which bypasses RLS.
--
-- Postgres ORs permissive policies together, so leaving it in place makes every policy below a
-- no-op. Measured in the spike: with single_org_all present, a token scoped to one organisation
-- returned BOTH organisations' rows, and a token carrying no organisation returned EVERYTHING.
--
-- `force row level security` is deliberately not used: it would also constrain `postgres`, which
-- owns these tables and is who migrations run as, so a future migration would silently see no rows.
-- app_tenant is not the owner, so ordinary RLS binds it fully.

alter table clients enable row level security;
drop policy if exists single_org_all on clients;
create policy clients_tenant on clients for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());
```

Repeat exactly that shape for: `sites`, `floors`, `rooms`, `racks`, `rack_devices`, `connections`, `port_endpoints`, `floor_devices`, `floor_plans`, `members`, `activity_log`, `app_settings`, `trusted_devices`, `device_challenges`, `phone_verifications`.

The 3 library tables also admit the shared rows:

```sql
alter table brands enable row level security;
drop policy if exists single_org_all on brands;
create policy brands_tenant on brands for all to app_tenant
  using (org_id is null or org_id = current_org_id())
  with check (org_id is null or org_id = current_org_id());
```

Repeat for `device_types` and `device_templates`.

`organisations` has no `org_id` — it is keyed on its own id, and read-only by grant:

```sql
alter table organisations enable row level security;
create policy organisations_tenant on organisations for all to app_tenant
  using (id = current_org_id())
  with check (id = current_org_id());
```

End the file with a comment recording why `with check` appears on every one: without it an insert or update could *write* a row into another organisation while being unable to read it back.

- [ ] **Step 2: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0043_tenant_policies.sql
```

Expected: 20 × `ALTER TABLE`, 19 × `DROP POLICY`, 20 × `CREATE POLICY`. No `ERROR`.

- [ ] **Step 3: Verify no permissive `true` policy survives — the thing that would make this decorative**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "
select polrelid::regclass::text||' '||polname||' roles='||coalesce((select string_agg(rolname,',') from pg_roles where oid = any(polroles)),'PUBLIC')||' using='||coalesce(pg_get_expr(polqual,polrelid),'(none)')
from pg_policy
where coalesce(pg_get_expr(polqual,polrelid),'true') = 'true' or polroles = '{0}'
order by 1"
```

Expected: **no output.** Any line is a policy that permits everything or applies to PUBLIC, and it ORs with the tenant policies to defeat them.

- [ ] **Step 4: Verify every table has RLS and exactly one tenant policy**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "
select c.relname||' rls='||c.relrowsecurity::text||' policies='||(select count(*) from pg_policy p where p.polrelid=c.oid)::text
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and c.relkind='r' and (not c.relrowsecurity or (select count(*) from pg_policy p where p.polrelid=c.oid) <> 1)
order by 1"
```

Expected: **no output.**

- [ ] **Step 5: Confirm the application is unaffected**

```bash
./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts src/lib/supabase/tenancy.test.ts
./node_modules/.bin/tsc --noEmit
```

Expected: 15 passed, tsc silent. The app still uses `service_role`, which bypasses all of this — that is why the database half can land first.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0043_tenant_policies.sql
git commit -m "Enable RLS and a tenant policy on every table, dropping single_org_all"
```

---

### Task 3: The policy guard

**Files:** Create `src/lib/supabase/policies.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: a read-only live guard in the style of `src/lib/supabase/grants.test.ts` and `tenancy.test.ts`, honouring `GRANTS_TEST_CONTAINER`.

Read `src/lib/supabase/tenancy.test.ts` first and follow its shape — the `sql()` helper, the container override, the read-only discipline.

- [ ] **Step 1: Write the guard**

Assert five things. The third is the one that matters most, and it is the reason a guard that only checks for the presence of the right policies is not enough:

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** The wall, asserted against the live catalogue. Read-only; creates and drops nothing. NOT named
 *  *.integration.test.ts — those wipe the database and are excluded from every run. */
const CONTAINER = process.env.GRANTS_TEST_CONTAINER || "supabase_db_network-doc-platform";

function sql(query: string): string[] {
  const out = execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query],
    { encoding: "utf8" }
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Reached only through the service role, and holding device token hashes and verification codes,
 *  so app_tenant gets no grant at all. They still carry RLS and a policy, so a future feature
 *  reaching for them through the tenant client fails loudly. */
const UNGRANTED = ["device_challenges", "phone_verifications", "trusted_devices"];

describe("the tenant wall", () => {
  it("enables row level security on every table", () => {
    const off = sql(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1
    `);
    expect(off).toEqual([]);
  });

  it("gives every table exactly one policy, for app_tenant, with both using and with check", () => {
    const wrong = sql(`
      select c.relname || ' -> ' || coalesce(p.polname, '(no policy)')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
        and (p.polname is null
             or p.polwithcheck is null
             or p.polqual is null
             or p.polroles <> array[(select oid from pg_roles where rolname = 'app_tenant')])
      order by 1
    `);
    // A missing `with check` is the subtle one: reads would be scoped while a write could still
    // place a row in another organisation.
    expect(wrong).toEqual([]);
  });

  it("has no permissive policy that permits everything, or applies to PUBLIC", () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Postgres ORs permissive policies together, so one
    // `using (true)` defeats every other policy on the table. Twelve tables carried exactly that
    // from migrations 0001-0008, and the spike measured the result: a token scoped to one
    // organisation saw both organisations' rows, and a token with no organisation saw everything.
    const permissive = sql(`
      select polrelid::regclass::text || '.' || polname
      from pg_policy
      where coalesce(pg_get_expr(polqual, polrelid), 'true') = 'true'
         or coalesce(pg_get_expr(polwithcheck, polrelid), 'true') = 'true'
         or polroles = '{0}'
      order by 1
    `);
    expect(permissive).toEqual([]);
  });

  it("keeps the secret-bearing tables out of app_tenant's reach", () => {
    const reachable = sql(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname in ('${UNGRANTED.join("','")}')
        and has_table_privilege('app_tenant', c.oid, 'select')
      order by 1
    `);
    expect(reachable).toEqual([]);
  });

  it("cannot bypass row level security", () => {
    // If this is ever true, every policy above is decorative.
    expect(sql(`select rolbypassrls::text from pg_roles where rolname = 'app_tenant'`)).toEqual(["false"]);
  });
});
```

- [ ] **Step 2: Run it**

```bash
./node_modules/.bin/vitest run src/lib/supabase/policies.test.ts
```

Expected: 5 passed.

- [ ] **Step 3: Prove the guard actually guards**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "create policy tmp_probe on clients for all using (true);"
./node_modules/.bin/vitest run src/lib/supabase/policies.test.ts
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "drop policy tmp_probe on clients;"
./node_modules/.bin/vitest run src/lib/supabase/policies.test.ts
```

Expected: fails in the middle naming `clients.tmp_probe`, passes again at the end. **This is the single most important step in the task** — the failure it simulates is exactly the one that was live in this database until Task 2.

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/policies.test.ts
git commit -m "Assert the wall exists, and that nothing permissive survives beside it"
```

---

### Task 4: The tenant client, and getting `JWT_SECRET` to the app

**Files:**
- Create: `src/lib/supabase/tenant.ts`, `src/lib/supabase/tenant.test.ts`
- Modify: `deploy/docker-compose.yml` (the `app` service), `deploy/.env.example`, `.env.local.example`

**Interfaces:**
- Consumes: `Member` from `src/features/auth/members.ts`, which carries `orgId: string`.
- Produces: `createTenantClient(member: Member): SupabaseClient` and `mintTenantToken(orgId: string, nowSeconds?: number): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mintTenantToken } from "./tenant";

const SECRET = "test-secret-at-least-32-characters-long!!";

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
}

describe("mintTenantToken", () => {
  beforeEach(() => {
    process.env.SUPABASE_JWT_SECRET = SECRET;
  });

  it("names the app_tenant role and the organisation", () => {
    const claims = decode(mintTenantToken("11111111-1111-1111-1111-111111111111"));
    expect(claims.role).toBe("app_tenant");
    expect(claims.org_id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("expires 60 seconds out", () => {
    const claims = decode(mintTenantToken("11111111-1111-1111-1111-111111111111", 1_000_000));
    expect(claims.exp).toBe(1_000_060);
  });

  it("refuses to mint without an organisation, rather than minting a token with none", () => {
    // A token carrying no org_id reads nothing, so this would present as an empty application
    // rather than an error. Fail at the source instead.
    expect(() => mintTenantToken("")).toThrow(/organisation/i);
  });

  it("refuses to mint with no secret configured", () => {
    delete process.env.SUPABASE_JWT_SECRET;
    expect(() => mintTenantToken("11111111-1111-1111-1111-111111111111")).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("produces a token whose signature verifies", () => {
    const token = mintTenantToken("11111111-1111-1111-1111-111111111111");
    const [h, p, s] = token.split(".");
    const crypto = require("node:crypto");
    const expected = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
    expect(s).toBe(expected);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
./node_modules/.bin/vitest run src/lib/supabase/tenant.test.ts
```

Expected: FAIL — `Cannot find module './tenant'`.

- [ ] **Step 3: Write the client**

```ts
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import type { Member } from "@/features/auth/members";

/** Seconds of validity. PostgREST allows 30 seconds of leeway past `exp` — bisected in the spike:
 *  expired by 30s is accepted, by 31s returns PGRST303 — so the real window is 90 seconds. Long
 *  enough to outlast any single request; short enough that a token in a log is useless. */
const TOKEN_TTL_SECONDS = 60;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Mints the token that IS the tenant boundary.
 *
 *  This is the one place the organisation reaches the database, which is the entire point of the
 *  design: the risk moves from "each of 141 actions remembers its filter" to "this function is
 *  correct". Policies read `org_id` from these claims via current_org_id().
 *
 *  `nowSeconds` is injectable so the expiry can be asserted without freezing the clock. */
export function mintTenantToken(orgId: string, nowSeconds?: number): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("Missing SUPABASE_JWT_SECRET — cannot mint a tenant token");
  // A token with no org_id reads NOTHING, by design. That would surface as an application with no
  // data in it rather than as an error, so refuse here where the cause is still visible.
  if (!orgId) throw new Error("mintTenantToken: refusing to mint without an organisation");

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ role: "app_tenant", org_id: orgId, iat: now, exp: now + TOKEN_TTL_SECONDS });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** A Supabase client scoped to one organisation, enforced by Postgres rather than by this code.
 *
 *  Use this everywhere `createServiceClient()` was used, except the four paths that genuinely run
 *  before an organisation is known — see src/lib/supabase/serviceRoleAllowlist.test.ts, which fails
 *  if anything else imports the service client. */
export function createTenantClient(member: Member): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const token = mintTenantToken(member.orgId);
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
```

- [ ] **Step 4: Run the tests**

```bash
./node_modules/.bin/vitest run src/lib/supabase/tenant.test.ts
```

Expected: 5 passed.

- [ ] **Step 5: Get the secret to the app**

In `deploy/docker-compose.yml`, add to the `app` service's `environment:`, beside the other Supabase values:

```yaml
      # Slice 2: the app mints short-lived app_tenant tokens with this, which is how row-level
      # security learns which organisation a query belongs to. The app already holds
      # SUPABASE_SERVICE_ROLE_KEY, so this grants it no new power — but it does mean this container
      # can mint any role, which is worth knowing before deciding the service-role key can be removed.
      SUPABASE_JWT_SECRET: ${JWT_SECRET:?JWT_SECRET is required}
```

Add `SUPABASE_JWT_SECRET=` to `.env.local.example` with a comment that the local Supabase CLI stack's value comes from `supabase status`. `deploy/.env` already carries `JWT_SECRET`, so `deploy/.env.example` needs only a comment noting it is now also consumed by the app.

- [ ] **Step 6: Set it locally and confirm the stack resolves**

Add `SUPABASE_JWT_SECRET` to your `.env.local` using the value from `npx supabase status` (JWT secret). Then:

```bash
APP_HOSTNAME=x POSTGRES_PASSWORD=x JWT_SECRET=x ANON_KEY=x SERVICE_ROLE_KEY=x docker compose -f deploy/docker-compose.yml config >/dev/null
echo "compose config exit: $?"
```

Expected: `0`.

- [ ] **Step 7: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/lib/supabase/tenant.ts src/lib/supabase/tenant.test.ts deploy/docker-compose.yml deploy/.env.example .env.local.example
git commit -m "Add the tenant client and the token that scopes it"
```

---

### Task 5: Prove the wall with two organisations and two tokens

**Files:** Create `src/lib/supabase/isolation.test.ts`

**Interfaces:**
- Consumes: `mintTenantToken` (Task 4), the policies (Task 2).

This is the test that exercises behaviour rather than the catalogue. Task 3 asserts the policies exist; this asserts they *work*. The lesson from slice 1 is that a catalogue-shaped guard stays green when the thing it guards is removed.

**On environment:** `vitest.config.ts` already loads `.env.local` through dotenv, so `SUPABASE_JWT_SECRET`, `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` reach the test without any extra plumbing — provided Task 4 Step 6 actually put the secret there. If this test fails with "Missing SUPABASE_JWT_SECRET", that is the cause, not the config.

**Note also what `vitest.config.ts` does NOT do:** its `exclude` covers only `e2e/**` and `node_modules/**`, so `*.integration.test.ts` files ARE matched by the include glob. That is precisely why this plan forbids running vitest against a directory — the destructive files are not excluded by configuration, only by never being named.

- [ ] **Step 1: Write it**

It must run against the real database through PostgREST, using two organisations it creates and removes itself. Use the local stack's REST URL and the `SUPABASE_JWT_SECRET` from the environment. Structure:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mintTenantToken } from "./tenant";

const CONTAINER = process.env.GRANTS_TEST_CONTAINER || "supabase_db_network-doc-platform";
const REST = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function psql(query: string): string {
  return execFileSync("docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query],
    { encoding: "utf8" }).trim();
}

async function get(path: string, token: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${REST}${path}`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: await res.text() };
}

let orgA = "", orgB = "";

beforeAll(() => {
  // Distinctive codes so a leak is unmistakable, and so cleanup can find them.
  orgA = psql(`insert into organisations (name) values ('ISO-TEST-A') returning id`);
  orgB = psql(`insert into organisations (name) values ('ISO-TEST-B') returning id`);
  psql(`insert into clients (code, name, org_id) values ('ISOA','Iso A','${orgA}')`);
  psql(`insert into clients (code, name, org_id) values ('ISOB','Iso B','${orgB}')`);
});

afterAll(() => {
  // Deletes only what this file created — never a blanket delete.
  psql(`delete from clients where code in ('ISOA','ISOB')`);
  psql(`delete from organisations where name in ('ISO-TEST-A','ISO-TEST-B')`);
});

describe("cross-organisation access", () => {
  it("sees its own organisation's client", async () => {
    const { body } = await get("/rest/v1/clients?code=eq.ISOA&select=code", mintTenantToken(orgA));
    expect(body).toContain("ISOA");
  });

  it("cannot see another organisation's client", async () => {
    const { body } = await get("/rest/v1/clients?code=eq.ISOB&select=code", mintTenantToken(orgA));
    expect(JSON.parse(body)).toEqual([]);
  });

  it("returns NOTHING for a token carrying no organisation", async () => {
    // The property the whole slice rests on. A bug here reads as "the app is empty", not as an
    // error, so it is asserted directly rather than inferred.
    const token = mintTenantToken(orgA).split(".");
    const claims = JSON.parse(Buffer.from(token[1], "base64url").toString());
    delete claims.org_id;
    // Re-sign without org_id, using the same helper's secret.
    const { createHmac } = await import("node:crypto");
    const h = token[0];
    const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const s = createHmac("sha256", process.env.SUPABASE_JWT_SECRET!).update(`${h}.${p}`).digest("base64url");
    const { body } = await get("/rest/v1/clients?select=code", `${h}.${p}.${s}`);
    expect(JSON.parse(body)).toEqual([]);
  });

  it("refuses a write into another organisation", async () => {
    const res = await fetch(`${REST}/rest/v1/clients`, {
      method: "POST",
      headers: {
        apikey: ANON,
        Authorization: `Bearer ${mintTenantToken(orgA)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ code: "ISOX", name: "Cross", org_id: orgB }),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("row-level security");
  });

  it("still refuses the publishable key everything", async () => {
    const { status } = await get("/rest/v1/clients?select=code", ANON);
    expect(status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it**

```bash
./node_modules/.bin/vitest run src/lib/supabase/isolation.test.ts
```

Expected: 5 passed. If the third test fails by returning rows, **stop everything** — that is the design's core property failing, and nothing further should be built on it.

- [ ] **Step 3: Confirm it cleaned up after itself**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "select count(*) from organisations where name like 'ISO-TEST-%'"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -tAc "select 'clients='||count(*) from clients"
```

Expected: `0`, and `clients=3` — the real data, unchanged.

- [ ] **Step 4: Commit**

```bash
git add src/lib/supabase/isolation.test.ts
git commit -m "Prove the wall holds with two organisations and two tokens"
```

---

### Task 6: The shrinking service-role guard

**Files:** Create `src/lib/supabase/serviceRoleAllowlist.test.ts`

**Interfaces:**
- Produces: a test that fails when a file outside the allowlist imports `createServiceClient`.

- [ ] **Step 1: Write it, with today's 29 files as the starting allowlist**

```ts
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** The service role bypasses row-level security entirely, so a file still using it is silently
 *  unprotected — it keeps working, which is exactly why nothing draws attention to it. This list is
 *  the only thing that makes the remainder visible.
 *
 *  It starts at every file that used the service client when slice 2 began, and SHRINKS as each
 *  moves to createTenantClient. When the slice is done only PERMANENT holds four entries. Removing a
 *  file from this list is the definition of done for that file; adding one requires a reason in the
 *  table in docs/superpowers/specs/2026-08-07-database-enforced-isolation-design.md. */
const PERMANENT = [
  "src/features/activity/authLog.ts",     // sign-in refusals for addresses belonging to nobody
  "src/features/auth/authActions.ts",     // sign-in and sign-out, either side of a session
  "src/features/auth/members.ts",         // resolves the member, so cannot already have an org
  "src/features/devices/actions.ts",      // the device flow runs before device trust exists
];

/** Still to move. Every deletion from here is progress; nothing should ever be added. */
const REMAINING: string[] = [
  "src/app/activity/page.tsx",
  "src/app/clients/[clientCode]/[siteCode]/page.tsx",
  "src/app/clients/[clientCode]/page.tsx",
  "src/app/clients/page.tsx",
  "src/app/device-library/page.tsx",
  "src/app/device-library/types/page.tsx",
  "src/app/layout.tsx",
  "src/app/page.tsx",
  "src/app/profile/page.tsx",
  "src/app/racks/[id]/page.tsx",
  "src/app/settings/archive/page.tsx",
  "src/app/users/page.tsx",
  "src/app/verify-device/page.tsx",
  "src/features/auth/withMember.ts",
  "src/features/clients/actions.ts",
  "src/features/clients/discoverActions.ts",
  "src/features/clients/planExtractActions.ts",
  "src/features/clients/symbolActions.ts",
  "src/features/device-library/actions.ts",
  "src/features/device-library/typeActions.ts",
  "src/features/locations/actions.ts",
  "src/features/profile/actions.ts",
  "src/features/racks/actions.ts",
  "src/features/settings/store.ts",
  "src/features/users/actions.ts",
];

describe("who may use the service role", () => {
  it("is exactly the allowlist, and nothing else", () => {
    const out = execFileSync(
      "bash",
      ["-c", `command grep -rl 'from "@/lib/supabase/server"' src --include='*.ts' --include='*.tsx' | command grep -v '\\.test\\.' | sort`],
      { encoding: "utf8" }
    );
    const actual = out.split("\n").map((l) => l.trim()).filter(Boolean);
    // Exact equality both ways: a NEW file reaching for the service role fails here, and so does a
    // file listed as remaining that has already moved — which keeps the list honest as it shrinks.
    expect(actual).toEqual([...PERMANENT, ...REMAINING].sort());
  });
});
```

- [ ] **Step 2: Run it**

```bash
./node_modules/.bin/vitest run src/lib/supabase/serviceRoleAllowlist.test.ts
```

Expected: 1 passed. If it fails, the listed set no longer matches reality — reconcile against the real output rather than editing until it is green.

- [ ] **Step 3: Commit**

```bash
git add src/lib/supabase/serviceRoleAllowlist.test.ts
git commit -m "Track who still bypasses row level security"
```

---

### Task 7: Move the 13 page components

**Files:** Modify the 13 `src/app/**/page.tsx` and `src/app/layout.tsx` files listed in Task 6's `REMAINING`; modify `src/lib/supabase/serviceRoleAllowlist.test.ts`

**Interfaces:**
- Consumes: `createTenantClient(member)` (Task 4).

Every one of these already calls `getCurrentMember()` and redirects when it returns null, so the `Member` — and therefore `member.orgId` — is in scope. The change is mechanical: replace `createServiceClient()` with `createTenantClient(member)` and move the call below the member lookup.

- [ ] **Step 1: Change one page and see it work before touching the rest**

Start with `src/app/clients/page.tsx`. Replace the import and the call site, then load the page in the dev server and confirm the client list still renders **with the three real clients in it**.

**This is the step that matters.** If the token is wrong, the page renders successfully with an empty list — no error anywhere. Assert that expected rows appear, not that nothing threw.

- [ ] **Step 2: Change the remaining 12, then check each renders**

For each, load the page and confirm real data appears. `src/app/layout.tsx` is the one to be most careful with: it renders on every page, so a mistake there is a blank application rather than a blank page.

- [ ] **Step 3: Shrink the guard**

Remove all 13 entries from `REMAINING` in `src/lib/supabase/serviceRoleAllowlist.test.ts`.

- [ ] **Step 4: Verify**

```bash
./node_modules/.bin/vitest run src/lib/supabase/serviceRoleAllowlist.test.ts src/lib/supabase/isolation.test.ts src/lib/supabase/policies.test.ts
./node_modules/.bin/tsc --noEmit
```

Expected: all pass, tsc silent.

- [ ] **Step 5: Commit**

```bash
git add src/app src/lib/supabase/serviceRoleAllowlist.test.ts
git commit -m "Move the page components onto the tenant client"
```

---

### Task 8: Move the clients, locations and racks features

**Files:** Modify `src/features/clients/actions.ts`, `src/features/clients/discoverActions.ts`, `src/features/clients/planExtractActions.ts`, `src/features/clients/symbolActions.ts`, `src/features/locations/actions.ts`, `src/features/racks/actions.ts`; modify `src/lib/supabase/serviceRoleAllowlist.test.ts`

These are all server actions wrapped in `withMember` / `withEditor` / `withAdmin`, so the `Member` is the first parameter and `member.orgId` is in scope at every call site.

- [ ] **Step 1: Replace the client in each**

Change `const db = createServiceClient();` to `const db = createTenantClient(member);` and update the import.

- [ ] **Step 2: Run the tests that cover them**

```bash
./node_modules/.bin/vitest run src/features/clients/repository.test.ts src/features/clients/planActions.test.ts src/features/racks/actions.test.ts src/features/locations/actions.test.ts
```

Run `ls src/features/clients/*.test.ts src/features/racks/*.test.ts src/features/locations/*.test.ts` first and run the files that exist. Never pass a directory.

- [ ] **Step 3: Exercise the real paths in the browser**

Create a client, add a site, add a floor, upload a floor plan, open a rack. Each is a write through a policy with `with check`, and a wrong organisation is refused with a `42501` rather than silently succeeding — so a failure here is loud, unlike the read paths.

- [ ] **Step 4: Shrink the guard, verify, commit**

```bash
./node_modules/.bin/vitest run src/lib/supabase/serviceRoleAllowlist.test.ts src/lib/supabase/isolation.test.ts
./node_modules/.bin/tsc --noEmit
git add src/features src/lib/supabase/serviceRoleAllowlist.test.ts
git commit -m "Move the clients, locations and racks actions onto the tenant client"
```

---

### Task 9: Move the remaining features

**Files:** Modify `src/features/device-library/actions.ts`, `src/features/device-library/typeActions.ts`, `src/features/profile/actions.ts`, `src/features/users/actions.ts`, `src/features/settings/store.ts`, `src/features/auth/withMember.ts`; modify `src/lib/supabase/serviceRoleAllowlist.test.ts`

Two need care:

**`src/features/auth/withMember.ts`** writes the activity entry for every action. The member is resolved by then, so `member.orgId` is available — but the write happens in `logResult`, which currently builds its own service client. Pass the member's organisation through rather than resolving it again.

**`src/features/settings/store.ts`** takes an `orgId` parameter already (slice 1), so its callers have one; make sure the client and the filter agree — using `createTenantClient` while still filtering by a *different* passed-in `orgId` would be a confusing double scope. The policy is the enforcement; keep the explicit filter as well, since it costs nothing and documents intent.

- [ ] **Step 1: Replace the client in each**
- [ ] **Step 2: Run the covering tests**

```bash
./node_modules/.bin/vitest run src/features/users/actions.test.ts src/features/profile/actions.test.ts src/features/settings/deviceWizardSettings.test.ts src/features/auth/withMember.test.ts
```

- [ ] **Step 3: Exercise in the browser** — change your profile, invite a member, toggle the Device Wizard, and confirm the activity log records all three. A silent failure in `withMember` means actions succeed but nothing is audited, which no page will show you.

- [ ] **Step 4: The guard should now be down to four**

```bash
./node_modules/.bin/vitest run src/lib/supabase/serviceRoleAllowlist.test.ts
```

`REMAINING` must be empty and `PERMANENT` must hold exactly the four documented paths.

- [ ] **Step 5: Verify and commit**

```bash
./node_modules/.bin/vitest run src/lib/supabase/policies.test.ts src/lib/supabase/isolation.test.ts src/lib/supabase/grants.test.ts src/lib/supabase/tenancy.test.ts
./node_modules/.bin/tsc --noEmit
git add src/features src/lib/supabase/serviceRoleAllowlist.test.ts
git commit -m "Move the last features onto the tenant client"
```

---

### Task 10: Storage policies

**Files:** Create `supabase/migrations/0044_storage_policies.sql`

Objects are namespaced `{orgId}/{siteId}/{floorId}.png` as of slice 1, which is what makes this expressible. Both buckets are private and every URL is signed server-side, so this is defence in depth rather than the primary control — the path is derived from a row that RLS already governs.

- [ ] **Step 1: Write the migration**

```sql
-- Slice 2, part 3: the same property for files that the table policies give for rows.
--
-- storage.objects is owned by supabase_storage_admin, so these policies are created by that owner's
-- privileges rather than by `postgres` — check the migration applies before assuming it can.
--
-- The leading path segment is the organisation, which is why slice 1 moved every object under one.
-- `(storage.foldername(name))[1]` is Supabase's own helper for that segment.
create policy floor_plans_tenant on storage.objects for all to app_tenant
  using (bucket_id = 'floor-plans' and (storage.foldername(name))[1] = current_org_id()::text)
  with check (bucket_id = 'floor-plans' and (storage.foldername(name))[1] = current_org_id()::text);

create policy avatars_tenant on storage.objects for all to app_tenant
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = current_org_id()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = current_org_id()::text);
```

- [ ] **Step 2: Apply it, and expect it may not be permitted**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/0044_storage_policies.sql
```

If this fails with `must be owner of table objects`, that is a real finding, not a blocker to work around: `postgres` is not a superuser here and does not own `storage.objects` — the same ownership limit that shaped slice 1's backup design. Report it, and note that storage remains protected by the service role and by paths derived from RLS-governed rows. Do not grant `postgres` more privilege to force it through.

- [ ] **Step 3: If it applied, prove it**

Upload a floor plan as one organisation, then attempt to read that object's path with a token minted for another. Expect a refusal.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0044_storage_policies.sql
git commit -m "Scope stored objects to the organisation in their path"
```

---

## Final verification, before the branch is finished

- [ ] `./node_modules/.bin/tsc --noEmit` — clean
- [ ] All five guards pass:

```bash
./node_modules/.bin/vitest run src/lib/supabase/policies.test.ts src/lib/supabase/isolation.test.ts src/lib/supabase/serviceRoleAllowlist.test.ts src/lib/supabase/grants.test.ts src/lib/supabase/tenancy.test.ts
```

- [ ] `REMAINING` is empty; `PERMANENT` holds exactly four paths.
- [ ] Replay from empty on a throwaway stack, and point the guards at it:

```bash
bash deploy/install.sh   # ndp.localhost / admin@ndp.test / Throwaway Admin / Org Alpha / throwaway-pass-123
GRANTS_TEST_CONTAINER=$(docker compose -f deploy/docker-compose.yml --env-file deploy/.env ps -q db) \
  ./node_modules/.bin/vitest run src/lib/supabase/policies.test.ts src/lib/supabase/tenancy.test.ts src/lib/supabase/grants.test.ts
docker compose -f deploy/docker-compose.yml --env-file deploy/.env down -v
```

- [ ] The application works end to end against the local stack: sign in, list clients, open a site, view a floor plan, open a rack, change a profile field, and confirm the activity log recorded it. **Every one of these must show real data** — an empty page is the failure mode this slice creates, and it does not raise.
- [ ] Update `docs/superpowers/specs/2026-08-06-multi-tenancy-data-model-design.md` to lift the one-organisation gate it states, since this slice is what that gate was waiting for. Do not lift it until every box above is ticked.
