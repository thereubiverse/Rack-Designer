-- An ownership audit found that floor_plans is row-level-security scoped by org_id, but nothing
-- constrains storage_path or pdf_storage_path: a row can legally point at another organisation's
-- stored object. Proven in a rolled-back transaction (`UPDATE 1` succeeded). Not reachable through
-- the application today — upsertFloorPlan is the only writer and builds the path server-side from
-- the floor's own organisation — but that makes the isolation a property of code being right, which
-- this project has been moving away from since the tenancy work in 0034-0046.
--
-- Objects are laid out {orgId}/{siteId}/{floorId}.png, with the PDF alongside as .pdf. Both columns
-- get the same rule: the path must start with the row's own org_id followed by '/'.
--
-- starts_with(), not LIKE: LIKE interprets % and _ in the pattern, and while a uuid contains
-- neither today, the next person writing a similar check may not verify that, and starts_with()
-- cannot be made to mean anything else. It is immutable, so it is valid in a check constraint.
--
-- Validated against existing data, not added NOT VALID: there are two floor_plans rows and both are
-- already org-prefixed, so NOT VALID would trust exactly the data this constraint exists to stop
-- trusting.
alter table floor_plans
  add constraint floor_plans_storage_path_org_prefixed
  check (starts_with(storage_path, org_id::text || '/'));

alter table floor_plans
  add constraint floor_plans_pdf_storage_path_org_prefixed
  check (pdf_storage_path is null or starts_with(pdf_storage_path, org_id::text || '/'));
