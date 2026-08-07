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
