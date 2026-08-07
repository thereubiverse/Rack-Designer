-- Multi-tenancy slice 1, task 4: close the composite-FK gaps left by 0037, and repair a hole its
-- own on-delete behaviour opened in activity_log.
--
-- Numbering note: 0038 is reserved for a task not yet written. This migration does not depend on
-- it and 0038 will not depend on this one — they are order-independent and safe to apply in
-- either sequence relative to each other.

-- ---------------------------------------------------------------------------------------------
-- Finding 1: 0037's closing comment claimed the only foreign keys it left single-column were
-- references into the shared library. That was wrong — it also missed seven relationships that
-- point at ordinary org-scoped parents (rack_devices, racks, floors, rooms), all reachable
-- through tables whose own org_id is already NOT NULL. Proven live: with a rival organisation's
-- floor created, `update floor_devices set floor_id = <rival floor>` was accepted, silently
-- moving a device across the tenant boundary. This closes that.
--
-- Each parent's `unique (org_id, id)` index already exists (added by 0037 on racks, rack_devices,
-- floors, rooms). Every `on delete` clause below matches what the dropped single-column
-- constraint carried, verified against the live catalogue before this migration was written.

alter table connections drop constraint connections_a_rack_device_id_fkey;
alter table connections add constraint connections_a_rack_device_fk
  foreign key (org_id, a_rack_device_id) references rack_devices (org_id, id) on delete cascade;

alter table connections drop constraint connections_b_rack_device_id_fkey;
alter table connections add constraint connections_b_rack_device_fk
  foreign key (org_id, b_rack_device_id) references rack_devices (org_id, id) on delete cascade;

alter table port_endpoints drop constraint port_endpoints_rack_device_id_fkey;
alter table port_endpoints add constraint port_endpoints_rack_device_fk
  foreign key (org_id, rack_device_id) references rack_devices (org_id, id) on delete cascade;

alter table port_endpoints drop constraint port_endpoints_target_rack_device_id_fkey;
alter table port_endpoints add constraint port_endpoints_target_rack_device_fk
  foreign key (org_id, target_rack_device_id) references rack_devices (org_id, id) on delete cascade;

-- port_endpoints ends up with two composite foreign keys that both include org_id (via rack_id,
-- converted in 0037, and target_rack_id, converted here). That is correct and intended, not a
-- duplicate: a port and the port it targets can each belong to a different rack, and both racks
-- must still belong to the same organisation as the port row itself.
alter table port_endpoints drop constraint port_endpoints_target_rack_id_fkey;
alter table port_endpoints add constraint port_endpoints_target_rack_fk
  foreign key (org_id, target_rack_id) references racks (org_id, id) on delete cascade;

alter table floor_devices drop constraint floor_devices_floor_id_fkey;
alter table floor_devices add constraint floor_devices_floor_fk
  foreign key (org_id, floor_id) references floors (org_id, id) on delete cascade;

-- room_id is nullable (a device can be placed on a floor without an assigned room). The
-- single-column form previously let a room delete un-assign the device. Making the key composite
-- (org_id, room_id) with a plain `on delete set null` changed that: on a multi-column key, SET
-- NULL without a named column list nulls every column in the key, including org_id, which the
-- freeze_org_id trigger then rejects, turning every room delete with an assigned device into a
-- hard failure. NOT preserved as-is — fixed in 0040 by naming the child column:
-- `on delete set null (room_id)`.
alter table floor_devices drop constraint floor_devices_room_id_fkey;
alter table floor_devices add constraint floor_devices_room_fk
  foreign key (org_id, room_id) references rooms (org_id, id) on delete set null;

-- 0037's closing comment claimed the library references (rack_devices.device_template_id,
-- port_endpoints.device_type_id, floor_devices.device_type_id, device_templates.brand_id,
-- device_templates.device_type_id) were the only foreign keys deliberately left single-column.
-- That was incomplete — see the seven converted above, which 0037 missed and this migration
-- fixes. The comment in 0037 itself has been corrected to say so (0037 is already applied, so
-- editing its comment text is safe — it changes no schema and is not re-run). The library
-- references themselves are still correctly left alone: their parents carry a nullable org_id
-- (NULL = shared), which a composite foreign key cannot express. SLICE 4, which lets an
-- organisation create its own device types, must close that separate gap.

-- ---------------------------------------------------------------------------------------------
-- Finding 2: 0037 made activity_log's foreign key composite with `on delete set null`. Because
-- the constraint now spans two columns, deleting a member nulled org_id as well as member_id —
-- previously only member_id was nulled and the organisation survived. Slice 2's policies key on
-- org_id, so those rows became invisible to the very tenant that owns them. Naming the column to
-- null (Postgres 15+; this database runs 17.6) clears only member_id and keeps org_id intact.
alter table activity_log drop constraint activity_log_member_fk;
alter table activity_log add constraint activity_log_member_fk
  foreign key (org_id, member_id) references members (org_id, id) on delete set null (member_id);

-- ---------------------------------------------------------------------------------------------
-- Finding 3: composite foreign keys default to MATCH SIMPLE, which skips the check entirely when
-- any column is null. Proved live: a row with a real member_id can have its org_id set to null,
-- after which member_id can be repointed at a member of any organisation, unchecked. Not
-- currently reachable — the BEFORE INSERT trigger (0035) stamps org_id whenever member_id is
-- present, and the application only inserts — but it is one stray UPDATE away. No existing row
-- violates this (checked before writing this migration), so it is added fully validated.
--
-- NOTE: the reviewer's suggested form, `check ((org_id is null) = (member_id is null))`, was
-- tested live and rejected: it is symmetric, and Finding 2's `on delete set null (member_id)`
-- deliberately produces the asymmetric state org_id NOT NULL / member_id NULL on every member
-- delete, which that symmetric check then refuses — turning every member delete into a database
-- error. The two legitimate states are "both null" (platform-level event, no org) and "org_id
-- set, member_id null" (an ex-member's row, org retained per Finding 2); the one state that must
-- stay impossible is "org_id null, member_id set" — that is the actual takeover vector Finding 3
-- describes. This asymmetric form blocks exactly that state and nothing else.
alter table activity_log add constraint activity_log_org_member_agree
  check (org_id is not null or member_id is null);
