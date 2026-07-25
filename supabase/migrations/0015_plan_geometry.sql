-- Slice D: the uploaded PDF is retained so its exact vector geometry can be extracted, and
-- re-extracted later when the wall filter improves, without asking the user to re-upload.
alter table floor_plans add column pdf_storage_path      text;
-- WHICH page of a multi-page PDF the PNG was rendered from. Slice B rendered a chosen page but
-- never persisted the index, so a retained PDF could not be mapped back to its own sheet.
alter table floor_plans add column pdf_page              integer check (pdf_page is null or pdf_page >= 0);
-- Wall runs, normalized 0..1 over the rendered page: [{x1,y1,x2,y2}]. Advisory snapping data.
alter table floor_plans add column wall_runs             jsonb;
-- Room labels lifted from the PDF text layer: [{text,x,y}]. Exact strings, no OCR.
alter table floor_plans add column plan_labels           jsonb;
alter table floor_plans add column geometry_extracted_at timestamptz;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
