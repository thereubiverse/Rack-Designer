import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** What the publishable (`anon`) key can reach in schema `public`.
 *
 *  Every migration from 0001 to 0026 ended with
 *  `grant select, insert, update, delete on all tables in schema public to anon, authenticated` —
 *  copied forward 26 times, including into three migrations written specifically to RESTRICT
 *  access, each of which then had to undo it in the same file. Migration 0027 closed the surface and
 *  0028 corrected two mistakes in it. A note in a template would not have held; this asserts the
 *  actual state of the database instead.
 *
 *  READ-ONLY: it queries catalogue views and asserts. It creates nothing and drops nothing. It is
 *  deliberately NOT named *.integration.test.ts — those wipe the database and are excluded from
 *  every run, and this one needs to run every time.
 *
 *  It shells out to psql through Docker, the same way every other database interaction in this repo
 *  does. If the container is not running this FAILS rather than skipping: a security guard that
 *  quietly stops guarding is worse than no guard at all.
 *
 *  The container name is overridable with GRANTS_TEST_CONTAINER, defaulting to the local dev stack
 *  below so this run is unchanged when the variable is unset. That lets the same guard be pointed at
 *  a deployed stack after its first migration run — see supabase/migrations/README.md — which is the
 *  only way to know the anon surface is closed THERE, not just here. */
const CONTAINER = process.env.GRANTS_TEST_CONTAINER || "supabase_db_network-doc-platform";

function sql(query: string): string[] {
  const out = execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query],
    { encoding: "utf8" }
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** EFFECTIVE privilege, not granted privilege.
 *
 *  The first version of this file read information_schema.role_table_grants, which does not list
 *  privileges granted to PUBLIC — so `grant select on clients to public` left anon able to read
 *  every client while all the assertions stayed green. Verified in a rolled-back transaction:
 *  role_table_grants showed 0 rows for anon while has_table_privilege('anon', 'clients', 'select')
 *  was already true.
 *
 *  has_table_privilege resolves PUBLIC, role membership and inheritance, so it answers the question
 *  that actually matters: can this role touch this table, by any route at all? */
const PRIVILEGES = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];

describe("the publishable key's reach into schema public", () => {
  it("cannot touch a single table, by any route including PUBLIC", () => {
    const checks = PRIVILEGES.map((p) => `has_table_privilege(r.rolname, c.oid, '${p}')`).join(" or ");
    const rows = sql(`
      select r.rolname || ' ' || c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
      where n.nspname = 'public' and c.relkind in ('r','p','v','m')
        and (${checks})
      order by 1
    `);
    // A failure here almost certainly means a new migration carried a grant tail.
    // See supabase/migrations/README.md — new migrations grant nothing to these roles.
    expect(rows).toEqual([]);
  });

  it("holds exactly one documented column grant, and nothing else", () => {
    const rows = sql(`
      select grantee || ' ' || table_name || '.' || column_name || ' ' || privilege_type
      from information_schema.column_privileges
      where grantee in ('anon','authenticated') and table_schema = 'public'
      order by 1
    `);
    // src/middleware.ts checks membership on every request using the publishable key, because it
    // runs on the Edge runtime where the server-only service client cannot be imported. It selects
    // disabled_at filtered by email, and Postgres requires SELECT on a column to filter by it, so
    // both are granted.
    //
    // `authenticated` only: the middleware returns early when getUser() finds no user, so that query
    // only ever runs for a request carrying a JWT, which reaches PostgREST as `authenticated`. anon
    // held this until 0028, which let anyone with the publishable key list every member's email.
    expect(rows).toEqual([
      "authenticated members.disabled_at SELECT",
      "authenticated members.email SELECT",
    ]);
  });

  it("holds exactly one documented function grant, and nothing else", () => {
    // claim_phone_verification is SECURITY-sensitive and 0024 had to revoke it from PUBLIC
    // explicitly, for the same reason the table check above uses has_*_privilege: a grant to PUBLIC
    // is invisible to the grantee-listing views.
    //
    // is_device_trusted (0029) is the one deliberate exception: middleware runs on the Edge runtime
    // with the publishable key and must ask "is this device trusted for this member" without ever
    // gaining read access to trusted_devices itself. A security-definer function that answers one
    // yes/no question is the narrow surface; granting authenticated execute on it is the point of
    // that migration, not a leak. anon must still get nothing — the middleware only ever calls this
    // once getUser() has already succeeded, so the request always reaches PostgREST as authenticated.
    const rows = sql(`
      select r.rolname || ' ' || p.proname
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join (select rolname from pg_roles where rolname in ('anon','authenticated')) r
      where n.nspname = 'public' and has_function_privilege(r.rolname, p.oid, 'execute')
      order by 1
    `);
    expect(rows).toEqual(["authenticated is_device_trusted"]);
  });

  it("gives a table created by postgres nothing, while keeping it usable by the app", () => {
    // Scoped to the `postgres`-owned default ACL: there are two sets on this schema, and the other
    // is owned by `supabase_admin`, which still grants anon a full arwdDxtm and cannot be altered
    // from the postgres role. Every table in `public` is postgres-owned, so this is the set that
    // decides what a new table inherits — and the first assertion catches an exposed table anyway,
    // whichever set produced it.
    //
    // The service_role half matters just as much in the other direction: 0027 originally left
    // service_role with no DML on new tables, which would have made the first table written under
    // the new convention unreadable by all 61 server actions. 0028 fixed it; this pins it.
    const acl = sql(`
      select coalesce(array_to_string(d.defaclacl, ','), '')
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname = 'public' and d.defaclobjtype = 'r'
        and pg_get_userbyid(d.defaclrole) = 'postgres'
    `);
    expect(acl.length).toBeGreaterThan(0);
    for (const line of acl) {
      expect(line).not.toMatch(/(^|,)anon=/);
      expect(line).not.toMatch(/(^|,)authenticated=/);
      // arwd = SELECT, INSERT, UPDATE, DELETE. Without these a new table is dead to the app.
      expect(line).toMatch(/(^|,)service_role=[a-zA-Z]*a/);
      expect(line).toMatch(/(^|,)service_role=[a-zA-Z]*r/);
      expect(line).toMatch(/(^|,)service_role=[a-zA-Z]*w/);
      expect(line).toMatch(/(^|,)service_role=[a-zA-Z]*d/);
    }
  });

  it("gives a function or sequence created by postgres nothing either", () => {
    // 0027 closed the default privileges for TABLES and stopped there, and the gap was invisible
    // here: the local Supabase CLI stack and a fresh supabase/postgres image ship DIFFERENT defaults.
    // The image grants anon and authenticated EXECUTE on every function created in this schema, so on
    // a real deployment both device functions were born reachable by the publishable key — while this
    // file, pointed only at the CLI stack, stayed green. Pointing it at an installed stack via
    // GRANTS_TEST_CONTAINER is what found it, and a POST to /rest/v1/rpc/consume_device_attempt
    // carrying nothing but the publishable key returned the device-approval code in plaintext.
    //
    // The per-function `revoke ... from public` that 0029-0031 each carry does not cover this: it
    // removes the implicit world grant, not an explicit grant held by the roles themselves. 0032
    // closes the defaults; this pins them so the next `create function` cannot quietly reopen it.
    //
    // Deliberately asserts only that anon and authenticated are absent — unlike the table check
    // above, which also pins service_role. The two stacks legitimately differ on service_role here
    // (the image grants it EXECUTE by default, the CLI does not) and every function this app defines
    // grants service_role explicitly, so requiring it would fail on one stack for no benefit.
    for (const objtype of ["f", "S"]) {
      const acl = sql(`
        select coalesce(array_to_string(d.defaclacl, ','), '')
        from pg_default_acl d
        join pg_namespace n on n.oid = d.defaclnamespace
        where n.nspname = 'public' and d.defaclobjtype = '${objtype}'
          and pg_get_userbyid(d.defaclrole) = 'postgres'
      `);
      // A missing row is a failure, not a pass. For functions the built-in default is
      // PUBLIC = EXECUTE, so "no row" is the wide-open state this exists to prevent.
      expect(acl.length, `no postgres-owned default ACL for objtype ${objtype}`).toBeGreaterThan(0);
      for (const line of acl) {
        expect(line, `objtype ${objtype}`).not.toMatch(/(^|,)anon=/);
        expect(line, `objtype ${objtype}`).not.toMatch(/(^|,)authenticated=/);
      }
    }
  });

  it("owns every public table as postgres, which is what makes the default-ACL check sufficient", () => {
    const owners = sql(`select distinct tableowner from pg_tables where schemaname = 'public' order by 1`);
    expect(owners).toEqual(["postgres"]);
  });
});
