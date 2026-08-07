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
