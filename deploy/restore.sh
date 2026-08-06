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

Replays a database dump and unpacks a storage archive from a timestamped backup directory (as
produced by deploy/backup.sh) into a running stack, DESTROYING what is currently there.

  -i, --input-dir DIR       backup directory containing db.sql.gz and storage.tar.gz (required)
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
[[ -f "$INPUT_DIR/db.sql.gz" ]] || die "missing $INPUT_DIR/db.sql.gz — is this a backup.sh output directory?"
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

log "Restoring database from $INPUT_DIR/db.sql.gz"
# The dump was produced with --clean --if-exists, so it already carries its own DROP-then-CREATE
# statements — this is a straight replay, not a separate teardown step. $POSTGRES_DB is read inside
# the container, same as backup.sh, so this script never needs to parse the env file itself.
# shellcheck disable=SC2016 # intentional: $POSTGRES_DB must expand inside the container, not here.
gunzip -c "$INPUT_DIR/db.sql.gz" \
  | "${COMPOSE[@]}" exec -T db sh -c 'psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'

log "Restoring storage volume from $INPUT_DIR/storage.tar.gz"
# Mirrors backup.sh's approach: a throwaway container mounts the storage container's volumes with
# --volumes-from, clears them, and unpacks the archive over them. This never needs to know the
# volume's name, only the running container.
docker run --rm \
  --volumes-from "$STORAGE_CID" \
  -v "$INPUT_DIR:/backup:ro" \
  "$ALPINE_IMAGE" \
  sh -c 'find /var/lib/storage -mindepth 1 -delete && tar xzf /backup/storage.tar.gz -C /var/lib/storage'

log "Restore complete from $INPUT_DIR"
