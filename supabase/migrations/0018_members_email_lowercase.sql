-- getCurrentMember normalises the email it looks up (lowercase, trimmed) but that only
-- guarantees the INPUT side of the comparison. If an invite were ever inserted with mixed
-- case (e.g. 'Bob@Example.com'), the lookup would never match it and a genuinely invited
-- member would be silently refused with a message that deliberately explains nothing.
-- Close that hole at the database so no future insert path can reopen it.

-- This table is new and effectively empty, so normalising in place is safe.
update members set email = lower(trim(email)) where email <> lower(trim(email));

alter table members add constraint members_email_normalised check (email = lower(trim(email)));

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
