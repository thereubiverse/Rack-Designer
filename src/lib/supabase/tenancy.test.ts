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

  it("still has each composite foreign key that keeps a child pointed at its own organisation's parent, not just correctly-shaped survivors", () => {
    // The assertion above only inspects foreign keys that currently EXIST: a dropped one leaves no
    // row for it to see, so it matches nothing and the suite stays green. Proved by actually
    // dropping one: `alter table sites drop constraint sites_client_fk` let a site point at another
    // organisation's client while every other assertion in this file kept passing. This pins the
    // full set of composite foreign keys by name and definition, so a deletion, a renaming, or a
    // silent change of ON DELETE behaviour are all caught, not just a missing org_id column.
    //
    // The list is deliberately exhaustive — built by reading every composite foreign key live in
    // the schema today — so a new cross-table relationship must be added to it consciously.
    const rows = sql(`
      select fk.conrelid::regclass::text || '.' || fk.conname || ' :: ' || pg_get_constraintdef(fk.oid)
      from pg_constraint fk
      join pg_class child on child.oid = fk.conrelid
      join pg_namespace n on n.oid = child.relnamespace
      where fk.contype = 'f' and n.nspname = 'public'
        and array_length(fk.conkey, 1) > 1
      order by 1
    `);
    expect(rows).toEqual([
      "activity_log.activity_log_member_fk :: FOREIGN KEY (org_id, member_id) REFERENCES members(org_id, id) ON DELETE SET NULL (member_id)",
      "connections.connections_a_rack_device_fk :: FOREIGN KEY (org_id, a_rack_device_id) REFERENCES rack_devices(org_id, id) ON DELETE CASCADE",
      "connections.connections_b_rack_device_fk :: FOREIGN KEY (org_id, b_rack_device_id) REFERENCES rack_devices(org_id, id) ON DELETE CASCADE",
      "connections.connections_rack_fk :: FOREIGN KEY (org_id, rack_id) REFERENCES racks(org_id, id) ON DELETE CASCADE",
      "device_challenges.device_challenges_device_fk :: FOREIGN KEY (org_id, device_id) REFERENCES trusted_devices(org_id, id) ON DELETE CASCADE",
      "floor_devices.floor_devices_floor_fk :: FOREIGN KEY (org_id, floor_id) REFERENCES floors(org_id, id) ON DELETE CASCADE",
      "floor_devices.floor_devices_room_fk :: FOREIGN KEY (org_id, room_id) REFERENCES rooms(org_id, id) ON DELETE SET NULL (room_id)",
      "floor_devices.floor_devices_site_fk :: FOREIGN KEY (org_id, site_id) REFERENCES sites(org_id, id) ON DELETE CASCADE",
      "floor_plans.floor_plans_floor_fk :: FOREIGN KEY (org_id, floor_id) REFERENCES floors(org_id, id) ON DELETE CASCADE",
      "floors.floors_site_fk :: FOREIGN KEY (org_id, site_id) REFERENCES sites(org_id, id) ON DELETE CASCADE",
      "phone_verifications.phone_verifications_member_fk :: FOREIGN KEY (org_id, member_id) REFERENCES members(org_id, id) ON DELETE CASCADE",
      "port_endpoints.port_endpoints_rack_device_fk :: FOREIGN KEY (org_id, rack_device_id) REFERENCES rack_devices(org_id, id) ON DELETE CASCADE",
      "port_endpoints.port_endpoints_rack_fk :: FOREIGN KEY (org_id, rack_id) REFERENCES racks(org_id, id) ON DELETE CASCADE",
      "port_endpoints.port_endpoints_target_rack_device_fk :: FOREIGN KEY (org_id, target_rack_device_id) REFERENCES rack_devices(org_id, id) ON DELETE CASCADE",
      "port_endpoints.port_endpoints_target_rack_fk :: FOREIGN KEY (org_id, target_rack_id) REFERENCES racks(org_id, id) ON DELETE CASCADE",
      "rack_devices.rack_devices_rack_fk :: FOREIGN KEY (org_id, rack_id) REFERENCES racks(org_id, id) ON DELETE CASCADE",
      "racks.racks_room_fk :: FOREIGN KEY (org_id, room_id) REFERENCES rooms(org_id, id) ON DELETE CASCADE",
      "rooms.rooms_floor_fk :: FOREIGN KEY (org_id, floor_id) REFERENCES floors(org_id, id) ON DELETE CASCADE",
      "sites.sites_client_fk :: FOREIGN KEY (org_id, client_id) REFERENCES clients(org_id, id) ON DELETE CASCADE",
      "trusted_devices.trusted_devices_member_fk :: FOREIGN KEY (org_id, member_id) REFERENCES members(org_id, id) ON DELETE CASCADE",
    ]);
  });

  it("keeps every unique constraint and primary key in public either org-scoped or deliberately excepted, pinned by name and definition", () => {
    // An earlier version of this check only inspected five hardcoded tables, so a `unique (code)`
    // on any other table was invisible to it. Live proof the gap was real:
    // `members_auth_user_id_key UNIQUE (auth_user_id)` sat outside every list and was checked by
    // nothing. Scanning every unique constraint and primary key in `public` and requiring each to
    // appear on this explicit list means a constraint added anywhere — org-scoped or not — fails
    // the guard until someone adds it here consciously. Pinning the full definition, not just the
    // name, also catches a dropped or redefined constraint the same way the foreign-key check above
    // does (Finding 1's proof applies here too: re-creating `members_email_key` as
    // `unique (org_id, email)` would pass a name-only check but fails this one).
    //
    // This subsumes the narrower "keeps the two deliberate global uniques global" check that used
    // to live here as its own test — `members_email_key` and `trusted_devices_token_hash_key` are
    // pinned by full definition below, so a second assertion of just their names would be
    // redundant.
    //
    // The list is deliberately exhaustive — built by reading every unique/primary-key constraint
    // live in the schema today — so a new one must be added to it consciously, with a reason.
    const rows = sql(`
      select con.conrelid::regclass::text || '.' || con.conname || ' :: ' || pg_get_constraintdef(con.oid)
      from pg_constraint con
      join pg_namespace n on n.oid = con.connamespace
      where con.contype in ('u','p') and n.nspname = 'public'
      order by 1
    `);
    expect(rows).toEqual([
      // Primary keys on `id` alone — a uuid is globally unique by construction.
      "activity_log.activity_log_pkey :: PRIMARY KEY (id)",
      // app_settings' key is (org_id, key) directly — org-scoped by construction.
      "app_settings.app_settings_pkey :: PRIMARY KEY (org_id, key)",
      // Org-scoped: org_id sits directly in the constraint's own key.
      "brands.brands_org_name_key :: UNIQUE NULLS NOT DISTINCT (org_id, name)",
      "brands.brands_pkey :: PRIMARY KEY (id)",
      "clients.clients_org_code_key :: UNIQUE (org_id, code)",
      "clients.clients_org_id_unique :: UNIQUE (org_id, id)",
      "clients.clients_pkey :: PRIMARY KEY (id)",
      "connections.connections_pkey :: PRIMARY KEY (id)",
      // A single foreign-key column, one row per device: device_id is itself a uuid that already
      // belongs to exactly one organisation (via trusted_devices), so it is globally unique by the
      // same construction as `id` above.
      "device_challenges.device_challenges_pkey :: PRIMARY KEY (device_id)",
      "device_templates.device_templates_org_name_key :: UNIQUE NULLS NOT DISTINCT (org_id, name)",
      "device_templates.device_templates_pkey :: PRIMARY KEY (id)",
      "device_types.device_types_org_category_name_key :: UNIQUE NULLS NOT DISTINCT (org_id, category, name)",
      "device_types.device_types_org_code_key :: UNIQUE NULLS NOT DISTINCT (org_id, code)",
      "device_types.device_types_pkey :: PRIMARY KEY (id)",
      "floor_devices.floor_devices_pkey :: PRIMARY KEY (id)",
      // Already scoped by an org-scoped parent column: site_id already ties the row to exactly one
      // organisation, so the child needs no org_id of its own — same exemption as sites(client_id,
      // code) and racks(room_id, code) in README.md.
      "floor_devices.floor_devices_site_id_code_key :: UNIQUE (site_id, code)",
      // A single foreign-key column, one row per floor: floor_id is already globally unique via
      // floors, same reasoning as device_challenges_pkey above.
      "floor_plans.floor_plans_floor_id_key :: UNIQUE (floor_id)",
      "floor_plans.floor_plans_pkey :: PRIMARY KEY (id)",
      "floors.floors_org_id_unique :: UNIQUE (org_id, id)",
      "floors.floors_pkey :: PRIMARY KEY (id)",
      "floors.floors_site_id_code_key :: UNIQUE (site_id, code)",
      // Supabase's auth.users permits one account per address, and members link one-to-one, so a
      // per-org variant would allow two member rows where only one could ever sign in.
      "members.members_auth_user_id_key :: UNIQUE (auth_user_id)",
      "members.members_email_key :: UNIQUE (email)",
      "members.members_org_id_unique :: UNIQUE (org_id, id)",
      "members.members_pkey :: PRIMARY KEY (id)",
      "organisations.organisations_pkey :: PRIMARY KEY (id)",
      // A single foreign-key column, one row per member: member_id is already globally unique via
      // members, same reasoning as device_challenges_pkey above.
      "phone_verifications.phone_verifications_pkey :: PRIMARY KEY (member_id)",
      "port_endpoints.port_endpoints_pkey :: PRIMARY KEY (id)",
      // Already scoped by an org-scoped parent column: rack_device_id already ties the row to
      // exactly one organisation.
      "port_endpoints.port_endpoints_port_uniq :: UNIQUE (rack_device_id, side, group_id, port_index) DEFERRABLE INITIALLY DEFERRED",
      "rack_devices.rack_devices_org_id_unique :: UNIQUE (org_id, id)",
      "rack_devices.rack_devices_pkey :: PRIMARY KEY (id)",
      "rack_devices.rack_devices_rack_id_code_key :: UNIQUE (rack_id, code) DEFERRABLE INITIALLY DEFERRED",
      "racks.racks_org_id_unique :: UNIQUE (org_id, id)",
      "racks.racks_pkey :: PRIMARY KEY (id)",
      "racks.racks_room_id_code_key :: UNIQUE (room_id, code)",
      "rooms.rooms_floor_id_code_key :: UNIQUE (floor_id, code)",
      "rooms.rooms_org_id_unique :: UNIQUE (org_id, id)",
      "rooms.rooms_pkey :: PRIMARY KEY (id)",
      "sites.sites_client_id_code_key :: UNIQUE (client_id, code)",
      "sites.sites_org_id_unique :: UNIQUE (org_id, id)",
      "sites.sites_pkey :: PRIMARY KEY (id)",
      "trusted_devices.trusted_devices_org_id_unique :: UNIQUE (org_id, id)",
      "trusted_devices.trusted_devices_pkey :: PRIMARY KEY (id)",
      // It is a secret; a cross-organisation collision would be a real collision, not an ordinary
      // naming clash.
      "trusted_devices.trusted_devices_token_hash_key :: UNIQUE (token_hash)",
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

  // The two deliberate global uniques (members_email_key, trusted_devices_token_hash_key) used to
  // be pinned by name in a standalone test here. They are now pinned by full definition inside
  // "keeps every unique constraint and primary key in public either org-scoped or deliberately
  // excepted, pinned by name and definition" above, which subsumes this check — see that test's
  // comment. A second, name-only assertion here would be redundant with a weaker guarantee.

  it("gives every child of an org-scoped parent the inherit_org_id trigger that stamps its owner", () => {
    // Step 3 of README.md's five is half a trigger and half a foreign key, and only the foreign-key
    // half was ever asserted here — inherit_org_id appeared in this file exclusively as a mention in
    // the comment below, and no query touched it. That made README.md's "Skip any of the five steps
    // above and that test fails" untrue: every inheritance trigger in 0035 could be dropped and this
    // suite stayed green, while the column they populate is what the composite foreign keys above,
    // and every storage path built from a row's org_id, actually rely on.
    //
    // Generic, so table 21 is covered without anyone remembering to come back here: a composite
    // foreign key is precisely the marker of "this table has an org-scoped parent", so any table
    // carrying one must also carry the trigger that reads org_id from that parent.
    //
    // `tgenabled <> 'D'` because `alter table … disable trigger` leaves the pg_trigger row in place:
    // an existence check alone would call a disabled trigger present while it stamps nothing. The
    // freeze check below carries the same clause for the same reason.
    const missing = sql(`
      select distinct child.relname
      from pg_constraint fk
      join pg_class child on child.oid = fk.conrelid
      join pg_namespace n on n.oid = child.relnamespace
      where fk.contype = 'f' and n.nspname = 'public'
        and array_length(fk.conkey, 1) > 1
        and not exists (
          select 1 from pg_trigger t
          where t.tgrelid = child.oid and t.tgfoid = 'inherit_org_id'::regproc and not t.tgisinternal
            and t.tgenabled <> 'D'
        )
      order by 1
    `);
    // A name here is a table whose org_id is whatever the caller passed rather than whatever its
    // parent owns — the exact drift 0035 exists to make impossible.
    expect(missing).toEqual([]);

    // The check above only sees tables that HAVE a composite foreign key, so it cannot notice a
    // trigger pointed at the wrong parent, or one whose arguments were edited. Pinning the full
    // definition catches both: the parent table and the local foreign-key column are trigger
    // arguments, so `floors_inherit_org` reading 'clients','client_id' instead of 'sites','site_id'
    // fails here even though the trigger still exists on the right table. Same reasoning, and the
    // same exhaustive-list discipline, as the composite-foreign-key assertion above.
    const defs = sql(`
      select c.relname || '.' || t.tgname || ' :: ' || pg_get_triggerdef(t.oid)
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and not t.tgisinternal
        and t.tgfoid = 'inherit_org_id'::regproc
      order by 1
    `);
    expect(defs).toEqual([
      "activity_log.activity_log_inherit_org :: CREATE TRIGGER activity_log_inherit_org BEFORE INSERT ON public.activity_log FOR EACH ROW EXECUTE FUNCTION inherit_org_id('members', 'member_id')",
      "connections.connections_inherit_org :: CREATE TRIGGER connections_inherit_org BEFORE INSERT ON public.connections FOR EACH ROW EXECUTE FUNCTION inherit_org_id('racks', 'rack_id')",
      // Two hops from its root (device_challenges -> trusted_devices -> members): it reads the org
      // trusted_devices already carries rather than walking the chain.
      "device_challenges.device_challenges_inherit_org :: CREATE TRIGGER device_challenges_inherit_org BEFORE INSERT ON public.device_challenges FOR EACH ROW EXECUTE FUNCTION inherit_org_id('trusted_devices', 'device_id')",
      "floor_devices.floor_devices_inherit_org :: CREATE TRIGGER floor_devices_inherit_org BEFORE INSERT ON public.floor_devices FOR EACH ROW EXECUTE FUNCTION inherit_org_id('sites', 'site_id')",
      // The one uploadFloorPlanAction's storage prefix is derived from — the floor, not the caller.
      "floor_plans.floor_plans_inherit_org :: CREATE TRIGGER floor_plans_inherit_org BEFORE INSERT ON public.floor_plans FOR EACH ROW EXECUTE FUNCTION inherit_org_id('floors', 'floor_id')",
      "floors.floors_inherit_org :: CREATE TRIGGER floors_inherit_org BEFORE INSERT ON public.floors FOR EACH ROW EXECUTE FUNCTION inherit_org_id('sites', 'site_id')",
      "phone_verifications.phone_verifications_inherit_org :: CREATE TRIGGER phone_verifications_inherit_org BEFORE INSERT ON public.phone_verifications FOR EACH ROW EXECUTE FUNCTION inherit_org_id('members', 'member_id')",
      "port_endpoints.port_endpoints_inherit_org :: CREATE TRIGGER port_endpoints_inherit_org BEFORE INSERT ON public.port_endpoints FOR EACH ROW EXECUTE FUNCTION inherit_org_id('racks', 'rack_id')",
      "rack_devices.rack_devices_inherit_org :: CREATE TRIGGER rack_devices_inherit_org BEFORE INSERT ON public.rack_devices FOR EACH ROW EXECUTE FUNCTION inherit_org_id('racks', 'rack_id')",
      "racks.racks_inherit_org :: CREATE TRIGGER racks_inherit_org BEFORE INSERT ON public.racks FOR EACH ROW EXECUTE FUNCTION inherit_org_id('rooms', 'room_id')",
      "rooms.rooms_inherit_org :: CREATE TRIGGER rooms_inherit_org BEFORE INSERT ON public.rooms FOR EACH ROW EXECUTE FUNCTION inherit_org_id('floors', 'floor_id')",
      "sites.sites_inherit_org :: CREATE TRIGGER sites_inherit_org BEFORE INSERT ON public.sites FOR EACH ROW EXECUTE FUNCTION inherit_org_id('clients', 'client_id')",
      "trusted_devices.trusted_devices_inherit_org :: CREATE TRIGGER trusted_devices_inherit_org BEFORE INSERT ON public.trusted_devices FOR EACH ROW EXECUTE FUNCTION inherit_org_id('members', 'member_id')",
    ]);
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
        and c.relname not in (${NULLABLE_ORG_TABLES.map((t) => `'${t}'`).join(",")})
        and not exists (
          select 1 from pg_trigger t
          where t.tgrelid = c.oid and t.tgfoid = 'freeze_org_id'::regproc and not t.tgisinternal
            and t.tgenabled <> 'D'
        )
      order by 1
    `);
    // A name here is a table that gained org_id and an id column without inheriting the guard that
    // keeps a row from being reassigned to another organisation after it is created.
    expect(missing).toEqual([]);
  });
});
