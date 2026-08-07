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

/** THE ONE POLICY IN THIS SCHEMA THAT IS NOT A TENANT POLICY, exempted by name from the three
 *  assertions below that describe the tenant wall's shape (`for all` + `to app_tenant` + `with
 *  check`). It is none of those things, deliberately, and every one of those differences is
 *  load-bearing rather than an oversight — so it is excluded here explicitly, by name, instead of by
 *  loosening the rules that hold the wall up.
 *
 *  WHY IT EXISTS. `src/middleware.ts` checks membership on EVERY request, and it runs on the Edge
 *  runtime with the publishable key plus the user's session — which reaches PostgREST as
 *  `authenticated`, not `service_role` and not `app_tenant`. It cannot use the service client: that
 *  module is `server-only`. Migration 0043 enabled RLS on `members` and gave it one policy, for
 *  `app_tenant` alone, which left `authenticated` with a column grant and NO applicable policy — and
 *  RLS returns zero rows in that situation, silently. `isActiveMember` reads zero rows as "not a
 *  member", so every real member was redirected to /login forever and interactive sign-in was
 *  completely broken. Nothing else caught it because the rest of the application queries as
 *  `service_role`, which bypasses RLS. Migration 0044 is what makes signing in possible at all; if
 *  this policy is ever dropped, the whole application locks every member out.
 *
 *  WHY IT IS STILL A TIGHTENING. Before 0043 there was no RLS on this table, so 0028's
 *  `select (email, disabled_at) on members to authenticated` exposed EVERY member row to anyone
 *  holding the publishable key and any session — the member-enumeration surface
 *  `supabase/migrations/README.md` complains about. This policy admits exactly one row, the caller's
 *  own, which the "narrower, not wider" test below measures rather than assumes.
 *
 *  It is `for select` only, so it has no `with check` — SQL does not permit one on a SELECT policy,
 *  and there is nothing to check: `authenticated` holds no insert/update/delete grant on `members`. */
const MEMBERS_SELF = "members_self";

describe("the tenant wall", () => {
  it("enables row level security on every table", () => {
    const off = sql(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1
    `);
    expect(off).toEqual([]);
  });

  it("gives every table a tenant policy, for app_tenant, with both using and with check", () => {
    // `members_self` is excluded by name (see MEMBERS_SELF above): it is granted to `authenticated`,
    // not app_tenant, and being `for select` it has no `with check`. Exempting that ONE policy by
    // name keeps this assertion exact for every other policy in the schema — the alternative,
    // relaxing the role or with-check clauses generally, would stop this test noticing a tenant
    // policy that quietly lost its `with check`.
    const wrong = sql(`
      select c.relname || ' -> ' || coalesce(p.polname, '(no policy)')
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
        and coalesce(p.polname, '') <> '${MEMBERS_SELF}'
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

  it("has exactly one policy per table, and it is the tenant policy nobody added a neighbour to", () => {
    // THE GAP THIS TEST CLOSES. The previous test iterates over policy rows: a second, perfectly
    // well-formed permissive policy sitting next to a good one satisfies every clause in it, because
    // Postgres ORs permissive policies together and the query never counts. That is exactly the shape
    // of the bug this slice exists to close — `single_org_all` was a second permissive policy, and it
    // made the tenant policies decorative — and it is exactly what the previous test would still miss
    // today: `create policy clients_extra on clients for all to app_tenant using (org_id is not
    // null)` passes every earlier assertion here while widening clients to every row with a non-null
    // org_id in the database.
    //
    // Counting per table, over every table in `public` rather than over existing policy rows, is what
    // makes a dropped policy visible too: a query that only iterates `pg_policy` finds nothing to
    // iterate once the row is gone and reports the suite clean, which this project has hit before.
    //
    // The EXACT number is pinned per table, rather than "one or more". Every table carries exactly
    // one policy except `members`, which carries two — its tenant policy and `members_self` (see
    // MEMBERS_SELF above). Pinning 2 rather than loosening the rule is the point: a THIRD policy on
    // `members`, which is precisely where a careless neighbour would now be added because two is
    // already "normal" there, still fails this assertion. A dropped policy shows up as a 0, and a
    // newly created table with no policy at all shows up as its own row, because this counts over
    // every table in `public` rather than over the rows of pg_policy.
    const counts = sql(`
      select c.relname || ' -> ' || count(p.oid)
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      group by c.relname
      order by 1
    `);
    expect(counts).toEqual([
      "activity_log -> 1",
      "app_settings -> 1",
      "brands -> 1",
      "clients -> 1",
      "connections -> 1",
      "device_challenges -> 1",
      "device_templates -> 1",
      "device_types -> 1",
      "floor_devices -> 1",
      "floor_plans -> 1",
      "floors -> 1",
      // Two, and only ever two: members_tenant + members_self. See MEMBERS_SELF above.
      "members -> 2",
      "organisations -> 1",
      "phone_verifications -> 1",
      "port_endpoints -> 1",
      "rack_devices -> 1",
      "racks -> 1",
      "rooms -> 1",
      "sites -> 1",
      "trusted_devices -> 1",
    ]);

    // Pins each table's one policy by name and by what it actually checks, not just that a
    // well-formed policy is present — the previous test never noticed clients_tenant's own qual
    // being replaced by `using (true)` so long as the name and the not-null shape stayed put. The
    // list below is deliberately exhaustive: built by reading every policy live in the schema today,
    // so a policy added, renamed, dropped, or reworded anywhere must be added here consciously.
    const rows = sql(`
      select c.relname || '.' || p.polname || ' :: ' || pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
      order by 1
    `);
    expect(rows).toEqual([
      "activity_log.activity_log_tenant :: (org_id = current_org_id())",
      "app_settings.app_settings_tenant :: (org_id = current_org_id())",
      "brands.brands_tenant :: ((org_id IS NULL) OR (org_id = current_org_id()))",
      "clients.clients_tenant :: (org_id = current_org_id())",
      "connections.connections_tenant :: (org_id = current_org_id())",
      "device_challenges.device_challenges_tenant :: (org_id = current_org_id())",
      "device_templates.device_templates_tenant :: ((org_id IS NULL) OR (org_id = current_org_id()))",
      "device_types.device_types_tenant :: ((org_id IS NULL) OR (org_id = current_org_id()))",
      "floor_devices.floor_devices_tenant :: (org_id = current_org_id())",
      "floor_plans.floor_plans_tenant :: (org_id = current_org_id())",
      "floors.floors_tenant :: (org_id = current_org_id())",
      // MIGRATION 0044, AND THE REASON SIGNING IN WORKS AT ALL. Granted to `authenticated` — the role
      // src/middleware.ts's membership check actually runs as — and admitting only the caller's own
      // row. Without it `members` has RLS on and no policy for that role, which returns zero rows
      // silently, which isActiveMember reads as "not a member": every member redirected to /login,
      // forever. See MEMBERS_SELF at the top of this file. The doubled NULLIF is deliberate: the
      // inner one runs BEFORE the ::json cast, because an empty GUC would otherwise raise
      // "invalid input syntax for type json", and the middleware fails OPEN on a query error — an
      // error here would wave every request through with the membership gate silently off.
      "members.members_self :: (email = lower(NULLIF(((NULLIF(current_setting('request.jwt.claims'::text, true), ''::text))::json ->> 'email'::text), ''::text)))",
      "members.members_tenant :: (org_id = current_org_id())",
      "organisations.organisations_tenant :: (id = current_org_id())",
      "phone_verifications.phone_verifications_tenant :: (org_id = current_org_id())",
      "port_endpoints.port_endpoints_tenant :: (org_id = current_org_id())",
      "rack_devices.rack_devices_tenant :: (org_id = current_org_id())",
      "racks.racks_tenant :: (org_id = current_org_id())",
      "rooms.rooms_tenant :: (org_id = current_org_id())",
      "sites.sites_tenant :: (org_id = current_org_id())",
      "trusted_devices.trusted_devices_tenant :: (org_id = current_org_id())",
    ]);
  });

  it("has no permissive policy that permits everything, or applies to PUBLIC", () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Postgres ORs permissive policies together, so one
    // `using (true)` defeats every other policy on the table. Twelve tables carried exactly that
    // from migrations 0001-0008, and the spike measured the result: a token scoped to one
    // organisation saw both organisations' rows, and a token with no organisation saw everything.
    //
    // `members_self` is exempt from the WITH CHECK half alone, and only that half. It is a `for
    // select` policy, so polwithcheck is legitimately null and the coalesce would read it as
    // `true` — but a SELECT policy has no write path for a missing `with check` to leave open, and
    // Postgres rejects the clause on one outright. Its `using` expression is still held to the same
    // standard as every other policy by the same query, and it is still checked for PUBLIC.
    const permissive = sql(`
      select polrelid::regclass::text || '.' || polname
      from pg_policy
      where coalesce(pg_get_expr(polqual, polrelid), 'true') = 'true'
         or (polname <> '${MEMBERS_SELF}'
             and coalesce(pg_get_expr(polwithcheck, polrelid), 'true') = 'true')
         or polroles = '{0}'
      order by 1
    `);
    expect(permissive).toEqual([]);

    // ...and the exemption above is only safe because members_self is SELECT-only. Pin that, so
    // widening it to `for all` (which would make the missing `with check` a real write hole) fails
    // here rather than passing quietly through the exemption.
    expect(sql(`select polcmd from pg_policy where polname = '${MEMBERS_SELF}'`)).toEqual(["r"]);
  });

  it("lets authenticated read its OWN members row and nobody else's", () => {
    // THE REGRESSION THIS EXISTS FOR, measured rather than inferred from the catalogue. Migration
    // 0043 left `authenticated` with no policy on `members`, so this query returned 0 and every
    // member was bounced to /login forever. A catalogue check cannot see that; counting visible rows
    // under a real role with real claims can.
    //
    // Wrapped in begin/rollback and reads only — it writes nothing to this database.
    // psql echoes a command tag per statement even under -tA, so BEGIN/SET/ROLLBACK are dropped and
    // only the SELECT's output is compared.
    const TAGS = new Set(["BEGIN", "SET", "ROLLBACK", "COMMIT"]);
    const visible = (email: string) =>
      sql(`
        begin;
        set local role authenticated;
        set local request.jwt.claims = '{"email":"${email}","role":"authenticated"}';
        select coalesce(string_agg(email, ','), '(none)') from members;
        rollback;
      `).filter((line) => !TAGS.has(line));

    const members = sql(`select email from members order by 1`);
    expect(members.length).toBeGreaterThan(1); // otherwise "cannot see the other one" proves nothing

    // Each member sees exactly their own row, and therefore NOT the other member's — which is
    // strictly narrower than before RLS, when this grant exposed every row to any session at all.
    for (const email of members) expect(visible(email)).toEqual([email]);

    // A valid session for somebody who is not a member sees nothing.
    expect(visible("stranger@example.com")).toEqual(["(none)"]);
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
