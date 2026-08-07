import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

/** Every row has an owner — asserted against the live catalogue, not against a convention nobody
 *  reads. Read-only: it queries catalogue views and creates nothing. Deliberately NOT named
 *  *.integration.test.ts, because those wipe the database and are excluded from every run.
 *
 *  Same container override as grants.test.ts, so the same guard can be pointed at a deployed stack
 *  after its first migration run. */
const CONTAINER = process.env.GRANTS_TEST_CONTAINER || "supabase_db_network-doc-platform";

function sql(query: string): string[] {
  const out = execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-tAc", query],
    { encoding: "utf8" }
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Tables where a NULL org_id is legitimate, and why — sorted, because the assertion compares
 *  against a sorted list.
 *
 *  The three library tables: NULL means "standard, shared by every organisation".
 *
 *  activity_log: NULL means "a platform-level event belonging to no organisation". A refused
 *  sign-in from an address that belongs to nobody has no member and therefore no org, and
 *  authLog.ts records exactly that. Forcing not null there would make the insert fail and take the
 *  sign-in-refusal audit trail with it. The same nullability is also why activity_log cannot carry
 *  freeze_org_id: deleting a member sets its activity_log rows' org_id (and member_id) to NULL via
 *  ON DELETE SET NULL (0037), which is itself an UPDATE — a freeze trigger there would block the
 *  very demotion-to-platform-event that migration exists to allow. */
const NULLABLE_ORG_TABLES = ["activity_log", "brands", "device_templates", "device_types"];

describe("every row has an owning organisation", () => {
  it("gives every table in public an org_id", () => {
    const missing = sql(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname <> 'organisations'
        and not exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped
        )
      order by 1
    `);
    // A name here is a table added without deciding who owns its rows. Decide, then add the column.
    expect(missing).toEqual([]);
  });

  it("makes org_id not null everywhere a null would be meaningless", () => {
    const nullable = sql(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id'
      where n.nspname = 'public' and c.relkind = 'r' and not a.attnotnull
      order by 1
    `);
    // Exact equality both ways: a new nullable table fails here, and so does one of these four
    // quietly being tightened, which would break the sign-in-refusal log or the shared library.
    expect(nullable).toEqual(NULLABLE_ORG_TABLES);
  });

  it("carries org_id through every foreign key between two org-scoped tables", () => {
    // A single-column foreign key to an org-scoped parent is the hole: it permits a child of one
    // organisation to point at a parent of another. Library parents are exempt — their org_id is
    // nullable, so a composite key cannot express "the shared row or my own" (see 0036).
    const singleColumn = sql(`
      select conrelid::regclass::text || '.' || conname
      from pg_constraint fk
      join pg_class child on child.oid = fk.conrelid
      join pg_class parent on parent.oid = fk.confrelid
      join pg_namespace n on n.oid = child.relnamespace
      where fk.contype = 'f' and n.nspname = 'public'
        and array_length(fk.conkey, 1) = 1
        and parent.relname <> 'organisations'
        and parent.relname not in ('brands','device_types','device_templates')
      order by 1
    `);
    expect(singleColumn).toEqual([]);
  });

  it("scopes to the organisation every unique constraint that is not already scoped by a parent", () => {
    const rows = sql(`
      select conrelid::regclass::text || ' ' || conname
      from pg_constraint
      where contype in ('u','p') and connamespace = 'public'::regnamespace
        and conrelid::regclass::text in
            ('clients','brands','device_templates','device_types','app_settings')
        and not exists (
          select 1 from unnest(conkey) k
          join pg_attribute a on a.attrelid = conrelid and a.attnum = k
          where a.attname = 'org_id'
        )
      order by 1
    `);
    // Primary keys on `id` alone are fine — a uuid is globally unique by construction. Anything
    // else listed here is a constraint that would reject a second organisation's ordinary data.
    expect(rows).toEqual([
      "brands brands_pkey",
      "clients clients_pkey",
      "device_templates device_templates_pkey",
      "device_types device_types_pkey",
    ]);
  });

  it("still has each tenant-scoped unique constraint that 0037/0041 put there, not just correctly-shaped survivors", () => {
    // The assertion above only inspects constraints that currently EXIST: it flags one that is
    // present but missing org_id, but a constraint that was dropped outright leaves no row for it
    // to see, so a deleted clients_org_code_key is invisible to it and the suite stays green while
    // two organisations' clients can collide on `code` again. Proved by actually dropping it:
    // `alter table clients drop constraint clients_org_code_key` left every other assertion in this
    // file passing. This pins the full set by name and definition so deletion, not just
    // mis-scoping, is caught too.
    const rows = sql(`
      select conrelid::regclass::text || '.' || conname || ' :: ' || pg_get_constraintdef(oid)
      from pg_constraint
      where contype = 'u' and connamespace = 'public'::regnamespace
        and conrelid::regclass::text in ('clients','brands','device_templates','device_types')
      order by 1
    `);
    expect(rows).toEqual([
      "brands.brands_org_name_key :: UNIQUE NULLS NOT DISTINCT (org_id, name)",
      "clients.clients_org_code_key :: UNIQUE (org_id, code)",
      "clients.clients_org_id_unique :: UNIQUE (org_id, id)",
      "device_templates.device_templates_org_name_key :: UNIQUE NULLS NOT DISTINCT (org_id, name)",
      "device_types.device_types_org_category_name_key :: UNIQUE NULLS NOT DISTINCT (org_id, category, name)",
      "device_types.device_types_org_code_key :: UNIQUE NULLS NOT DISTINCT (org_id, code)",
    ]);
  });

  it("has no bare unique index hiding from the constraint-based check above", () => {
    // The previous assertion only sees uniqueness declared as a PRIMARY KEY or UNIQUE CONSTRAINT
    // (pg_constraint). connections' own uniqueness — connections_edge_uniq — is a bare
    // `create unique index`, which pg_constraint does not list at all: a query that only reads
    // pg_constraint would report zero unique constraints on connections and call the table clean,
    // while a real, unscoped uniqueness rule sat right next to it. This finds every unique index in
    // `public` that has no backing pg_constraint row, so a future bare index can't hide the same way.
    const bare = sql(`
      select indrelid::regclass::text || '.' || indexrelid::regclass::text
      from pg_index
      join pg_class ic on ic.oid = pg_index.indexrelid
      join pg_namespace n on n.oid = ic.relnamespace
      where n.nspname = 'public' and indisunique
        and not exists (select 1 from pg_constraint con where con.conindid = pg_index.indexrelid)
      order by 1
    `);
    // Pinned to the one that is known to exist and is fine: connections_edge_uniq is scoped by
    // rack_id, an org-scoped parent column, which is the same "already hangs off an org-scoped
    // parent" exemption README.md gives sites(client_id, code) and racks(room_id, code) — a
    // cross-tenant edge is unreachable without a cross-tenant rack_id first. A second name here is
    // a new bare unique index nobody has scoped yet.
    expect(bare).toEqual(["connections.connections_edge_uniq"]);

    const def = sql(`select pg_get_indexdef('connections_edge_uniq'::regclass)`)[0];
    expect(def).toMatch(/^CREATE UNIQUE INDEX connections_edge_uniq ON public\.connections USING btree \(rack_id,/);
  });

  it("keeps the shared library's uniqueness nulls-not-distinct", () => {
    // Without this, two shared rows with a NULL org are both accepted and the constraint silently
    // stops constraining the rows it exists to protect.
    const distinct = sql(`
      select conrelid::regclass::text || '.' || conname
      from pg_constraint
      where contype = 'u' and connamespace = 'public'::regnamespace
        and conrelid::regclass::text in ('brands','device_types','device_templates')
        and pg_get_constraintdef(oid) not like '%NULLS NOT DISTINCT%'
      order by 1
    `);
    expect(distinct).toEqual([]);
  });

  it("keeps the two deliberate global uniques global", () => {
    // Pinned so they are decisions rather than oversights. members.email: auth.users permits one
    // account per address. trusted_devices.token_hash: it is a secret, so a cross-org collision
    // would be a real one.
    const rows = sql(`
      select conname from pg_constraint
      where connamespace = 'public'::regnamespace and contype = 'u'
        and conname in ('members_email_key','trusted_devices_token_hash_key')
      order by 1
    `);
    expect(rows).toEqual(["members_email_key", "trusted_devices_token_hash_key"]);
  });

  it("stops org_id moving after insert on every org-scoped table that can be updated", () => {
    // inherit_org_id (0035) gets org_id right on INSERT. Nothing stops a plain UPDATE from moving
    // the row to a different organisation afterwards while every composite foreign key above still
    // points at the old owner — that is freeze_org_id (0035), a BEFORE UPDATE trigger that raises
    // when new.org_id is distinct from old.org_id. This checks it is actually attached, not just
    // defined: a function that exists but was never wired to a trigger guards nothing.
    //
    // Scoped to tables that both carry an `id` column (freeze_org_id reads OLD.id for its error
    // message and every trigger site keys off it) and have org_id NOT NULL (the four NULLABLE_ORG_
    // TABLES are excluded deliberately — three are the shared library, not yet org-editable, and
    // activity_log's org_id must legitimately transition to NULL when its member is deleted via
    // ON DELETE SET NULL, which a freeze trigger would block outright).
    const missing = sql(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and c.relname <> 'organisations'
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'id' and a.attnum > 0 and not a.attisdropped
        )
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped
        )
        and c.relname not in ('activity_log','brands','device_templates','device_types')
        and not exists (
          select 1 from pg_trigger t
          where t.tgrelid = c.oid and t.tgfoid = 'freeze_org_id'::regproc and not t.tgisinternal
        )
      order by 1
    `);
    // A name here is a table that gained org_id and an id column without inheriting the guard that
    // keeps a row from being reassigned to another organisation after it is created.
    expect(missing).toEqual([]);
  });
});
