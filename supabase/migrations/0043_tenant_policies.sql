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
--
-- Every policy created below is permissive (the default). Postgres ORs permissive policies
-- together, not ANDs them, so this cuts both ways: a policy added later to any of these tables
-- does not narrow what's here, it widens it. If a future policy is meant to restrict access
-- further, it must be declared `as restrictive` — a plain `create policy` only adds more access.

-- clients
alter table clients enable row level security;
drop policy if exists single_org_all on clients;
drop policy if exists clients_tenant on clients;
create policy clients_tenant on clients for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- sites
alter table sites enable row level security;
drop policy if exists single_org_all on sites;
drop policy if exists sites_tenant on sites;
create policy sites_tenant on sites for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- floors
alter table floors enable row level security;
drop policy if exists single_org_all on floors;
drop policy if exists floors_tenant on floors;
create policy floors_tenant on floors for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- rooms
alter table rooms enable row level security;
drop policy if exists single_org_all on rooms;
drop policy if exists rooms_tenant on rooms;
create policy rooms_tenant on rooms for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- racks
alter table racks enable row level security;
drop policy if exists single_org_all on racks;
drop policy if exists racks_tenant on racks;
create policy racks_tenant on racks for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- rack_devices
alter table rack_devices enable row level security;
drop policy if exists single_org_all on rack_devices;
drop policy if exists rack_devices_tenant on rack_devices;
create policy rack_devices_tenant on rack_devices for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- connections
alter table connections enable row level security;
drop policy if exists single_org_all on connections;
drop policy if exists connections_tenant on connections;
create policy connections_tenant on connections for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- port_endpoints
alter table port_endpoints enable row level security;
drop policy if exists single_org_all on port_endpoints;
drop policy if exists port_endpoints_tenant on port_endpoints;
create policy port_endpoints_tenant on port_endpoints for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- floor_devices
alter table floor_devices enable row level security;
drop policy if exists single_org_all on floor_devices;
drop policy if exists floor_devices_tenant on floor_devices;
create policy floor_devices_tenant on floor_devices for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- floor_plans
alter table floor_plans enable row level security;
drop policy if exists single_org_all on floor_plans;
drop policy if exists floor_plans_tenant on floor_plans;
create policy floor_plans_tenant on floor_plans for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- members
alter table members enable row level security;
drop policy if exists single_org_all on members;
drop policy if exists members_tenant on members;
create policy members_tenant on members for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- activity_log
alter table activity_log enable row level security;
drop policy if exists single_org_all on activity_log;
drop policy if exists activity_log_tenant on activity_log;
create policy activity_log_tenant on activity_log for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- app_settings
alter table app_settings enable row level security;
drop policy if exists single_org_all on app_settings;
drop policy if exists app_settings_tenant on app_settings;
create policy app_settings_tenant on app_settings for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- trusted_devices (secret-bearing: not granted to app_tenant in 0042, but still scoped so a
-- future feature reaching for it through the tenant client fails loudly instead of quietly working)
alter table trusted_devices enable row level security;
drop policy if exists single_org_all on trusted_devices;
drop policy if exists trusted_devices_tenant on trusted_devices;
create policy trusted_devices_tenant on trusted_devices for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- device_challenges (secret-bearing, see trusted_devices above)
alter table device_challenges enable row level security;
drop policy if exists single_org_all on device_challenges;
drop policy if exists device_challenges_tenant on device_challenges;
create policy device_challenges_tenant on device_challenges for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- phone_verifications (secret-bearing, see trusted_devices above)
alter table phone_verifications enable row level security;
drop policy if exists single_org_all on phone_verifications;
drop policy if exists phone_verifications_tenant on phone_verifications;
create policy phone_verifications_tenant on phone_verifications for all to app_tenant
  using (org_id = current_org_id())
  with check (org_id = current_org_id());

-- The 3 library tables admit shared rows: NULL org_id means "standard, shared by every
-- organisation", a value means "created by, and private to, that organisation".

-- brands
alter table brands enable row level security;
drop policy if exists single_org_all on brands;
drop policy if exists brands_tenant on brands;
create policy brands_tenant on brands for all to app_tenant
  using (org_id is null or org_id = current_org_id())
  with check (org_id is null or org_id = current_org_id());

-- device_types
alter table device_types enable row level security;
drop policy if exists single_org_all on device_types;
drop policy if exists device_types_tenant on device_types;
create policy device_types_tenant on device_types for all to app_tenant
  using (org_id is null or org_id = current_org_id())
  with check (org_id is null or org_id = current_org_id());

-- device_templates
alter table device_templates enable row level security;
drop policy if exists single_org_all on device_templates;
drop policy if exists device_templates_tenant on device_templates;
create policy device_templates_tenant on device_templates for all to app_tenant
  using (org_id is null or org_id = current_org_id())
  with check (org_id is null or org_id = current_org_id());

-- organisations has no org_id: it is keyed on its own id, and read-only by grant (0042 grants
-- app_tenant select only, never insert/update/delete). It never carried single_org_all — that
-- policy lived on the unrelated, now-dropped `organizations` table from 0001, removed in 0008.
alter table organisations enable row level security;
drop policy if exists organisations_tenant on organisations;
create policy organisations_tenant on organisations for all to app_tenant
  using (id = current_org_id())
  with check (id = current_org_id());

-- `with check` appears on every policy above, including the tables app_tenant can only read.
-- Without it, `using` alone would gate what a query can SELECT but not what an INSERT or UPDATE
-- can WRITE: a row could be written into another organisation while being unable to be read back
-- afterward. Pairing both clauses closes that gap on every table, uniformly.
