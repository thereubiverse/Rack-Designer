-- 0018's constraint used Postgres trim(email), which strips ONLY spaces. normaliseEmail (JS
-- .trim()) strips tabs, newlines, and other whitespace too. So a row stored as '\tbob@x.com'
-- satisfied 0018's constraint while the normalised lookup for 'bob@x.com' never matched it —
-- exactly the silent-refusal failure 0018 was added to prevent. Tighten the constraint to match
-- JS .trim() by stripping the same whitespace characters Postgres considers "blank": space, tab,
-- newline, carriage return, form feed, vertical tab.

update members set email = lower(btrim(email, E' \t\n\r\f\v'))
  where email <> lower(btrim(email, E' \t\n\r\f\v'));

alter table members drop constraint members_email_normalised;

alter table members add constraint members_email_normalised
  check (email = lower(btrim(email, E' \t\n\r\f\v')));

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
