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

[[ "$RETENTION" =~ ^[0-9]+$ ]] || die "--retention must be a non-negative integer, got: $RETENTION"

command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "docker compose (the v2 plugin) is required"
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

COMPOSE=(docker compose -f "$COMPOSE_FILE")
[[ -f "$ENV_FILE" ]] && COMPOSE+=(--env-file "$ENV_FILE")

DB_CID="$("${COMPOSE[@]}" ps -q db)"
[[ -n "$DB_CID" ]] || die "the 'db' service is not running — start the stack before backing up"
STORAGE_CID="$("${COMPOSE[@]}" ps -q storage)"
[[ -n "$STORAGE_CID" ]] || die "the 'storage' service is not running — start the stack before backing up"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$STAMP"
mkdir -p "$DEST"

log "Dumping database to $DEST/db.sql.gz"
# --clean --if-exists so the dump itself contains DROP-then-CREATE statements, making restore.sh a
# straight replay into an already-running (already-populated) database rather than requiring a
# separate teardown step. $POSTGRES_DB is read from inside the container, where compose already
# resolved it from the env file — this script never needs to parse the env file itself.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U postgres -d "$POSTGRES_DB" --clean --if-exists' \
  | gzip > "$DEST/db.sql.gz"

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
mkdir -p "$BACKUP_ROOT"
mapfile -t existing < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z' | sort)
count=${#existing[@]}
if (( count > RETENTION )); then
  to_delete=$(( count - RETENTION ))
  for ((i = 0; i < to_delete; i++)); do
    log "Removing old backup: ${existing[$i]}"
    rm -rf -- "${existing[$i]}"
  done
fi

log "Done. This backup has not been proven restorable — see deploy/restore.sh and test it."
