-- A device the member has proved control of. The middleware checks this on every request.
create table trusted_devices (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references members (id) on delete cascade,
  -- SHA-256 of the cookie value. The raw token exists only in the browser; a dump of this table
  -- cannot be replayed as a device.
  token_hash   text not null unique,
  -- A guess from the user agent, so a member recognises which device they are revoking. Never
  -- trusted for anything and never used to identify the device.
  label        text not null default '',
  approved_at  timestamptz,          -- null = pending. A pending device grants nothing.
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

create index trusted_devices_member_idx on trusted_devices (member_id, created_at desc);

-- At most one code in flight per device — the same shape as phone_verifications.
create table device_challenges (
  device_id  uuid primary key references trusted_devices (id) on delete cascade,
  code       text        not null,
  attempts   int         not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- THE GATE. The middleware runs on the Edge runtime with the PUBLISHABLE key, which 0027/0028
-- reduced to `select (email, disabled_at) on members`. Granting it read access to trusted_devices
-- would hand back the surface those migrations closed, and would let any member enumerate every
-- other member's devices. This answers one yes/no question and leaks nothing else.
--
-- It also stamps last_seen_at, so "when did this device last connect" costs no extra round trip.
create or replace function is_device_trusted(p_member_id uuid, p_token_hash text)
returns boolean language plpgsql security definer as $$
declare ok boolean;
begin
  update trusted_devices
     set last_seen_at = now()
   where member_id = p_member_id
     and token_hash = p_token_hash
     and approved_at is not null
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- Postgres grants EXECUTE on a new function to PUBLIC, so revoking from anon/authenticated alone
-- would do nothing at all. Revoke from public FIRST, then grant to the one role that needs it.
-- (0024 shipped this wrong and it had to be corrected.)
revoke all on function is_device_trusted(uuid, text) from public;
grant execute on function is_device_trusted(uuid, text) to authenticated;
