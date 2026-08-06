#!/usr/bin/env bash
# deploy/backup.sh — dump the database and archive the storage volume into one timestamped
# directory, then sweep old backups down to a retention count.
#
# A backup that has never been restored is a hope, not a backup. This script only proves it can
# WRITE a backup; deploy/restore.sh is the other half. The deployment doc tells the operator to run
# a full backup -> restore cycle against a throwaway stack before trusting either script in
# production — the first time restore.sh runs should not be during a real outage, against data
# nobody has ever confirmed comes back.
#
# Two things get backed up because they live in two different places: pg_dump captures every row in
# Postgres, but floor plans and avatars are files on the storage volume, not database rows. A
# database-only backup silently loses every uploaded plan while looking complete.
#
# WHY THE DATABASE IS DUMPED IN TWO PIECES
#
# `postgres` on supabase/postgres is NOT a superuser, and it does not own the `auth` or `storage`
# schemas or any table in them (they belong to supabase_auth_admin / supabase_storage_admin), nor
# the global event triggers (supabase_admin). A whole-database `pg_dump --clean` therefore produces
# a file that `postgres` can never replay: its first statement is `DROP EVENT TRIGGER IF EXISTS
# pgrst_drop_watch;` and it dies there with "must be owner of event trigger". `--if-exists` does not
# help — the trigger DOES exist. That is exactly how the first real restore of this stack failed,
# after which the database was left with its schema intact and every row gone.
#
# So the dump is split along the line of what `postgres` is actually permitted to replace:
#
#   db-public.sql.gz        schema + data for `public`, --clean --if-exists, scoped with -n public.
#                           `postgres` owns every table here, so DROP-then-CREATE replays normally.
#                           Scoping with -n also excludes the event triggers, which are global
#                           rather than schema-scoped.
#   db-auth-storage.sql.gz  --data-only for `auth` and `storage`. Those tables are recreated by
#                           GoTrue's and storage-api's own migrations, not by us; we only carry the
#                           rows. Measured: `postgres` may INSERT into and TRUNCATE every table in
#                           both schemas EXCEPT auth.schema_migrations and storage.migrations, which
#                           it may not touch at all — those two are excluded here for that reason,
#                           and they are the services' own migration ledgers, not user data.
#   db-superuser-only.sql   the statements pg_dump emitted that `postgres` cannot execute, held back
#                           out of the replayable dump so restore.sh can keep ON_ERROR_STOP=1. In
#                           practice these are the `ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin
#                           IN SCHEMA public` lines. They are NOT applied by restore.sh; they are
#                           kept in plain text so a human with superuser access can see and apply
#                           them. Losing them costs nothing here — they only govern objects created
#                           in `public` BY supabase_admin, and this application creates none; the
#                           default privileges that DO matter (FOR ROLE postgres) stay in the
#                           replayable dump. Note they grant ALL to `anon`, which migrations 0027/
#                           0028 went out of their way to revoke, so not replaying them is if
#                           anything the safer state.
#   storage.tar.gz          the storage volume itself.
#
# Takes the compose file/env file as arguments rather than hardcoding a project, so the same script
# backs up any deployment of this stack, not just the one at the default paths below. It never
# touches the local development Supabase stack (supabase_*_network-doc-platform, ports
# 54321-54326) — that stack is managed by the Supabase CLI, not by deploy/docker-compose.yml, so the
# default arguments here cannot reach it.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
BACKUP_ROOT="$SCRIPT_DIR/backups"
RETENTION=14
# Pinned, like every other image in docker-compose.yml — a plain filesystem to tar, nothing more.
ALPINE_IMAGE="alpine:3.20"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Dumps the database and archives the storage volume into a timestamped directory under the output
directory, then deletes old backup directories beyond the retention count.

  -f, --compose-file FILE   docker-compose.yml of the stack to back up (default: $COMPOSE_FILE)
  -e, --env-file FILE       .env file to pass to docker compose (default: $ENV_FILE)
  -o, --output-dir DIR      where timestamped backup directories are created (default: $BACKUP_ROOT)
  -n, --retention N         number of most-recent backups to keep (default: $RETENTION)
  -h, --help                show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    -e|--env-file) ENV_FILE="$2"; shift 2 ;;
    -o|--output-dir) BACKUP_ROOT="$2"; shift 2 ;;
    -n|--retention) RETENTION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ "$RETENTION" =~ ^[1-9][0-9]*$ ]] || die "--retention must be a positive integer (>= 1), got: $RETENTION"

command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "docker compose (the v2 plugin) is required"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

COMPOSE=(docker compose -f "$COMPOSE_FILE")
[[ -f "$ENV_FILE" ]] && COMPOSE+=(--env-file "$ENV_FILE")

# Canonicalise before it ever reaches `docker run -v`: a relative path there (e.g. the
# `backups/20260805T...` shape the usage text above shows) is parsed by Docker as a NAMED VOLUME,
# not a bind mount. The archive would then land in a phantom volume instead of on disk here, while
# db.sql.gz (written directly by this script, not through `docker run -v`) still landed correctly —
# a storage-less backup that still prints "Backup complete".
mkdir -p "$BACKUP_ROOT"
BACKUP_ROOT="$(cd -- "$BACKUP_ROOT" && pwd)"

DB_CID="$("${COMPOSE[@]}" ps -q db)"
[[ -n "$DB_CID" ]] || die "the 'db' service is not running — start the stack before backing up"
STORAGE_CID="$("${COMPOSE[@]}" ps -q storage)"
[[ -n "$STORAGE_CID" ]] || die "the 'storage' service is not running — start the stack before backing up"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

log "Dumping the public schema (schema + data) to $DEST/db-public.sql.gz"
# --clean --if-exists so the dump carries its own DROP-then-CREATE statements, making restore.sh a
# straight replay into an already-running (already-populated) database rather than requiring a
# separate teardown step. $POSTGRES_DB is read from inside the container, where compose already
# resolved it from the env file — this script never needs to parse the env file itself.
#
# The awk filter holds back the `ALTER DEFAULT PRIVILEGES FOR ROLE <someone-else>` statements (see
# the header). pg_dump has no flag for this, and leaving them in would force restore.sh to either
# drop ON_ERROR_STOP=1 or die on the last few lines of an otherwise complete restore. Anything held
# back is written out in full rather than discarded, and a form this filter does not recognise (a
# statement wrapped across lines) aborts the backup instead of being silently mangled.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U postgres -d "$POSTGRES_DB" -n public --clean --if-exists' \
  | awk -v holdback="$DEST/db-superuser-only.sql" '
      BEGIN {
        print "-- Held back from db-public.sql.gz by deploy/backup.sh: statements pg_dump emitted"  > holdback
        print "-- that the `postgres` role is not permitted to execute on this image."              > holdback
        print "-- deploy/restore.sh does NOT apply these. Apply them by hand as a superuser if you" > holdback
        print "-- need them; see the header of deploy/backup.sh for why they are usually moot."     > holdback
        print ""                                                                                   > holdback
      }
      /^ALTER DEFAULT PRIVILEGES FOR ROLE / {
        if ($0 !~ /;[[:space:]]*$/) {
          print "backup.sh: ALTER DEFAULT PRIVILEGES statement is not on one line — this filter" > "/dev/stderr"
          print "backup.sh: cannot classify it safely. Refusing to write a dump that may not replay." > "/dev/stderr"
          exit 1
        }
        if ($6 != "postgres") { print > holdback; next }
      }
      { print }
    ' \
  | gzip > "$DEST/db-public.sql.gz"

log "Dumping auth and storage row data to $DEST/db-auth-storage.sql.gz"
# --data-only, because `postgres` cannot create or drop these tables — only fill and empty them.
# auth.schema_migrations and storage.migrations are excluded: `postgres` has no privilege on either
# (measured with has_table_privilege), and they belong to GoTrue and storage-api, which maintain
# them themselves.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U postgres -d "$POSTGRES_DB" --data-only -n auth -n storage -T auth.schema_migrations -T storage.migrations' \
  | gzip > "$DEST/db-auth-storage.sql.gz"

log "Archiving storage volume to $DEST/storage.tar.gz"
# A throwaway container mounts the storage container's volumes with --volumes-from and tars them.
# This works no matter what the volume is named or how it's backed (named volume, bind mount,
# remote docker engine) — it never needs to know the volume name, only the running container.
docker run --rm \
  --volumes-from "$STORAGE_CID" \
  -v "$DEST:/backup" \
  "$ALPINE_IMAGE" \
  tar czf /backup/storage.tar.gz -C /var/lib/storage .

log "Backup complete: $DEST"

log "Enforcing retention (keeping the $RETENTION most recent backups)"
# Portable read loop, not `mapfile` (bash 4+; macOS ships bash 3.2 and would die here). The listing
# is captured via command substitution rather than `< <(...)` process substitution specifically so
# that `set -o pipefail` (from `set -euo pipefail` above) can see a failing `find`: a pipeline inside
# process substitution reports the exit status of the thing consuming it (`read`), not of `find`, so
# a failed `find` would otherwise silently yield an empty list and the sweep below would be skipped
# without complaint.
existing_raw="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z' | sort)" ||
  die "failed to list existing backups under $BACKUP_ROOT"
existing=()
while IFS= read -r dir; do
  [[ -n "$dir" ]] && existing+=("$dir")
done <<< "$existing_raw"
count=${#existing[@]}
if (( count > RETENTION )); then
  to_delete=$(( count - RETENTION ))
  for ((i = 0; i < to_delete; i++)); do
    log "Removing old backup: ${existing[$i]}"
    rm -rf -- "${existing[$i]}"
  done
fi

log "Done. This backup has not been proven restorable — see deploy/restore.sh and test it."
