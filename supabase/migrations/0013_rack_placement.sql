-- Racks can be placed on their floor's plan, like floor devices. Normalized 0..1 against the plan
-- image; BOTH null (unplaced) or BOTH set (placed), enforced by the check so the half-set state is
-- unrepresentable. A rack belongs to a room -> floor, so it only ever appears on that floor's plan.
alter table racks add column x double precision;
alter table racks add column y double precision;
alter table racks add constraint racks_xy_together check ((x is null) = (y is null));

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
