#!/usr/bin/env bash
# deploy/restore.sh — the inverse of deploy/backup.sh: replay a database dump and unpack a storage
# archive from one timestamped backup directory back into a running stack.
#
# A backup that has never been restored is a hope, not a backup. Running this script IS the test —
# the deployment doc tells the operator to run a full backup -> restore cycle against a throwaway
# stack (never against the live one) before ever trusting either script in a real incident. A
# restore nobody has rehearsed is a plan nobody has checked will work.
#
# Restoring destroys whatever is currently in the target stack's database and storage volume and
# replaces it with the contents of the backup — that is the entire point of a restore, and also
# exactly why this refuses to run without an explicit --yes-overwrite flag. A restore script that
# fires on a typo, a copy-pasted example, or a missing argument is a data-loss weapon, not a safety
# net.
#
# Takes the compose file/env file as arguments rather than hardcoding a project, so the same script
# restores into any deployment of this stack. It never touches the local development Supabase stack
# (supabase_*_network-doc-platform, ports 54321-54326) — that stack is managed by the Supabase CLI,
# not by deploy/docker-compose.yml, so the default arguments here cannot reach it.
#
# WHAT COMES BACK, AND WHAT DOES NOT
#
# The database arrives in two pieces because `postgres` is not a superuser here — see the header of
# deploy/backup.sh for the full reasoning. `db-public.sql.gz` is a normal DROP-then-CREATE replay of
# everything `postgres` owns; `db-auth-storage.sql.gz` is rows only, TRUNCATEd and reinserted into
# tables GoTrue and storage-api own and recreate themselves.
#
# TWO THINGS AN OPERATOR MUST KNOW BEFORE TRUSTING THIS:
#
# 1. Restoring an OLDER backup after schema changes will FAIL LOUDLY, not silently half-restore.
#    Because the public dump is scoped with `-n public`, its clean-up ends in `DROP SCHEMA IF EXISTS
#    public;` — no CASCADE — so any table created since the backup (a migration applied after it)
#    makes that statement error, the whole replay rolls back (--single-transaction), and this script
#    exits non-zero having changed nothing in the database. That is deliberate: the alternative is a
#    database that is half old data and half new tables and looks fine. If you truly must restore
#    across a schema change, roll the schema back first, or drop the newer tables by hand once you
#    have decided that is what you want.
# 2. `auth.schema_migrations` and `storage.migrations` are not restored — `postgres` may not write
#    them. They are GoTrue's and storage-api's own ledgers of which migrations they have run, and
#    those services rebuild them. Restore into a stack running the SAME image versions the backup
#    was taken from; restoring auth rows into an older GoTrue is not covered by this script.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
INPUT_DIR=""
YES_OVERWRITE="false"
ALPINE_IMAGE="alpine:3.20"

usage() {
  cat <<EOF
Usage: $(basename "$0") --input-dir DIR --yes-overwrite [options]

Replays the database dumps and unpacks the storage archive from a timestamped backup directory (as
produced by deploy/backup.sh) into a running stack, DESTROYING what is currently there.

  -i, --input-dir DIR       backup directory containing db-public.sql.gz, db-auth-storage.sql.gz
                             and storage.tar.gz (required)
  -f, --compose-file FILE   docker-compose.yml of the stack to restore into (default: $COMPOSE_FILE)
  -e, --env-file FILE       .env file to pass to docker compose (default: $ENV_FILE)
      --yes-overwrite       required. Confirms you intend to overwrite the target stack's current
                             database and storage contents. There is no other way to make this
                             script run.
  -h, --help                show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--input-dir) INPUT_DIR="$2"; shift 2 ;;
    -f|--compose-file) COMPOSE_FILE="$2"; shift 2 ;;
    -e|--env-file) ENV_FILE="$2"; shift 2 ;;
    --yes-overwrite) YES_OVERWRITE="true"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -n "$INPUT_DIR" ]] || { usage >&2; die "--input-dir is required"; }
[[ -d "$INPUT_DIR" ]] || die "backup directory not found: $INPUT_DIR"
# Canonicalise before it ever reaches `docker run -v`: a relative path there (e.g. the
# `backups/20260805T...` shape the usage text above shows) is parsed by Docker as a NAMED VOLUME,
# not a bind mount. The host-side file checks below would still pass — they read the real directory —
# but the container would see an empty /backup, so storage gets wiped and the tar extract then fails
# against a volume that was never actually mounted here.
INPUT_DIR="$(cd -- "$INPUT_DIR" && pwd)"
if [[ -f "$INPUT_DIR/db.sql.gz" && ! -f "$INPUT_DIR/db-public.sql.gz" ]]; then
  die "$INPUT_DIR holds a single db.sql.gz, which is the old whole-database dump format. That dump cannot be replayed by the 'postgres' role on this image at all — it begins with DROP EVENT TRIGGER, which 'postgres' does not own — which is why backup.sh now splits it. Take a fresh backup; this one was never restorable."
fi
[[ -f "$INPUT_DIR/db-public.sql.gz" ]] || die "missing $INPUT_DIR/db-public.sql.gz — is this a backup.sh output directory?"
[[ -f "$INPUT_DIR/db-auth-storage.sql.gz" ]] || die "missing $INPUT_DIR/db-auth-storage.sql.gz — is this a backup.sh output directory?"
[[ -f "$INPUT_DIR/storage.tar.gz" ]] || die "missing $INPUT_DIR/storage.tar.gz — is this a backup.sh output directory?"

if [[ "$YES_OVERWRITE" != "true" ]]; then
  die "refusing to run without --yes-overwrite. This DESTROYS the target stack's current database and storage contents and replaces them with $INPUT_DIR. Re-run with --yes-overwrite once you are certain — and if you have never restored a backup before, practice this against a throwaway stack first, not here."
fi

command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "docker compose (the v2 plugin) is required"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

COMPOSE=(docker compose -f "$COMPOSE_FILE")
[[ -f "$ENV_FILE" ]] && COMPOSE+=(--env-file "$ENV_FILE")

DB_CID="$("${COMPOSE[@]}" ps -q db)"
[[ -n "$DB_CID" ]] || die "the 'db' service is not running — start the stack before restoring"
STORAGE_CID="$("${COMPOSE[@]}" ps -q storage)"
[[ -n "$STORAGE_CID" ]] || die "the 'storage' service is not running — start the stack before restoring"

log "Stopping app, auth, rest and storage — db stays up so the replays below can reach it"
# app/auth/rest/storage all hold connections open and keep writing straight through a live replay
# otherwise, and PostgREST caches the schema at startup — a stale cache would survive an in-place
# restore even though the underlying tables changed. Stopping them (not just leaving them up) and
# restarting them at the end forces both problems closed. $DB_CID and $STORAGE_CID above were
# captured while these were still running, and remain valid identifiers for stopped containers.
#
# The trap brings them back however this script ends. A restore that aborts still has to exit
# non-zero and loudly — that is what the `exit $status` below preserves — but it must not also leave
# the site dark: every step that can fail either rolls back (--single-transaction) or verifies before
# it deletes (the tar check further down), so on failure the stack is still serving the data it had
# before, and there is no reason to keep it stopped while someone reads the error.
restore_failed_note=""
restart_services() {
  local status=$?
  log "Restarting app, auth, rest and storage"
  "${COMPOSE[@]}" start app auth rest storage || true
  if (( status != 0 )); then
    printf '\nerror: RESTORE FAILED (exit %d)%s\n' "$status" "$restore_failed_note" >&2
    printf 'error: the stack has been restarted and is serving whatever it held before this run.\n' >&2
  fi
  exit "$status"
}
trap restart_services EXIT

"${COMPOSE[@]}" stop app auth rest storage
restore_failed_note=" — nothing in this backup was applied"

log "Restoring the public schema from $INPUT_DIR/db-public.sql.gz"
# The dump was produced with --clean --if-exists, so it carries its own DROP-then-CREATE statements
# — this is a straight replay, not a separate teardown step. $POSTGRES_DB is read inside the
# container, same as backup.sh, so this script never needs to parse the env file itself.
#
# --single-transaction so a failure part-way leaves the database exactly as it was rather than
# half-dropped: without it, ON_ERROR_STOP=1 stops the replay but keeps every DROP already committed,
# which is precisely how the previous version of this script destroyed a database it could not then
# refill.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
gunzip -c "$INPUT_DIR/db-public.sql.gz" \
  | "${COMPOSE[@]}" exec -T db sh -c 'psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction'
restore_failed_note=" — the public schema was restored; auth, storage and the files were not"

log "Restoring auth and storage rows from $INPUT_DIR/db-auth-storage.sql.gz"
# Data-only, so the tables have to be emptied first — `postgres` may TRUNCATE them even though it
# may not drop them.
#
# The truncate list is built at restore time from has_table_privilege() rather than hardcoded, so a
# table added by a future GoTrue or storage-api migration is emptied too instead of being quietly
# left with stale rows underneath the restored ones, and so the two tables `postgres` may NOT touch
# (auth.schema_migrations, storage.migrations — also excluded from the dump) are skipped without
# this script having to name them twice. All of them are truncated in ONE statement: TRUNCATE
# refuses to empty a table another table's foreign key points at unless that other table is in the
# same statement, and session_replication_role does not exempt it (measured).
#
# FOREIGN KEYS DURING THE DATA LOAD: rows do not arrive in dependency order (auth.identities is
# COPYed before auth.users), so something has to hold the FK triggers off. Three candidates were
# tested against this image as `postgres`:
#   * pg_dump --disable-triggers -> emits ALTER TABLE ... DISABLE TRIGGER ALL -> "ERROR: must be
#     owner of table users". Unusable.
#   * SET session_replication_role = replica -> permitted, and it is what is used below. Verified by
#     running it and reading back SHOW session_replication_role.
#   * a single wrapping transaction alone -> would not have sufficed on its own: pg_dump's FK
#     constraints are NOT DEFERRABLE, so SET CONSTRAINTS ALL DEFERRED cannot defer them.
# --single-transaction is used anyway, so a failed load rolls back to the pre-truncate state instead
# of leaving auth empty.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
{
  cat <<'SQL'
SET session_replication_role = replica;
DO $$
DECLARE tlist text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO tlist
    FROM pg_tables
   WHERE schemaname IN ('auth', 'storage')
     AND has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE');
  IF tlist IS NULL THEN
    RAISE EXCEPTION 'no truncatable table found in auth/storage — refusing to load rows on top of whatever is already there';
  END IF;
  RAISE NOTICE 'emptying before reload: %', tlist;
  EXECUTE 'TRUNCATE TABLE ' || tlist;
END
$$;
SQL
  gunzip -c "$INPUT_DIR/db-auth-storage.sql.gz"
} | "${COMPOSE[@]}" exec -T db sh -c 'psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction'
restore_failed_note=" — the database was restored; the storage files were not"

if [[ -s "$INPUT_DIR/db-superuser-only.sql" ]] && command grep -qv '^--\|^$' "$INPUT_DIR/db-superuser-only.sql"; then
  log "Note: $INPUT_DIR/db-superuser-only.sql holds statements this role cannot run and that were NOT applied"
  log "     (default privileges owned by another role — see the header of deploy/backup.sh)"
fi

log "Restoring storage volume from $INPUT_DIR/storage.tar.gz"
# Mirrors backup.sh's approach: a throwaway container mounts the storage container's volumes with
# --volumes-from and unpacks the archive over them. This never needs to know the volume's name, only
# the running container.
#
# The archive is verified with `tar tzf` BEFORE anything on the live volume is touched. Without this,
# a truncated or corrupt storage.tar.gz would only be discovered after `find -delete` had already
# removed every floor plan and avatar — at which point there is nothing left to fall back to. If
# verification fails, this exits without deleting anything.
docker run --rm \
  --volumes-from "$STORAGE_CID" \
  -v "$INPUT_DIR:/backup:ro" \
  "$ALPINE_IMAGE" \
  sh -c '
    tar tzf /backup/storage.tar.gz >/dev/null || {
      echo "storage.tar.gz failed to verify — refusing to touch /var/lib/storage" >&2
      exit 1
    }
    find /var/lib/storage -mindepth 1 -delete && tar xzf /backup/storage.tar.gz -C /var/lib/storage
  '

log "Restore complete from $INPUT_DIR — app, auth, rest and storage restart below"
# The EXIT trap installed above does the restarting, on this path and on every failure path alike.
