#!/usr/bin/env bash
# deploy/restore.sh — the inverse of deploy/backup.sh: replay a database backup and unpack a storage
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
# WHAT COMES BACK, AND IN WHAT ORDER
#
# The backup is split along SCHEMA vs DATA rather than by schema name — see the header of
# deploy/backup.sh for why `postgres` cannot replay a whole-database dump at all. So:
#
#   1. db-schema-public.sql.gz  DROP-then-CREATE of everything `postgres` owns in `public`. This
#                               leaves every public table present and EMPTY.
#   2. 0033_default_privileges  the schema's default privileges, which step 1 destroyed.
#   3. db-data.sql.gz           the rows for `public`, `auth` and `storage`, all from one snapshot.
#                               auth and storage are TRUNCATEd first (their tables were not dropped,
#                               because `postgres` may not drop them); public's tables are already
#                               empty from step 1.
#   4. storage.tar.gz           the files behind storage.objects.
#
# NOTHING IS DESTROYED UNTIL EVERY ARCHIVE HAS BEEN VERIFIED.
#
# All three archives are decompressed and checked in full BEFORE the first destructive statement,
# and the two SQL dumps are replayed from the already-verified temporary files rather than from the
# .gz a second time. This is not belt-and-braces; it is the difference between a failed restore and
# a destroyed database. `gunzip -c` on a truncated archive writes the valid PREFIX to stdout and only
# then exits non-zero — and psql, having seen a perfectly clean EOF, COMMITS. A backup directory left
# by a filesystem that filled mid-gzip would therefore replay `DROP SCHEMA public`, recreate half the
# tables, commit, and only afterwards would `set -o pipefail` notice — at which point the failure
# note printed below said "nothing in this backup was applied". It was not true, and the data was
# gone. Verifying up front is what makes the claim true.
#
# TWO THINGS AN OPERATOR MUST KNOW BEFORE TRUSTING THIS:
#
# 1. Restoring an OLDER backup after schema changes will FAIL LOUDLY, not silently half-restore.
#    Because the schema dump is scoped with `-n public`, its clean-up ends in `DROP SCHEMA IF EXISTS
#    public;` — no CASCADE — so any table created since the backup (a migration applied after it)
#    makes that statement error, the whole replay rolls back (--single-transaction), and this script
#    exits non-zero having changed nothing in the database. That is deliberate: the alternative is a
#    database that is half old data and half new tables and looks fine. If you truly must restore
#    across a schema change, roll the schema back first, or drop the newer tables by hand once you
#    have decided that is what you want.
# 2. `auth.schema_migrations` and `storage.migrations` are not restored — `postgres` may not write
#    them. They are GoTrue's and storage-api's own ledgers of which migrations they have run, and
#    those services rebuild them. The backup names them in excluded-tables.txt and this script reads
#    that file, so the tables it refuses to empty are exactly the tables the dump cannot refill.
#    Restore into a stack running the SAME image versions the backup was taken from; restoring auth
#    rows into an older GoTrue is not covered by this script.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
ENV_FILE="$SCRIPT_DIR/.env"
# Derived from this script's own location, not from the caller's working directory, so it resolves
# the same whether restore.sh is invoked as ./deploy/restore.sh, from inside deploy/, or by absolute
# path. See the "DEFAULT PRIVILEGES" step below for what it is for.
DEFAULT_PRIVILEGES_SQL="$SCRIPT_DIR/../supabase/migrations/0033_default_privileges.sql"
INPUT_DIR=""
YES_OVERWRITE="false"
ALPINE_IMAGE="alpine:3.20"
COMPLETE_MARKER="COMPLETE"

usage() {
  cat <<EOF
Usage: $(basename "$0") --input-dir DIR --yes-overwrite [options]

Replays the database dumps and unpacks the storage archive from a timestamped backup directory (as
produced by deploy/backup.sh) into a running stack, DESTROYING what is currently there.

  -i, --input-dir DIR       backup directory containing db-schema-public.sql.gz, db-data.sql.gz,
                             storage.tar.gz and a COMPLETE marker (required)
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

if [[ -f "$INPUT_DIR/db.sql.gz" && ! -f "$INPUT_DIR/db-data.sql.gz" ]]; then
  die "$INPUT_DIR holds a single db.sql.gz, which is the old whole-database dump format. That dump cannot be replayed by the 'postgres' role on this image at all — it begins with DROP EVENT TRIGGER, which 'postgres' does not own. Take a fresh backup; this one was never restorable."
fi
if [[ -f "$INPUT_DIR/db-public.sql.gz" && ! -f "$INPUT_DIR/db-data.sql.gz" ]]; then
  die "$INPUT_DIR holds db-public.sql.gz + db-auth-storage.sql.gz, the old two-dump layout. Those were two snapshots taken at two different times on a live stack, so the file could hold a members row whose auth.users row was never captured. backup.sh now takes all three schemas' data in one snapshot. Take a fresh backup."
fi

# A directory with no COMPLETE marker is either a backup that died mid-run or one still being
# written by another process. Neither is restorable, and a restore is precisely the moment not to
# find that out halfway through.
[[ -f "$INPUT_DIR/$COMPLETE_MARKER" ]] ||
  die "$INPUT_DIR carries no $COMPLETE_MARKER marker — it is not a finished backup. backup.sh writes that file last, after every dump and the storage archive have succeeded and been verified. Restoring a directory without it would replay a partial dump over a live database. Choose a backup that has one."

[[ -f "$INPUT_DIR/db-schema-public.sql.gz" ]] || die "missing $INPUT_DIR/db-schema-public.sql.gz — is this a backup.sh output directory?"
[[ -f "$INPUT_DIR/db-data.sql.gz" ]] || die "missing $INPUT_DIR/db-data.sql.gz — is this a backup.sh output directory?"
[[ -f "$INPUT_DIR/storage.tar.gz" ]] || die "missing $INPUT_DIR/storage.tar.gz — is this a backup.sh output directory?"
[[ -f "$INPUT_DIR/excluded-tables.txt" ]] || die "missing $INPUT_DIR/excluded-tables.txt — backup.sh writes the list of tables its data dump leaves out, and this script needs it to know which tables it must NOT empty. Without it a restore could TRUNCATE a table nothing in the dump can refill."

if [[ "$YES_OVERWRITE" != "true" ]]; then
  die "refusing to run without --yes-overwrite. This DESTROYS the target stack's current database and storage contents and replaces them with $INPUT_DIR. Re-run with --yes-overwrite once you are certain — and if you have never restored a backup before, practice this against a throwaway stack first, not here."
fi

command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "docker compose (the v2 plugin) is required"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
# Checked HERE, before a single destructive statement runs, rather than at the point of use. If this
# file is missing the restore must not start at all: it would otherwise drop the schema, refill it,
# and only then discover it cannot close the default privileges — leaving a database whose next
# `create table` is unreadable by every server action. Failing before the DROP leaves the stack
# serving exactly what it was serving a second ago.
[[ -f "$DEFAULT_PRIVILEGES_SQL" ]] || die "missing $DEFAULT_PRIVILEGES_SQL — restore.sh re-applies that migration after the schema replay, because replaying the dump destroys the schema's default privileges and pg_dump only re-emits two of them. Without it the restored database silently gives service_role no access to any table created afterwards. Run restore.sh from a full checkout of this repository, not from a copy of deploy/ on its own."

# ---------------------------------------------------------------------------
# VERIFY EVERY ARCHIVE — still before anything is stopped, let alone destroyed
# ---------------------------------------------------------------------------
WORK_DIR="$(mktemp -d)"
# Installed now and REPLACED further down by restart_services (which also removes this directory), so
# a failure between here and there does not leave a decompressed copy of the database in /tmp.
trap 'rm -rf -- "$WORK_DIR"' EXIT

log "Verifying every archive in $INPUT_DIR before touching anything"
for archive in db-schema-public.sql.gz db-data.sql.gz storage.tar.gz; do
  gzip -t "$INPUT_DIR/$archive" 2>/dev/null ||
    die "$INPUT_DIR/$archive is corrupt or truncated (failed its gzip integrity check). NOTHING has been changed: the stack is still serving exactly what it was, and this backup directory is not restorable. Use another backup."
done

# The two SQL dumps are decompressed to disk HERE, verified, and replayed from those files. Piping
# `gunzip -c` straight into psql is the trap this whole section exists to close: gunzip writes the
# valid prefix of a truncated stream before failing, psql sees a clean EOF and commits the partial
# replay, and pipefail only reports the failure afterwards.
SCHEMA_SQL="$WORK_DIR/db-schema-public.sql"
DATA_SQL="$WORK_DIR/db-data.sql"
gunzip -c "$INPUT_DIR/db-schema-public.sql.gz" > "$SCHEMA_SQL" ||
  die "failed to decompress $INPUT_DIR/db-schema-public.sql.gz — nothing has been changed"
gunzip -c "$INPUT_DIR/db-data.sql.gz" > "$DATA_SQL" ||
  die "failed to decompress $INPUT_DIR/db-data.sql.gz — nothing has been changed"

# A second, independent check on the decompressed text. pg_dump ends every dump with this line, so
# its absence means the dump was cut short at the SOURCE — a pg_dump killed mid-stream, whose output
# gzip then compressed and closed perfectly cleanly. gzip -t cannot see that; this can.
for pair in "db-schema-public.sql.gz:$SCHEMA_SQL" "db-data.sql.gz:$DATA_SQL"; do
  name="${pair%%:*}"
  path="${pair#*:}"
  tail -n 5 "$path" | command grep -q 'PostgreSQL database dump complete' ||
    die "$INPUT_DIR/$name decompressed cleanly but does not end with pg_dump's completion marker, so it was cut short when it was written. Replaying it would drop the schema and refill only part of it. NOTHING has been changed."
done
log "All archives verified"

# The exclusion list travels with the backup (backup.sh writes it from the same array it builds
# pg_dump's -T flags from), so the tables this script refuses to empty are exactly the tables the
# dump cannot refill. Deriving it independently — the old version asked has_table_privilege() which
# tables `postgres` MAY truncate — meant the day an image granted TRUNCATE on GoTrue's migration
# ledger, a restore would empty it with nothing to reload.
excluded_tables=()
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  [[ "$line" =~ ^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$ ]] ||
    die "excluded-tables.txt contains a line that is not a plain schema.table name: $line"
  excluded_tables+=("$line")
done < "$INPUT_DIR/excluded-tables.txt"
[[ ${#excluded_tables[@]} -gt 0 ]] || die "excluded-tables.txt is empty — backup.sh always writes at least auth.schema_migrations and storage.migrations"
# Built as a SQL array literal. Every element has already been checked against the regex above, so
# there is nothing here that could carry a quote out of the string.
excluded_sql_array=""
for excluded in "${excluded_tables[@]}"; do
  [[ -n "$excluded_sql_array" ]] && excluded_sql_array+=", "
  excluded_sql_array+="'$excluded'"
done

# Mode-aware, the same way install.sh is. This script only `exec`s, `stop`s and `start`s, so today
# the single -f publishes nothing and breaks nothing — but a compose invocation missing
# docker-compose.tunnel.yml does not KNOW about the `cloudflared` service, and the first
# `--remove-orphans` added here (or to a wrapper) would delete it mid-restore, taking the site off the
# internet at the exact moment someone is recovering it. The mode comes from the same deploy/.env
# install.sh wrote it to.
DEPLOY_MODE=""
if [[ -f "$ENV_FILE" ]]; then
  # `|| true` — under `set -o pipefail` a grep that matches nothing fails the pipeline, and with
  # `set -e` that would abort a restore against any stack whose .env predates DEPLOY_MODE.
  DEPLOY_MODE="$(command grep -E '^DEPLOY_MODE=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)"
fi

COMPOSE=(docker compose -f "$COMPOSE_FILE")
if [[ "$DEPLOY_MODE" == "tunnel" ]]; then
  # Alongside whatever --compose-file was given, so a stack installed elsewhere resolves its own
  # override rather than this checkout's.
  TUNNEL_COMPOSE_FILE="$(dirname -- "$COMPOSE_FILE")/docker-compose.tunnel.yml"
  [[ -f "$TUNNEL_COMPOSE_FILE" ]] ||
    die "$ENV_FILE says DEPLOY_MODE=tunnel but $TUNNEL_COMPOSE_FILE is missing — that is the file defining the cloudflared service"
  COMPOSE+=(-f "$TUNNEL_COMPOSE_FILE")
fi
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
# the site dark: every step that can fail either rolls back (--single-transaction) or was verified
# before anything was deleted (the archive checks above, and the tar check further down), so on
# failure the stack is still serving the data it had before, and there is no reason to keep it
# stopped while someone reads the error.
#
# A restart that FAILS is itself a failure. `start ... || true` used to swallow it, so a stack that
# could not come back up still exited 0 with the site down — the one outcome an operator would never
# check for, because the script said it was fine.
restore_failed_note=""
restart_services() {
  local status=$?
  rm -rf -- "$WORK_DIR"
  log "Restarting app, auth, rest and storage"
  local start_ok="true"
  "${COMPOSE[@]}" start app auth rest storage || start_ok="false"

  # The exit status of `start` is necessary but NOT sufficient, measured on this stack: after
  # `docker compose rm -f app`, `docker compose start app auth rest storage` started the other three,
  # printed nothing about app, and exited 0 — with the app container gone and the site dark. So the
  # resulting state is read back as well, and only "running" for all four counts as back up.
  local not_running="" svc state
  for svc in app auth rest storage; do
    state="$("${COMPOSE[@]}" ps --format '{{.State}}' "$svc" 2>/dev/null | head -n1 || true)"
    [[ "$state" == "running" ]] || not_running="$not_running $svc(${state:-no container})"
  done

  if [[ "$start_ok" != "true" || -n "$not_running" ]]; then
    printf '\nerror: the stack did NOT come back up. Not running:%s\n' "${not_running:- (start reported a failure)}" >&2
    printf "error: the site is down. Read '%s ps' and '%s logs'.\n" "${COMPOSE[*]}" "${COMPOSE[*]}" >&2
    if (( status == 0 )); then
      status=1
    fi
  fi
  if (( status != 0 )); then
    printf '\nerror: RESTORE FAILED (exit %d)%s\n' "$status" "$restore_failed_note" >&2
  fi
  exit "$status"
}
trap restart_services EXIT

"${COMPOSE[@]}" stop app auth rest storage
restore_failed_note=" — nothing in this backup was applied; the stack is serving whatever it held before this run"

log "Restoring the public schema (structure) from $INPUT_DIR/db-schema-public.sql.gz"
# The dump was produced with --clean --if-exists, so it carries its own DROP-then-CREATE statements
# — this is a straight replay, not a separate teardown step. $POSTGRES_DB is read inside the
# container, same as backup.sh, so this script never needs to parse the env file itself.
#
# --single-transaction so a failure part-way leaves the database exactly as it was rather than
# half-dropped: without it, ON_ERROR_STOP=1 stops the replay but keeps every DROP already committed,
# which is precisely how an earlier version of this script destroyed a database it could not then
# refill. Fed from the verified temporary file, never from `gunzip -c` on a pipe.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
"${COMPOSE[@]}" exec -T db sh -c 'psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction' \
  < "$SCHEMA_SQL"
restore_failed_note=" — the public schema was rebuilt (and is EMPTY); its default privileges, the row data, and the files were not restored"

log "Re-applying the schema's default privileges from $DEFAULT_PRIVILEGES_SQL"
# The replay above began with `DROP SCHEMA IF EXISTS public;`, and a dropped schema takes every
# pg_default_acl row attached to it with it. pg_dump re-emits only the two SEQUENCES grants; the
# TABLES and FUNCTIONS defaults that migrations 0027, 0028 and 0032 established are simply gone.
# Measured on a restored stack before this step existed:
#
#   anon select on a new table         = false
#   service_role select on a new table = false   <- the whole application, locked out
#
# so the next migration to add a table would produce one none of the 61 server actions could read or
# write. That is exactly the failure 0028 exists to prevent.
#
# 0033 holds that state as one idempotent block and is the ONLY copy of it. Deliberately not inlined
# here: a second copy in this script would be edited by whoever changes a migration exactly never,
# and the two would drift apart with only a restore able to show it.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
"${COMPOSE[@]}" exec -T db sh -c 'psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --single-transaction' \
  < "$DEFAULT_PRIVILEGES_SQL"
restore_failed_note=" — the public schema and its default privileges were rebuilt (and public is EMPTY); the row data and the files were not restored"

log "Restoring public, auth and storage rows from $INPUT_DIR/db-data.sql.gz"
# Data-only, so the tables have to be empty first. `public` already is — the schema replay above
# dropped and recreated it. `auth` and `storage` are not, because `postgres` may not drop those
# tables, so they are TRUNCATEd here; it may do that.
#
# The truncate list is every table in auth and storage MINUS the ones the backup says its dump left
# out (read from excluded-tables.txt above). A table added by a future GoTrue or storage-api
# migration is therefore emptied too, instead of being quietly left with stale rows underneath the
# restored ones — while the two ledgers the dump cannot refill are never emptied. All of them are
# truncated in ONE statement: TRUNCATE refuses to empty a table another table's foreign key points at
# unless that other table is in the same statement, and session_replication_role does not exempt it
# (measured).
#
# FOREIGN KEYS DURING THE DATA LOAD: rows do not arrive in dependency order (auth.identities is
# COPYed before auth.users, and public.members references auth.users across the schema boundary), so
# something has to hold the FK triggers off. Three candidates were tested against this image as
# `postgres`:
#   * pg_dump --disable-triggers -> emits ALTER TABLE ... DISABLE TRIGGER ALL -> "ERROR: must be
#     owner of table users". Unusable.
#   * SET session_replication_role = replica -> permitted, and it is what is used below. Verified by
#     running it and reading back SHOW session_replication_role.
#   * a single wrapping transaction alone -> would not have sufficed on its own: pg_dump's FK
#     constraints are NOT DEFERRABLE, so SET CONSTRAINTS ALL DEFERRED cannot defer them.
# --single-transaction is used anyway, so a failed load rolls back to the pre-truncate state instead
# of leaving auth empty.
#
# The dump is a verified file on disk (see the verification section), and the TRUNCATE preamble is
# prepended to it here — so if anything in this concatenation is short, it was short before a single
# byte was written to the database.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
{
  cat <<SQL
SET session_replication_role = replica;
DO \$\$
DECLARE tlist text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO tlist
    FROM pg_tables
   WHERE schemaname IN ('auth', 'storage')
     AND schemaname || '.' || tablename <> ALL (ARRAY[$excluded_sql_array])
     AND has_table_privilege(current_user, format('%I.%I', schemaname, tablename), 'TRUNCATE');
  IF tlist IS NULL THEN
    RAISE EXCEPTION 'no truncatable table found in auth/storage — refusing to load rows on top of whatever is already there';
  END IF;
  RAISE NOTICE 'emptying before reload: %', tlist;
  EXECUTE 'TRUNCATE TABLE ' || tlist;
END
\$\$;
SQL
  cat "$DATA_SQL"
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
# The archive was already gzip-verified on the host before anything was destroyed; `tar tzf` here
# additionally proves the tar structure inside it, and it runs BEFORE `find -delete` touches the live
# volume. Without that ordering a corrupt storage.tar.gz would only be discovered after every floor
# plan and avatar had already been removed.
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

# From here the only thing that can still fail is the restart, so the note has to stop claiming the
# storage files were missed — the operator would go looking for a data problem that is not there.
restore_failed_note=" — the restore itself COMPLETED; only bringing the services back up failed, so the data is in place and this is a startup problem"

log "Restore complete from $INPUT_DIR — app, auth, rest and storage restart below"
# The EXIT trap installed above does the restarting, on this path and on every failure path alike,
# and a restart that fails makes this script exit non-zero even from here.
