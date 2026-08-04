-- Roles. admin > editor > viewer; a requirement is a MINIMUM, so an admin satisfies every editor
-- check without being enumerated separately.
alter table members
  add column role text not null default 'viewer'
    check (role in ('admin', 'editor', 'viewer'));

-- Everyone who exists today has had unlimited power since before roles existed. Defaulting them to
-- 'viewer' would silently strip the owner of their own app the moment this runs, and the screen that
-- could fix it is admin-only — so the lockout would need psql to undo. Grandfather them to the
-- access they already have. NEW members still default to 'viewer', which is the safe direction.
update members set role = 'admin';

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- The blanket grant above re-opens what 0020/0022 closed and what 0023 re-narrowed, so re-apply
-- BOTH narrowings again here: skipping this would re-expose members PII and live phone codes to
-- the anon key.
revoke insert, update, delete on members from anon, authenticated;
revoke select on members from anon, authenticated;
grant select (email, disabled_at) on members to anon, authenticated;

revoke all on phone_verifications from anon, authenticated;

-- Functions grant EXECUTE to PUBLIC by default, and anon/authenticated inherit PUBLIC's
-- privileges — a plain "revoke ... from anon, authenticated" would still leave the function
-- callable through that inherited grant. Revoke from PUBLIC too so it is actually unreachable
-- with the publishable anon key; only the service role (which the profile actions use) may call it.
revoke all on function claim_phone_verification(uuid,text,text,int,int) from public;
revoke all on function claim_phone_verification(uuid,text,text,int,int) from anon, authenticated;
