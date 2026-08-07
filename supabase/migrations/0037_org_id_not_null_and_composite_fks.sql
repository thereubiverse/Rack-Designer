-- Multi-tenancy slice 1, part 3 of 4: make a cross-organisation row impossible.
--
-- The trigger in 0035 supplies the right org_id. This makes a wrong one unrepresentable: every
-- relationship between two org-scoped tables carries org_id through the foreign key itself, so
-- attaching one company's site to another company's client is refused by Postgres regardless of
-- what any query says. That is the difference between isolation you can audit and isolation you
-- have to trust.
alter table clients         add constraint clients_org_id_unique         unique (org_id, id);
alter table sites           add constraint sites_org_id_unique           unique (org_id, id);
alter table floors          add constraint floors_org_id_unique          unique (org_id, id);
alter table rooms           add constraint rooms_org_id_unique           unique (org_id, id);
alter table racks           add constraint racks_org_id_unique           unique (org_id, id);
alter table rack_devices    add constraint rack_devices_org_id_unique    unique (org_id, id);
alter table members         add constraint members_org_id_unique         unique (org_id, id);
alter table trusted_devices add constraint trusted_devices_org_id_unique unique (org_id, id);

-- `not null` FIRST: a composite foreign key with a nullable column is satisfied by a null, which
-- would leave exactly the hole this migration exists to close.
alter table clients             alter column org_id set not null;
alter table members             alter column org_id set not null;
alter table app_settings        alter column org_id set not null;
alter table sites               alter column org_id set not null;
alter table floors              alter column org_id set not null;
alter table rooms               alter column org_id set not null;
alter table racks               alter column org_id set not null;
alter table rack_devices        alter column org_id set not null;
alter table connections         alter column org_id set not null;
alter table port_endpoints      alter column org_id set not null;
alter table floor_devices       alter column org_id set not null;
alter table floor_plans         alter column org_id set not null;
-- activity_log is DELIBERATELY ABSENT from this list. `member_id` is nullable and
-- src/features/activity/authLog.ts passes `memberId ?? null`, because a REFUSED SIGN-IN FROM AN
-- UNKNOWN ADDRESS has no member — and therefore no organisation. Making this not null would make
-- that insert fail and silently destroy the sign-in-refusal audit trail, which is one of the
-- reasons the activity log exists. NULL here means "a platform-level event belonging to no
-- organisation", and slice 2's policies leave those rows invisible to every tenant, which is
-- correct: they are the platform operator's business, not a customer's.
alter table trusted_devices     alter column org_id set not null;
alter table phone_verifications alter column org_id set not null;
alter table device_challenges   alter column org_id set not null;

-- Replace each single-column foreign key with its composite form. Every constraint name below was
-- verified against the live catalogue (pg_constraint) before this migration was written; each
-- `on delete` clause matches what the dropped constraint already carried.
alter table sites drop constraint sites_client_id_fkey;
alter table sites add constraint sites_client_fk
  foreign key (org_id, client_id) references clients (org_id, id) on delete cascade;

alter table floors drop constraint floors_site_id_fkey;
alter table floors add constraint floors_site_fk
  foreign key (org_id, site_id) references sites (org_id, id) on delete cascade;

alter table rooms drop constraint rooms_floor_id_fkey;
alter table rooms add constraint rooms_floor_fk
  foreign key (org_id, floor_id) references floors (org_id, id) on delete cascade;

alter table racks drop constraint racks_room_id_fkey;
alter table racks add constraint racks_room_fk
  foreign key (org_id, room_id) references rooms (org_id, id) on delete cascade;

alter table rack_devices drop constraint rack_devices_rack_id_fkey;
alter table rack_devices add constraint rack_devices_rack_fk
  foreign key (org_id, rack_id) references racks (org_id, id) on delete cascade;

alter table connections drop constraint connections_rack_id_fkey;
alter table connections add constraint connections_rack_fk
  foreign key (org_id, rack_id) references racks (org_id, id) on delete cascade;

alter table port_endpoints drop constraint port_endpoints_rack_id_fkey;
alter table port_endpoints add constraint port_endpoints_rack_fk
  foreign key (org_id, rack_id) references racks (org_id, id) on delete cascade;

alter table floor_devices drop constraint floor_devices_site_id_fkey;
alter table floor_devices add constraint floor_devices_site_fk
  foreign key (org_id, site_id) references sites (org_id, id) on delete cascade;

alter table floor_plans drop constraint floor_plans_floor_id_fkey;
alter table floor_plans add constraint floor_plans_floor_fk
  foreign key (org_id, floor_id) references floors (org_id, id) on delete cascade;

-- activity_log_member_id_fkey carried ON DELETE SET NULL live (not the brief's plain default),
-- because member_id is nullable for the sign-in-refusal case above. Preserved here: deleting a
-- member nulls out both member_id and org_id on their activity_log rows, which correctly demotes
-- those rows to platform-level events belonging to no organisation, rather than blocking the
-- member delete or leaving a dangling reference.
alter table activity_log drop constraint activity_log_member_id_fkey;
alter table activity_log add constraint activity_log_member_fk
  foreign key (org_id, member_id) references members (org_id, id) on delete set null;

alter table trusted_devices drop constraint trusted_devices_member_id_fkey;
alter table trusted_devices add constraint trusted_devices_member_fk
  foreign key (org_id, member_id) references members (org_id, id) on delete cascade;

alter table phone_verifications drop constraint phone_verifications_member_id_fkey;
alter table phone_verifications add constraint phone_verifications_member_fk
  foreign key (org_id, member_id) references members (org_id, id) on delete cascade;

alter table device_challenges drop constraint device_challenges_device_id_fkey;
alter table device_challenges add constraint device_challenges_device_fk
  foreign key (org_id, device_id) references trusted_devices (org_id, id) on delete cascade;

-- DELIBERATELY NOT CONVERTED: references into the shared library — rack_devices.device_template_id,
-- port_endpoints.device_type_id, floor_devices.device_type_id, device_templates.brand_id and
-- device_templates.device_type_id. Those parents carry a NULLABLE org_id (NULL = shared), and a
-- composite foreign key cannot express "either the shared row or my own". Today every library row is
-- shared, so nothing can point across a wall. SLICE 4, which lets an organisation create its own
-- device types, must close this: at that point a rack_device could reference another organisation's
-- private template. It is recorded here rather than left to be rediscovered.
