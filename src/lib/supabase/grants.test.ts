import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** What the publishable (`anon`) key can reach in schema `public`.
 *
 *  Every migration from 0001 to 0026 ended with
 *  `grant select, insert, update, delete on all tables in schema public to anon, authenticated` —
 *  copied forward 26 times, including into three migrations written specifically to RESTRICT
 *  access, each of which then had to undo it in the same file. Migration 0027 closed the surface.
 *  A note in a template would not have held; this asserts the actual state of the database instead.
 *
 *  READ-ONLY: it queries information_schema and pg_default_acl and asserts. It creates nothing and
 *  drops nothing. It is deliberately NOT named *.integration.test.ts — those wipe the database and
 *  are excluded from every run, and this one needs to run every time.
 *
 *  It shells out to psql through Docker, the same way every other database interaction in this repo
 *  does. If the container is not running this FAILS rather than skipping: a security guard that
 *  quietly stops guarding is worse than no guard at all. */
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
      order by 1
    `);
    // A failure here almost certainly means a new migration copied the pre-0027 blanket grant tail.
    // See supabase/migrations/README.md — new migrations should not grant to these roles at all.
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
    // both are granted — to both roles, because a signed-in request arrives as `authenticated`.
    expect(rows).toEqual([
      "anon members.disabled_at SELECT",
      "anon members.email SELECT",
      "authenticated members.disabled_at SELECT",
      "authenticated members.email SELECT",
    ]);
  });

  it("gives a table created by postgres nothing by default", () => {
    // Scoped to the `postgres`-owned default ACL on purpose. There are two sets on this schema, and
    // the other is owned by `supabase_admin`, which still grants anon a full arwdDxtm — migration
    // 0027 could not close it, because postgres is neither a superuser nor a member of that role.
    //
    // It does not matter here: every table in `public` is owned by postgres (migrations are applied
    // with `psql -U postgres`), so this is the set that decides what a new table inherits. And if
    // that ever stopped being true, the first test above catches the consequence directly, which is
    // why this one is allowed to be narrow.
    const acl = sql(`
      select coalesce(array_to_string(d.defaclacl, ','), '')
      from pg_default_acl d
      join pg_namespace n on n.oid = d.defaclnamespace
      where n.nspname = 'public'
        and d.defaclobjtype = 'r'
        and pg_get_userbyid(d.defaclrole) = 'postgres'
    `);
    expect(acl.length).toBeGreaterThan(0);
    for (const line of acl) {
      expect(line).not.toMatch(/(^|,)anon=/);
      expect(line).not.toMatch(/(^|,)authenticated=/);
    }
  });

  it("owns every public table as postgres, which is what makes the check above sufficient", () => {
    const owners = sql(`
      select distinct tableowner from pg_tables where schemaname = 'public' order by 1
    `);
    expect(owners).toEqual(["postgres"]);
  });
});
