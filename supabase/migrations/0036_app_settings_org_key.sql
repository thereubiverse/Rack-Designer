-- app_settings is keyed by name alone, so one organisation storing its Gemini key would overwrite
-- another's. This is needed HERE rather than alongside the other org-scoped unique constraints,
-- because src/features/settings/store.ts already upserts with onConflict "org_id,key" and Postgres
-- rejects an ON CONFLICT target that has no matching unique index (42P10) — so without this, every
-- settings save fails.
--
-- `add primary key` sets NOT NULL on org_id implicitly. Migration 0034 already backfilled every
-- existing row, so there is nothing for it to reject.
alter table app_settings drop constraint app_settings_pkey;
alter table app_settings add primary key (org_id, key);
