-- Who is allowed to use this app. Deliberately separate from auth.users: anyone on earth can
-- complete a Google sign-in, which proves an identity and nothing more. This table is the gate.
create table members (
  id           uuid primary key default gen_random_uuid(),
  -- The invite is addressed to an email, and it is how a sign-in of ANY kind is matched back to a
  -- member. Always stored lowercase and trimmed — see normaliseEmail.
  email        text not null unique,
  name         text not null default '',
  -- Filled on first successful sign-in. Null means invited but never signed in, which is a normal
  -- state rather than an error.
  auth_user_id uuid unique,
  invited_at   timestamptz not null default now(),
  -- Revocation, NOT deletion. Every activity-log entry this person creates must still resolve to a
  -- name after they leave; deleting the row would orphan the history the log exists to produce.
  disabled_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index members_auth_user_idx on members (auth_user_id) where auth_user_id is not null;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
