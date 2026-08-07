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
    const wrongCount = sql(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      group by c.relname
      having count(p.oid) <> 1
      order by 1
    `);
    // A name here is a table with zero policies (one was dropped) or more than one (a neighbour was
    // added beside the tenant policy) — either way, the single-policy shape this test exists to pin
    // no longer holds.
    expect(wrongCount).toEqual([]);

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
