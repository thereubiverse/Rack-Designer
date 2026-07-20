-- Sites get coordinates so they can be plotted. All nullable/defaulted so existing rows migrate
-- cleanly and simply start as 'pending'. geocode_status is what keeps a failure LEGIBLE — without
-- it, "never attempted" and "attempted and matched nothing" are indistinguishable, and a site that
-- cannot be located would silently disappear from the map.
alter table sites add column latitude       double precision;
alter table sites add column longitude      double precision;
alter table sites add column geocode_status text not null default 'pending'
  check (geocode_status in ('pending', 'ok', 'not_found', 'failed'));
alter table sites add column geocoded_at    timestamptz;

grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;
