-- Critical fix: the attempt cap in src/features/devices/actions.ts was NOT atomic. The old shape
-- read the challenge, decided in JavaScript whether it was "spent", and then wrote an ABSOLUTE
-- attempts value (chal.attempts + 1) computed from that read. Fire N concurrent confirmDeviceAction
-- requests and every one reads attempts = 0, every one passes the "spent" check, and all N collapse
-- into a single write of attempts = 1 — N guesses cost one attempt. Against a six-digit code the
-- 10-minute TTL is no defence on its own; the five-attempt cap was the only real protection, and it
-- was brute-forceable.
--
-- The fix makes check-and-increment ONE atomic statement: the UPDATE's WHERE clause is the check,
-- and Postgres serialises concurrent UPDATEs to the same row, so only the attempts already spent at
-- the instant each write actually lands can pass it — there is no window between "read" and "write"
-- for a second request to land in. No row returned means the attempt was NOT counted (already spent
-- or expired); a row returned means this call is the one that consumed it, atomically.
create or replace function consume_device_attempt(p_device_id uuid)
returns table (code text, expires_at timestamptz, attempts int)
language plpgsql security definer as $$
begin
  return query
  update device_challenges c
     set attempts = c.attempts + 1
   where c.device_id = p_device_id
     and c.attempts < 5          -- MAX_ATTEMPTS; keep in step with deviceRules.ts
     and c.expires_at > now()
  returning c.code, c.expires_at, c.attempts;
end $$;

-- Postgres grants EXECUTE on a new function to PUBLIC, so revoking from anon/authenticated alone
-- would do nothing at all. Revoke from public FIRST, then grant to the one role that needs it.
--
-- service_role, NOT authenticated: unlike is_device_trusted (0030), this is called only from
-- confirmDeviceAction — a server action running on the SERVICE client — never from the Edge
-- middleware, which has no reason to touch attempt counters at all.
revoke all on function consume_device_attempt(uuid) from public;
grant execute on function consume_device_attempt(uuid) to service_role;
