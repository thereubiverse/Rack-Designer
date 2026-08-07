-- Slice 2, part 3: the same property for stored files that the table policies give for rows.
--
-- The brief named this 0044_storage_policies.sql; 0044 and 0045 were taken by the members_self
-- policy and the current_org_id() fix, so it lands as 0046.
--
-- OWNERSHIP, CHECKED RATHER THAN ASSUMED. `storage.objects` is owned by `supabase_storage_admin`
-- and `postgres` is not a superuser here (`pg_user.usesuper = f`), nor a member of that role
-- (`pg_has_role('postgres','supabase_storage_admin','MEMBER') = f`), so the plan expected this
-- migration to fail with `must be owner of table objects` — the same ownership limit that shaped
-- slice 1's backup design. It does not. Measured on this database before a line of it was written:
--
--   begin;
--   create policy probe_tenant on storage.objects for all to app_tenant using (true);
--   -- CREATE POLICY
--   rollback;
--
-- The reason is in `\dp storage.objects`: supabase_storage_admin has granted postgres every
-- privilege WITH GRANT OPTION (`postgres=a*r*w*d*D*x*t*m*/supabase_storage_admin`) on this image
-- (supabase/postgres:17.6.1.156), and this Postgres accepts that for CREATE POLICY. It is a
-- property of the image, not of the SQL standard, so a future image could take it away — which is
-- why it is recorded here rather than left as folklore.
--
-- WHY GRANTS AND NOT JUST POLICIES. A policy filters rows a role may already reach; it does not
-- give reach. `app_tenant` had neither `usage on schema storage` nor any privilege on
-- `storage.objects`, which is what Task 9 measured as `permission denied for schema storage`.
-- Policies alone would have kept that error and changed nothing, so both halves are here.
--
-- WHAT THIS DOES NOT WEAKEN. `service_role` has `rolbypassrls`, so every existing service-role
-- path — which is all of them today — is unaffected by any policy added here. `authenticated` and
-- `anon` reach storage.objects with RLS on and, still, zero policies naming them: the browser sees
-- nothing directly, exactly as migrations 0027/0028/0032 intended. Nothing below names those roles.

grant usage on schema storage to app_tenant;

-- select: createSignedUrl and download. insert/update: upload with upsert. delete: remove.
grant select, insert, update, delete on storage.objects to app_tenant;

-- storage-api resolves the bucket before it touches the object, on the same role-switched
-- connection, so without this the object policies are never reached.
grant select on storage.buckets to app_tenant;

-- The leading path segment is the organisation, which is why slice 1 moved every object under one:
-- floor plans are `{orgId}/{siteId}/{floorId}.{png,pdf}` (planPathFor) and avatars are
-- `{orgId}/{memberId}/avatar` (avatarPathFor). `storage.foldername(name)` is Supabase's own helper
-- for splitting that, and app_tenant already has execute on it.
--
-- current_org_id() reads `request.jwt.claims`, which storage-api sets from the bearer token on the
-- role-switched connection — the same GUC PostgREST sets, verified live against both buckets.
create policy floor_plans_tenant on storage.objects for all to app_tenant
  using (bucket_id = 'floor-plans' and (storage.foldername(name))[1] = current_org_id()::text)
  with check (bucket_id = 'floor-plans' and (storage.foldername(name))[1] = current_org_id()::text);

create policy avatars_tenant on storage.objects for all to app_tenant
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = current_org_id()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = current_org_id()::text);

-- A bucket policy is deliberately NOT added. Listing buckets is not organisation-specific — there
-- are exactly two, both private, and their names are already in the source — so the select grant
-- above is the whole of it. Buckets keep RLS on with no app_tenant policy naming them for anything
-- but that read.
