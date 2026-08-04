-- Atomically claim the right to send a code. Returns true only if this caller won: either no row
-- existed, or the existing one is older than the cooldown. Concurrent callers serialise on the
-- primary key, so exactly one gets true and only that one sends a message. Doing this as
-- read-then-write in the application bills a text per concurrent request.
create or replace function claim_phone_verification(
  p_member_id uuid, p_phone text, p_code text, p_ttl_seconds int, p_cooldown_seconds int
) returns boolean language plpgsql as $$
declare claimed boolean;
begin
  insert into phone_verifications (member_id, phone, code, attempts, expires_at, created_at)
  values (p_member_id, p_phone, p_code, 0, now() + make_interval(secs => p_ttl_seconds), now())
  on conflict (member_id) do update
    set phone = excluded.phone, code = excluded.code, attempts = 0,
        expires_at = excluded.expires_at, created_at = excluded.created_at
    where phone_verifications.created_at < now() - make_interval(secs => p_cooldown_seconds)
  returning true into claimed;
  return coalesce(claimed, false);
end $$;

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
