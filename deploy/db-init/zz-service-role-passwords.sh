#!/bin/bash
# Give every Supabase service role a password.
#
# Runs once, from the postgres entrypoint, only while the data volume is empty. The supabase/postgres
# image creates these roles as part of its own /docker-entrypoint-initdb.d/migrate.sh but sets a
# password only for `postgres`, so on a fresh install PostgREST and Storage crashloop with
#
#   FATAL: password authentication failed for user "authenticator"
#   FATAL: password authentication failed for user "supabase_storage_admin"
#
# Supabase's own self-hosting compose file solves this the same way. The `zz-` filename prefix makes
# the entrypoint run this AFTER migrate.sh, so the roles already exist.
#
# This must be a .sh file, not a .sql one: the entrypoint pipes .sql files to psql verbatim with no
# environment substitution, so a .sql file could never see $POSTGRES_PASSWORD.
#
# Re-testing this script means `docker compose ... down -v` first. Init scripts do not run again on a
# volume that already has data.
set -euo pipefail

if [ -z "${POSTGRES_PASSWORD:-}" ]; then
  echo "zz-service-role-passwords.sh: POSTGRES_PASSWORD is empty — refusing to set empty passwords" >&2
  exit 1
fi

# Roles as of supabase/postgres 17.6.x. Not all of them necessarily exist in every image version, so
# the ALTER is generated from a pg_roles lookup rather than written out flat: a role that is missing
# yields zero rows and therefore no statement, instead of aborting the whole initialisation and
# costing us the entire database.
roles="authenticator supabase_auth_admin supabase_storage_admin supabase_admin supabase_functions_admin pgbouncer"

for role in $roles; do
  # The password reaches psql as a variable and is quoted with %L by format(), so it is escaped as a
  # literal rather than pasted into SQL text. Note that psql does NOT interpolate :'vars' inside
  # dollar-quoted strings, which is why this is a plain select + \gexec and not a DO block.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
    -v role="$role" -v pw="$POSTGRES_PASSWORD" <<'SQL'
select format('alter role %I with password %L', rolname, :'pw')
  from pg_roles
 where rolname = :'role'
\gexec
SQL
  echo "zz-service-role-passwords.sh: processed role $role"
done

echo "zz-service-role-passwords.sh: done"
