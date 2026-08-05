-- Who did what, when. Written by withMember after every action resolves; never written by hand.
create table activity_log (
  id           uuid primary key default gen_random_uuid(),
  -- SET NULL, not CASCADE: deleting a member must never delete the evidence of what they did.
  member_id    uuid references members (id) on delete set null,
  -- Snapshot, so an entry still says WHO even if the row above is gone. Denormalised on purpose.
  actor_email  text        not null,
  actor_name   text        not null default '',
  action       text        not null,
  outcome      text        not null check (outcome in ('ok', 'refused', 'failed')),
  -- ALLOWLISTED arguments only — see redact.ts. This column must never receive a password, an API
  -- key, or a verification code. If you are adding a field here, read the spec's section 4 first.
  details      jsonb       not null default '{}'::jsonb,
  error        text,
  created_at   timestamptz not null default now()
);

-- The three filters the screen offers, each newest-first.
create index activity_log_created_idx on activity_log (created_at desc);
create index activity_log_member_idx  on activity_log (member_id, created_at desc);
create index activity_log_action_idx  on activity_log (action, created_at desc);

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

-- The activity log names people and what they touched; it must not be readable with the
-- publishable anon key.
revoke all on activity_log from anon, authenticated;
