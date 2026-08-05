-- 0029 defined is_device_trusted(p_member_id uuid, p_token_hash text). Its ONLY caller is
-- src/middleware.ts, which 0029's own comment already says runs "on the Edge runtime with the
-- PUBLISHABLE key, which 0027/0028 reduced to `select (email, disabled_at) on members`" — but
-- members.id is not part of that grant, and Postgres requires SELECT on a column to read it at all.
-- The middleware can never have a members.id to pass in, so the (uuid, text) signature could not
-- actually be called from the one place that was meant to call it. This is the same class of mistake
-- 0028 corrected in 0027: fix it with a new migration rather than editing 0029's history.
--
-- The fix: resolve the member from email INSIDE this SECURITY DEFINER function, the same way
-- isActiveMember in src/middleware.ts already looks members up by email. Normalise with
-- lower(trim(...)), matching normaliseEmail in both middleware.ts and members.ts.
drop function if exists is_device_trusted(uuid, text);

create function is_device_trusted(p_email text, p_token_hash text)
returns boolean language plpgsql security definer as $$
declare ok boolean;
begin
  update trusted_devices d
     set last_seen_at = now()
    from members m
   where d.member_id = m.id
     and m.email = lower(trim(p_email))
     and d.token_hash = p_token_hash
     and d.approved_at is not null
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- Same reasoning as 0029: Postgres grants EXECUTE on a new function to PUBLIC by default, so this
-- has to be revoked before the narrow grant means anything.
revoke all on function is_device_trusted(text, text) from public;
grant execute on function is_device_trusted(text, text) to authenticated;
