-- supabase/migrations/0003_device_type_categories.sql
-- Device types gain a floor/rack category, an ID-prefix code, and a standard flag.
-- Codes are the default ID prefixes for placed devices (SW01, SW02, ...).

alter table device_types
  add column category text not null default 'rack' check (category in ('floor','rack')),
  add column code text not null default '',
  add column is_standard boolean not null default false;

-- Names only need to be unique within their category (the floor list contains "Rack").
alter table device_types drop constraint device_types_organization_id_name_key;
alter table device_types add constraint device_types_org_category_name_key
  unique (organization_id, category, name);

-- Backfill: the 12 seeded rack types become standard, with our agreed codes.
update device_types set is_standard = true, code = c.code
from (values
  ('Switch','SW'),('Router','RT'),('Firewall','FW'),('Gateway','GW'),
  ('Patch Panel','PP'),('Server','SRV'),('UPS','UPS'),('PDU','PDU'),
  ('KVM','KVM'),('Cable Manager','CM'),('Shelf/Tray','ST'),('Other','OTH')
) as c(name, code)
where device_types.name = c.name and device_types.category = 'rack';

-- Seed the 12 standard floor types (codes from the PatchDocs reference).
insert into device_types (organization_id, name, category, code, is_standard)
select o.id, t.name, 'floor', t.code, true
from organizations o
cross join (values
  ('Access Control Panel','ACP'),('Access Point','AP'),('Camera','CAM'),
  ('Desktop','DP'),('Telecommunications Outlet','TO'),('ISP Uplink','ISP'),
  ('Laptop','LP'),('Phone','PH'),('Printer','PR'),('3D Printer','3DP'),
  ('Rack','RK'),('Screen','SCR')
) as t(name, code)
where o.code = 'DEFAULT';

-- Any pre-existing user-created types (created before codes existed) get X001, X002, ...
with bad as (
  select id, row_number() over (order by created_at) as rn
  from device_types where code !~ '^[A-Z0-9]{1,4}$'
)
update device_types set code = 'X' || lpad(bad.rn::text, 3, '0')
from bad where device_types.id = bad.id;

-- Enforce the code rules only after every row satisfies them.
alter table device_types add constraint device_types_code_format_check
  check (code ~ '^[A-Z0-9]{1,4}$');
alter table device_types add constraint device_types_org_code_key
  unique (organization_id, code);
