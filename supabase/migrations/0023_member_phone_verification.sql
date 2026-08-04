-- Phone verification. The number stays an ordinary members column and this never touches
-- auth.users: using Supabase's built-in phone OTP would write the number onto the auth user and
-- make signInWithOtp({phone}) a live way into the account — a permanent second front door added in
-- order to spell-check a contact field. See the design doc, section 2.
alter table members add column phone_verified_at timestamptz;

-- member_id is the PRIMARY KEY, so a member has at most ONE code in flight. Asking for a new code
-- replaces the old one instead of leaving several valid at once.
create table phone_verifications (
  member_id  uuid primary key references members (id) on delete cascade,
  -- E.164, the number the code was actually sent to. Compared against the profile at confirm time:
  -- if the member edited the field while a code was in flight, that code confirms nothing.
  phone      text        not null,
  -- Stored plainly, deliberately. This is a check against typos, not a secret defending an account
  -- — anyone who can read this table already holds the service role and therefore the whole
  -- database. If the phone ever becomes an MFA or recovery factor, THIS is the assumption to revisit.
  code       text        not null,
  attempts   int         not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- The blanket grant above re-opens what 0020 and 0022 closed, so re-apply BOTH narrowings last, and
-- add the new table: live codes must not be readable with the publishable anon key.
revoke insert, update, delete on members from anon, authenticated;
revoke select on members from anon, authenticated;
grant select (email, disabled_at) on members to anon, authenticated;

revoke all on phone_verifications from anon, authenticated;
