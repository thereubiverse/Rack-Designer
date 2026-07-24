-- Per-device-type appearance overrides for the floor plan (and lists/menus): an optional fill
-- colour and an optional Iconify icon id. Both nullable — null means "use the app's built-in
-- default for this type's code", so existing types look unchanged until customised.
alter table device_types add column color text;
alter table device_types add column icon text;

-- Colour must be a #rrggbb hex when set. Icon is a free Iconify "prefix:name" id (loosely checked).
alter table device_types add constraint device_types_color_format_check
  check (color is null or color ~ '^#[0-9a-fA-F]{6}$');
alter table device_types add constraint device_types_icon_format_check
  check (icon is null or icon ~ '^[a-z0-9]+(-[a-z0-9]+)*:[a-z0-9]+(-[a-z0-9]+)*$');

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
