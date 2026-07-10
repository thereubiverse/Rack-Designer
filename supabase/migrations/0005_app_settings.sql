-- supabase/migrations/0005_app_settings.sql
-- Global key/value application settings (no auth yet → single shared store).
create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
