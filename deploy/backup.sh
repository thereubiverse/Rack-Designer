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
# WHY THE DATABASE IS DUMPED IN TWO PIECES — AND WHERE THE SPLIT IS DRAWN
#
# `postgres` on supabase/postgres is NOT a superuser, and it does not own the `auth` or `storage`
# schemas or any table in them (they belong to supabase_auth_admin / supabase_storage_admin), nor
# the global event triggers (supabase_admin). A whole-database `pg_dump --clean` therefore produces
# a file that `postgres` can never replay: its first statement is `DROP EVENT TRIGGER IF EXISTS
# pgrst_drop_watch;` and it dies there with "must be owner of event trigger". `--if-exists` does not
# help — the trigger DOES exist. That is exactly how the first real restore of this stack failed,
# after which the database was left with its schema intact and every row gone.
#
# The split is along SCHEMA vs DATA, not along which schema. That is deliberate, and it is what makes
# the backup internally consistent:
#
#   db-data.sql.gz          --data-only for `public`, `auth` and `storage` in ONE pg_dump
#                           invocation. One invocation means one repeatable-read snapshot, so every
#                           row in the file comes from the same instant. The previous version took
#                           `public` and `auth`+`storage` as two separate dumps of a live, writing
#                           stack, which produced a torn backup: a member created between the two
#                           dumps yielded a `members` row whose auth_user_id had no `auth.users` row
#                           behind it, and no amount of restoring could invent one.
#                           auth.schema_migrations and storage.migrations are excluded — `postgres`
#                           has no privilege on either (measured with has_table_privilege), and they
#                           are GoTrue's and storage-api's own ledgers, not user data. The exclusion
#                           list is written to excluded-tables.txt beside the dump so restore.sh
#                           skips exactly these tables when it empties the schemas, rather than
#                           deriving the same rule a second, independent way.
#   db-schema-public.sql.gz --schema-only for `public`, --clean --if-exists. `postgres` owns every
#                           table here, so DROP-then-CREATE replays normally. Scoping with -n also
#                           excludes the event triggers, which are global rather than schema-scoped.
#                           The schema is dumped separately from the data because it only changes
#                           when a migration runs, so it does not need to share the data's snapshot.
#                           `auth` and `storage` have no schema dump at all: those tables are
#                           recreated by GoTrue's and storage-api's own migrations, not by us.
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
#   COMPLETE                written last, and only on success. See RETENTION below.
#
# ORDERING: THE DATABASE FIRST, THEN THE FILES.
#
# This script deliberately does NOT quiesce the stack — a nightly backup must not take the site
# down — so there is a window between the database dump and the storage tar in which the app keeps
# writing. The order decides which way an inconsistency falls, and only one direction is survivable:
#
#   database first, then files -> a plan uploaded in the window is a FILE WITH NO ROW. Nothing
#     references it, nothing looks for it, and it costs some disk. Harmless.
#   files first, then database -> a plan uploaded in the window is a ROW WITH NO FILE. The app has
#     a storage.objects row and a link in the UI that 404s, with no way to tell it from corruption.
#
# So: database, then files. The residual window is the duration of the database dump plus the tar,
# and it is not closed — closing it needs a quiesce, which is the one thing a nightly job must not
# do. Rows written during the window are simply absent from the backup, which is what "backup taken
# at time T" already means.
#
# RETENTION ONLY EVER COUNTS COMPLETE BACKUPS. A run that dies mid-dump used to leave its
# timestamped directory behind, and the next successful run counted that carcass toward the
# retention limit and deleted the oldest GOOD backup to make room for it. Now a failed run removes
# its own directory (see the trap below), the sweep only considers directories carrying a COMPLETE
# marker, and it never deletes anything unless this run itself completed.
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

# The ONE definition of what the data dump leaves out. It is used to build pg_dump's -T flags below
# and is written into the backup directory as excluded-tables.txt, which is what restore.sh reads to
# decide which tables NOT to empty. Two independently-derived rules that "happen to coincide" is how
# a future image granting `postgres` TRUNCATE on these ledgers would have let a restore empty
# GoTrue's migration ledger with nothing in the dump to reload into it.
DUMP_EXCLUDED_TABLES=(auth.schema_migrations storage.migrations)
# The name of the marker file that says a backup directory is finished and restorable. restore.sh
# refuses a directory without it.
COMPLETE_MARKER="COMPLETE"

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
# the dumps (written directly by this script, not through `docker run -v`) still landed correctly —
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

# A half-written backup directory is worse than no directory at all: it looks like a backup, it
# sorts as the newest one, and the retention sweep used to count it. Remove it on any non-zero exit,
# including a signal. The marker file is written on the success path, and this trap only fires when
# the script is ending unsuccessfully — so what survives is always either a complete backup or
# nothing.
backup_cleanup() {
  local status=$?
  # Disarm first: this handler ends in `exit`, which would otherwise re-enter it through the EXIT
  # trap when it was reached from INT or TERM.
  trap - EXIT INT TERM
  # A signal that kills the script leaves the same carcass a crash does, and a nightly job is exactly
  # the thing an operator Ctrl-Cs — so INT and TERM are trapped too, and produce a non-zero status
  # here even though bash's own default for them does not run this trap at all.
  if (( status == 0 )) && [[ ! -f "$DEST/$COMPLETE_MARKER" ]]; then
    status=1
  fi
  if (( status != 0 )) && [[ -d "$DEST" && ! -f "$DEST/$COMPLETE_MARKER" ]]; then
    printf '\nerror: backup failed (exit %d) — removing the incomplete directory %s\n' "$status" "$DEST" >&2
    printf 'error: no existing backup was deleted; retention only ever counts completed backups.\n' >&2
    rm -rf -- "$DEST"
  fi
  exit "$status"
}
trap backup_cleanup EXIT INT TERM

log "Dumping the public schema (structure only) to $DEST/db-schema-public.sql.gz"
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
"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U postgres -d "$POSTGRES_DB" -n public --schema-only --clean --if-exists' \
  | awk -v holdback="$DEST/db-superuser-only.sql" '
      BEGIN {
        print "-- Held back from db-schema-public.sql.gz by deploy/backup.sh: statements pg_dump"    > holdback
        print "-- emitted that the `postgres` role is not permitted to execute on this image."       > holdback
        print "-- deploy/restore.sh does NOT apply these. Apply them by hand as a superuser if you"  > holdback
        print "-- need them; see the header of deploy/backup.sh for why they are usually moot."      > holdback
        print ""                                                                                    > holdback
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
  | gzip > "$DEST/db-schema-public.sql.gz"

log "Dumping public, auth and storage row data to $DEST/db-data.sql.gz (one snapshot)"
# ONE pg_dump for all three schemas. pg_dump runs in a single REPEATABLE READ transaction, so every
# row in this file is from the same instant and the cross-schema references inside it (members ->
# auth.users, storage.objects -> storage.buckets) cannot be half-present. Splitting this into two
# invocations is what made the previous backup torn; do not split it again.
exclude_args=()
for excluded in "${DUMP_EXCLUDED_TABLES[@]}"; do
  exclude_args+=(-T "$excluded")
done
# The list travels WITH the backup, so restore.sh empties exactly the tables this dump can refill —
# rather than re-deriving "which tables may postgres truncate?" and hoping the two answers agree.
printf '%s\n' "${DUMP_EXCLUDED_TABLES[@]}" > "$DEST/excluded-tables.txt"

# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
"${COMPOSE[@]}" exec -T db sh -c \
  'pg_dump -U postgres -d "$POSTGRES_DB" --data-only -n public -n auth -n storage "$@"' \
  sh "${exclude_args[@]}" \
  | gzip > "$DEST/db-data.sql.gz"

# Read the dumps back before calling them a backup. gzip -t walks the whole stream and checks the
# CRC and length trailer, so it catches the truncation a full filesystem produces — the exact failure
# restore.sh must never replay half of. Catching it here as well means a directory that survives this
# script is one whose archives have been verified twice, once at each end.
log "Verifying the dumps decompress cleanly"
for archive in "$DEST/db-schema-public.sql.gz" "$DEST/db-data.sql.gz"; do
  gzip -t "$archive" 2>/dev/null || die "$archive failed its gzip integrity check immediately after being written — the backup is not usable"
done

log "Archiving storage volume to $DEST/storage.tar.gz"
# Deliberately AFTER the database dump — see ORDERING in the header. A throwaway container mounts the
# storage container's volumes with --volumes-from and tars them. This works no matter what the volume
# is named or how it's backed (named volume, bind mount, remote docker engine) — it never needs to
# know the volume name, only the running container.
docker run --rm \
  --volumes-from "$STORAGE_CID" \
  -v "$DEST:/backup" \
  "$ALPINE_IMAGE" \
  tar czf /backup/storage.tar.gz -C /var/lib/storage .

gzip -t "$DEST/storage.tar.gz" 2>/dev/null || die "$DEST/storage.tar.gz failed its gzip integrity check immediately after being written — the backup is not usable"

# LAST. Everything above has to have succeeded for this line to run, and restore.sh refuses a
# directory that does not carry it.
date -u +%Y-%m-%dT%H:%M:%SZ > "$DEST/$COMPLETE_MARKER"

log "Backup complete: $DEST"

log "Enforcing retention (keeping the $RETENTION most recent COMPLETE backups)"
# Only completed backups are counted, and only completed backups are deleted. A directory left behind
# by a crashed run — or by a backup still in flight in another process — is neither counted toward
# the limit nor removed here, so it can never cause a good backup to be evicted. This sweep is only
# reached at all when the run above completed, which is the other half of the same rule.
#
# Portable read loop, not `mapfile` (bash 4+; macOS ships bash 3.2 and would die here). The listing
# is captured via command substitution rather than `< <(...)` process substitution specifically so
# that `set -o pipefail` (from `set -euo pipefail` above) can see a failing `find`: a pipeline inside
# process substitution reports the exit status of the thing consuming it (`read`), not of `find`, so
# a failed `find` would otherwise silently yield an empty list and the sweep below would be skipped
# without complaint.
existing_raw="$(find "$BACKUP_ROOT" -mindepth 2 -maxdepth 2 -type f -name "$COMPLETE_MARKER" | sort)" ||
  die "failed to list existing backups under $BACKUP_ROOT"
existing=()
while IFS= read -r marker; do
  [[ -n "$marker" ]] || continue
  marker_dir="$(dirname -- "$marker")"
  # Same timestamp shape this script creates, so an unrelated directory an operator parked under
  # backups/ is never a deletion candidate however it is named.
  [[ "$(basename -- "$marker_dir")" == [0-9]*T*Z ]] || continue
  existing+=("$marker_dir")
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
