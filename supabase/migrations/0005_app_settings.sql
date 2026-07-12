-- supabase/migrations/0005_app_settings.sql
-- Global key/value application settings (no auth yet → single shared store).
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Match the access pattern of the other tables (no auth yet → permissive single-org policy).
alter table app_settings enable row level security;
create policy "single_org_all" on app_settings for all using (true) with check (true);
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
