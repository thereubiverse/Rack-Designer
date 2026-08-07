-- Multi-tenancy slice 1, part 2 of 4: children inherit their owner.
--
-- This is what keeps this slice from touching all 141 exported server functions. Only three inserts
-- in the whole application supply org_id (clients, members, app_settings — the three tables with no
-- parent row to read). Every other insert gets it from the row it hangs off, here, in the database,
-- where it cannot be forgotten.
--
-- Generic rather than thirteen near-identical functions: the parent table and the local foreign-key
-- column arrive as trigger arguments. `format(%I)` quotes them as identifiers, so they cannot be
-- injected through — and they are written by this migration, not by a user, in any case.
create or replace function inherit_org_id() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  parent_table constant text := tg_argv[0];
  fk_column    constant text := tg_argv[1];
  fk_value     uuid;
  parent_org   uuid;
begin
  execute format('select ($1).%I', fk_column) into fk_value using new;

  -- A null foreign key means there is no parent to inherit from. Let it through: 0036's `not null`
  -- is what refuses the row, with a clearer message than anything invented here.
  if fk_value is null then
    return new;
  end if;

  execute format('select org_id from %I where id = $1', parent_table)
    into parent_org using fk_value;

  if parent_org is null then
    raise exception 'inherit_org_id: % row references %.% = %, which has no org_id',
      tg_table_name, parent_table, fk_column, fk_value;
  end if;

  -- An explicitly supplied org_id that disagrees with the parent is a bug, not a preference. Refuse
  -- rather than silently overwrite: silently correcting it would hide the caller that got it wrong.
  if new.org_id is not null and new.org_id <> parent_org then
    raise exception 'inherit_org_id: % supplied org_id % but its parent %.% belongs to %',
      tg_table_name, new.org_id, parent_table, fk_column, parent_org;
  end if;

  new.org_id := parent_org;
  return new;
end $$;

revoke all on function inherit_org_id() from public;

-- "Move this rack to another company" is not an operation this product has, and an UPDATE that
-- changed org_id would move a row across the wall while every composite foreign key still pointed
-- at the old owner.
create or replace function freeze_org_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.org_id is distinct from old.org_id then
    raise exception 'freeze_org_id: % row % cannot change organisation (% -> %)',
      tg_table_name, old.id, old.org_id, new.org_id;
  end if;
  return new;
end $$;

revoke all on function freeze_org_id() from public;

create trigger sites_inherit_org               before insert on sites               for each row execute function inherit_org_id('clients', 'client_id');
create trigger floors_inherit_org              before insert on floors              for each row execute function inherit_org_id('sites', 'site_id');
create trigger rooms_inherit_org               before insert on rooms               for each row execute function inherit_org_id('floors', 'floor_id');
create trigger racks_inherit_org               before insert on racks               for each row execute function inherit_org_id('rooms', 'room_id');
create trigger rack_devices_inherit_org        before insert on rack_devices        for each row execute function inherit_org_id('racks', 'rack_id');
create trigger connections_inherit_org         before insert on connections         for each row execute function inherit_org_id('racks', 'rack_id');
create trigger port_endpoints_inherit_org      before insert on port_endpoints      for each row execute function inherit_org_id('racks', 'rack_id');
create trigger floor_devices_inherit_org       before insert on floor_devices       for each row execute function inherit_org_id('sites', 'site_id');
create trigger floor_plans_inherit_org         before insert on floor_plans         for each row execute function inherit_org_id('floors', 'floor_id');
create trigger activity_log_inherit_org        before insert on activity_log        for each row execute function inherit_org_id('members', 'member_id');
create trigger trusted_devices_inherit_org     before insert on trusted_devices     for each row execute function inherit_org_id('members', 'member_id');
create trigger phone_verifications_inherit_org before insert on phone_verifications for each row execute function inherit_org_id('members', 'member_id');
-- Two hops from its root: device_challenges -> trusted_devices -> members. It reads the org that
-- trusted_devices already carries, so the chain does not have to be walked here.
create trigger device_challenges_inherit_org   before insert on device_challenges   for each row execute function inherit_org_id('trusted_devices', 'device_id');

create trigger clients_freeze_org             before update on clients             for each row execute function freeze_org_id();
create trigger members_freeze_org             before update on members             for each row execute function freeze_org_id();
create trigger sites_freeze_org               before update on sites               for each row execute function freeze_org_id();
create trigger floors_freeze_org              before update on floors              for each row execute function freeze_org_id();
create trigger rooms_freeze_org               before update on rooms               for each row execute function freeze_org_id();
create trigger racks_freeze_org               before update on racks               for each row execute function freeze_org_id();
create trigger rack_devices_freeze_org        before update on rack_devices        for each row execute function freeze_org_id();
create trigger connections_freeze_org         before update on connections         for each row execute function freeze_org_id();
create trigger port_endpoints_freeze_org      before update on port_endpoints      for each row execute function freeze_org_id();
create trigger floor_devices_freeze_org       before update on floor_devices       for each row execute function freeze_org_id();
create trigger floor_plans_freeze_org         before update on floor_plans         for each row execute function freeze_org_id();
create trigger trusted_devices_freeze_org     before update on trusted_devices     for each row execute function freeze_org_id();
