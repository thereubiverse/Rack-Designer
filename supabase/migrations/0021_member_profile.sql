-- Profile fields a member maintains about themselves. Slice H2.
-- Text columns default to '' and are not null, matching members.name: the app treats empty as
-- "not set", and this saves every read from having to consider null. avatar_path IS nullable,
-- because "no picture" is genuinely different from "a picture stored at the empty path".
--
-- Nothing here is format-validated. Phone numbers and addresses across many client sites do not
-- fit a pattern worth enforcing, and a regex that rejects a real number is worse than free text.
alter table members
  add column phone       text not null default '',
  add column position    text not null default '',
  add column address     text not null default '',
  add column avatar_path text;

-- Private, like floor-plans: an employee photo is personal data belonging to someone who did not
-- choose to publish it. Read through short-lived signed URLs.
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', false)
  on conflict (id) do nothing;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- 0020 revoked member writes from anon/authenticated; the blanket grant above re-grants them, so
-- re-apply the revoke LAST. Keep this at the end of every future migration that touches members.
revoke insert, update, delete on members from anon, authenticated;
