-- Multi-tenancy slice 1, part 4 of 4: uniqueness that was global becomes per-organisation.
--
-- Two IT firms both having a client coded ACME is ordinary, not a conflict. Each of these would
-- otherwise reject the second organisation's perfectly reasonable data.
alter table clients drop constraint clients_code_key;
alter table clients add constraint clients_org_code_key unique (org_id, code);

-- `nulls not distinct` is load-bearing, not tidiness. On these three tables NULL org_id means
-- "shared standard", so without it Postgres treats every shared row as distinct and two shared
-- brands both named Cisco would BOTH be accepted — the constraint would silently stop constraining
-- exactly the rows it exists to protect. Requires Postgres 15+; this runs 17.6.
alter table brands drop constraint brands_name_key;
alter table brands add constraint brands_org_name_key unique nulls not distinct (org_id, name);

alter table device_templates drop constraint device_templates_name_key;
alter table device_templates add constraint device_templates_org_name_key
  unique nulls not distinct (org_id, name);

alter table device_types drop constraint device_types_code_key;
alter table device_types add constraint device_types_org_code_key
  unique nulls not distinct (org_id, code);

alter table device_types drop constraint device_types_category_name_key;
alter table device_types add constraint device_types_org_category_name_key
  unique nulls not distinct (org_id, category, name);

-- app_settings' primary key is NOT here — it moved to Task 3, migration 0036. Task 3's settings
-- upsert names `onConflict: "org_id,key"`, and Postgres rejects an ON CONFLICT target with no
-- matching unique index (42P10), so leaving the key change until now meant every settings save
-- failed for the two tasks in between. Found in review.

-- UNCHANGED, DELIBERATELY:
--   members.email stays globally unique. auth.users permits one account per address and members
--   links to it one-to-one, so a per-org email would allow two member rows where only one could
--   ever sign in. One person, one organisation — see the spec.
--   trusted_devices.token_hash stays globally unique. It is a secret; a collision across
--   organisations would be a real collision, not a naming coincidence.
--   The nine constraints already scoped by an org-scoped parent — sites(client_id, code),
--   floors(site_id, code), rooms(floor_id, code), racks(room_id, code),
--   rack_devices(rack_id, code), floor_devices(site_id, code), floor_plans(floor_id),
--   port_endpoints(rack_device_id, ...) and connections(rack_id, ...) — need no change.
