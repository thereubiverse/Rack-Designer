-- Clients replace organizations at the top of the hierarchy:
--   client -> site -> floor -> room -> rack
-- The device library (brands, device_types, device_templates) becomes GLOBAL: it is one
-- catalogue shared by every client, so it loses its owner column entirely.

create table clients (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now()
);

alter table clients enable row level security;
create policy "single_org_all" on clients for all using (true) with check (true);

-- Destructive: wipe every location. Cascades sites -> floors -> rooms -> racks ->
-- rack_devices -> connections / port_endpoints. Deliberate (see spec 2.1).
delete from sites;

-- Reparent sites onto clients.
alter table sites drop constraint sites_organization_id_code_key;
alter table sites drop column organization_id;
alter table sites add column client_id uuid not null references clients(id) on delete cascade;
alter table sites add constraint sites_client_id_code_key unique (client_id, code);

-- Device library goes global: drop the owner column and re-scope its uniques.
alter table brands drop constraint brands_organization_id_name_key;
alter table brands drop column organization_id;
alter table brands add constraint brands_name_key unique (name);

alter table device_templates drop constraint device_templates_organization_id_name_key;
alter table device_templates drop column organization_id;
alter table device_templates add constraint device_templates_name_key unique (name);

alter table device_types drop constraint device_types_org_code_key;
alter table device_types drop constraint device_types_org_category_name_key;
alter table device_types drop column organization_id;
alter table device_types add constraint device_types_code_key unique (code);
alter table device_types add constraint device_types_category_name_key unique (category, name);

drop table organizations;
