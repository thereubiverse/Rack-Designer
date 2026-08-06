#!/usr/bin/env bash
# deploy/install.sh — take a bare server to a working login page.
#
# See docs/superpowers/specs/2026-08-05-self-hosted-design.md and .superpowers/sdd/task-2-brief.md
# for the design this implements. Safe to re-run: it does not regenerate secrets once deploy/.env
# exists, and every write below is `on conflict do nothing` or guarded by an existence check.
#
# This script never touches the local development Supabase stack (supabase_*_network-doc-platform,
# ports 54321-54326) — it only ever talks to the compose project defined by
# deploy/docker-compose.yml, a wholly separate set of containers, network and volumes.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
DEVICE_TOKEN_FILE="$SCRIPT_DIR/first-device-token.txt"
COMPOSE=(docker compose -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE")

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is required"
docker compose version >/dev/null 2>&1 || die "docker compose (the v2 plugin) is required"
command -v node >/dev/null 2>&1 || die "node is required to generate JWTs"
node_major="$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')"
if (( node_major < 18 )); then
  die "node >= 18 is required (found $(node -v)) — Buffer/crypto base64url support is needed"
fi

# Small key=value helpers over deploy/.env, so re-running the script can reuse whatever is already
# there (secrets, hostname) instead of asking again or clobbering it.
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  command grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-
}
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]]; then
    command grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  fi
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# ---------------------------------------------------------------------------
# Step 1: secrets
#
# Self-hosted Supabase has no "API key" — it has a JWT_SECRET, and the anon/service-role keys are
# JWTs signed with that secret carrying {"role": "anon"} / {"role": "service_role"}. Hand-writing
# those is where self-hosting usually goes wrong, so they are signed here with plain HS256
# (base64url(header).base64url(payload), HMAC-SHA256 over that string, base64url) using node's
# built-in crypto — no npm dependency to install on a bare server.
# ---------------------------------------------------------------------------

# $1 = role ("anon" | "service_role"). Reads the secret from an env var rather than argv so it
# never appears in `ps` output.
sign_jwt() {
  local role="$1"
  JWT_SECRET_FOR_SIGNING="$JWT_SECRET" ROLE_FOR_SIGNING="$role" node -e '
    const crypto = require("crypto");
    const secret = process.env.JWT_SECRET_FOR_SIGNING;
    const role = process.env.ROLE_FOR_SIGNING;
    const now = Math.floor(Date.now() / 1000);
    const tenYears = 10 * 365 * 24 * 60 * 60;
    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const header = b64url({ alg: "HS256", typ: "JWT" });
    const payload = b64url({ role, iss: "supabase-self-hosted", iat: now, exp: now + tenYears });
    const signingInput = header + "." + payload;
    const sig = crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
    process.stdout.write(signingInput + "." + sig);
  '
}

# Decode-and-check the token this script just minted, rather than trusting the encoder blindly —
# this is the exact step people skip when they hand-roll these tokens.
verify_jwt() {
  local token="$1" expected_role="$2"
  # SC2016: the `${payload.role}` below is a JavaScript template literal, read by node, and must NOT
  # be expanded by the shell — single quotes are the point.
  # shellcheck disable=SC2016
  TOKEN_FOR_VERIFY="$token" EXPECTED_ROLE="$expected_role" node -e '
    const token = process.env.TOKEN_FOR_VERIFY;
    const expected = process.env.EXPECTED_ROLE;
    const parts = token.split(".");
    if (parts.length !== 3) { console.error("malformed JWT (wrong segment count)"); process.exit(1); }
    let payload;
    try {
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      console.error("malformed JWT (payload does not decode as JSON)"); process.exit(1);
    }
    if (payload.role !== expected) { console.error(`role mismatch: got ${payload.role}`); process.exit(1); }
    if (!(typeof payload.exp === "number" && payload.exp > payload.iat)) {
      console.error("bad exp/iat"); process.exit(1);
    }
  '
}

if [[ -f "$ENV_FILE" ]]; then
  log "deploy/.env already exists — reusing its secrets rather than generating new ones"
else
  log "Generating secrets (POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY)"

  POSTGRES_PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  JWT_SECRET="$(node -e 'process.stdout.write(require("crypto").randomBytes(48).toString("base64url"))')"
  ANON_KEY="$(sign_jwt anon)"
  SERVICE_ROLE_KEY="$(sign_jwt service_role)"

  verify_jwt "$ANON_KEY" anon || die "generated ANON_KEY failed its own decode check — aborting before writing it"
  verify_jwt "$SERVICE_ROLE_KEY" service_role || die "generated SERVICE_ROLE_KEY failed its own decode check — aborting before writing it"

  (
    umask 077
    cat > "$ENV_FILE" <<EOF
# Generated by deploy/install.sh — gitignored, mode 600. Do not commit this file, and do not
# hand-edit the secret values (APP_HOSTNAME and the optional integrations below are fine to edit).
APP_HOSTNAME=
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
POSTGRES_DB=postgres
JWT_SECRET=$JWT_SECRET
ANON_KEY=$ANON_KEY
SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
JWT_EXPIRY=3600
GEMINI_API_KEY=
SMTP_HOST=
SMTP_PORT=
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
SUPABASE_AUTH_GOOGLE_CLIENT_ID=
SUPABASE_AUTH_GOOGLE_SECRET=
SUPABASE_AUTH_AZURE_CLIENT_ID=
SUPABASE_AUTH_AZURE_SECRET=
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
EOF
  )
  chmod 600 "$ENV_FILE"
  log "Wrote deploy/.env (mode 600). Nothing above was printed to the terminal."
fi

# ---------------------------------------------------------------------------
# Step 2: hostname, first admin, password
# ---------------------------------------------------------------------------
log "Step 2: configuration"

APP_HOSTNAME="$(env_get APP_HOSTNAME)"
if [[ -n "$APP_HOSTNAME" ]]; then
  echo "Using existing hostname: $APP_HOSTNAME"
else
  read -r -p "Hostname this server will be reached at (e.g. docs.example.com): " APP_HOSTNAME
  [[ -n "$APP_HOSTNAME" ]] || die "a hostname is required"
  env_set APP_HOSTNAME "$APP_HOSTNAME"
fi

read -r -p "First admin's email: " ADMIN_EMAIL_RAW
[[ -n "$ADMIN_EMAIL_RAW" ]] || die "an email is required"
# Matches normaliseEmail() in src/features/auth/members.ts (trim + lowercase) and the
# members_email_normalised check constraint (migration 0019) — an unnormalised insert would violate
# that constraint, or worse, silently never match a real sign-in.
ADMIN_EMAIL="$(EMAIL_TO_NORMALISE="$ADMIN_EMAIL_RAW" node -e 'process.stdout.write(process.env.EMAIL_TO_NORMALISE.trim().toLowerCase())')"
[[ -n "$ADMIN_EMAIL" ]] || die "an email is required"

read -r -p "First admin's name: " ADMIN_NAME
[[ -n "$ADMIN_NAME" ]] || die "a name is required"

# -s: never echoed to the terminal, never lands in shell history.
read -r -s -p "First admin's password: " ADMIN_PASSWORD
echo
read -r -s -p "Confirm password: " ADMIN_PASSWORD_CONFIRM
echo
[[ "$ADMIN_PASSWORD" == "$ADMIN_PASSWORD_CONFIRM" ]] || die "passwords did not match"
[[ ${#ADMIN_PASSWORD} -ge 8 ]] || die "password must be at least 8 characters"
unset ADMIN_PASSWORD_CONFIRM

# ---------------------------------------------------------------------------
# Step 3: bring the stack up, wait for postgres — no fixed sleep
# ---------------------------------------------------------------------------
log "Step 3: starting the stack (this builds the app image on first run — can take a few minutes)"
"${COMPOSE[@]}" up -d --build

log "Waiting for postgres to accept connections"
pg_ready_timeout_s=90
pg_ready_elapsed_s=0
until "${COMPOSE[@]}" exec -T db pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1; do
  if (( pg_ready_elapsed_s >= pg_ready_timeout_s )); then
    die "postgres did not become ready within ${pg_ready_timeout_s}s — check '${COMPOSE[*]} logs db'"
  fi
  sleep 2
  pg_ready_elapsed_s=$(( pg_ready_elapsed_s + 2 ))
done
log "postgres is ready"

# pg_isready is NOT enough on its own. Migration 0012 inserts into storage.buckets and 0017
# references auth.users, but neither of those tables is created by anything in this repo: the
# `storage` service creates its schema from its own startup migrations, and `auth` (GoTrue) creates
# `auth.users` from its. Both take several seconds longer than postgres does to accept connections,
# and if either service is misconfigured they never arrive at all. Running migrations against a
# ready-but-schemaless database is how a run dies half-applied at 0012 with
#   ERROR: relation "storage.buckets" does not exist
log "Waiting for the auth and storage services to create their schemas"
schemas_timeout_s=180
schemas_elapsed_s=0
auth_users_present=""
storage_buckets_present=""
while :; do
  # One round trip for both, so the two answers describe the same instant. Two boolean COLUMNS,
  # printed by -tA as `t|f` — deliberately not `bool || ' ' || bool`, because concatenating a boolean
  # casts it to text as "true"/"false", not the t/f psql displays, and the comparison below then
  # never matches and the wait always times out. (Asked and answered: it did exactly that.)
  regclass_pair="$(
    "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -tAc \
      "select to_regclass('auth.users') is not null, to_regclass('storage.buckets') is not null" \
      2>/dev/null | tr -d '[:space:]'
  )"
  auth_users_present="${regclass_pair%%|*}"
  storage_buckets_present="${regclass_pair##*|}"
  [[ "$auth_users_present" == "t" && "$storage_buckets_present" == "t" ]] && break

  if (( schemas_elapsed_s >= schemas_timeout_s )); then
    missing=""
    [[ "$auth_users_present" == "t" ]] || missing="auth.users (created by the 'auth' service — read '${COMPOSE[*]} logs auth')"
    if [[ "$storage_buckets_present" != "t" ]]; then
      [[ -n "$missing" ]] && missing="$missing and "
      missing="${missing}storage.buckets (created by the 'storage' service — read '${COMPOSE[*]} logs storage')"
    fi
    printf 'error: still missing after %ss: %s\n' "$schemas_timeout_s" "$missing" >&2
    printf 'error: migrations were NOT applied. A service that cannot log in to the database will\n' >&2
    printf 'error: crashloop silently — check %s ps for anything Restarting.\n' "${COMPOSE[*]}" >&2
    exit 1
  fi
  sleep 3
  schemas_elapsed_s=$(( schemas_elapsed_s + 3 ))
done
log "auth.users and storage.buckets both exist"

# Now — and only now — give `postgres` rights on the storage tables, because until this moment they
# did not exist to grant on.
#
# The image WANTS to do this itself: /docker-entrypoint-initdb.d/migrations/20250623125453_tmp_grant_
# storage_tables_to_postgres_with_grant_option.sql is exactly this grant. But it is wrapped in
# `if exists (... relname = 'buckets')`, and at database-init time storage.buckets does not exist —
# this image's init-scripts create the storage SCHEMA but no longer its tables; the storage service
# creates those at runtime, owned by supabase_storage_admin. So the image's grant is a silent no-op
# and `postgres` ends up with nothing on storage.buckets, which makes migrations 0012 and 0021 die
# with `ERROR: permission denied for table buckets`.
#
# Run as supabase_admin (the superuser; postgres is deliberately demoted and cannot grant privileges
# it does not hold) over the container's local socket. GRANT is idempotent, so re-runs are free.
"${COMPOSE[@]}" exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q -c \
  "grant all on storage.buckets to postgres with grant option;
   grant all on storage.objects to postgres with grant option;"

# ---------------------------------------------------------------------------
# Step 4: migrations, in filename order
#
# Tracked in a ledger table keyed by filename, NOT by "does some table exist yet". A single
# does-public.members-exist boolean cannot describe a run that died partway: the failure above left
# 14 tables created and no members table, so a re-run would have restarted at 0001 and died
# instantly on "relation already exists", leaving no way forward but `down -v`. Per-file rows make
# a half-applied run resumable, which is what makes the "safe to re-run" promise in this script's
# header true.
# ---------------------------------------------------------------------------
log "Step 4: migrations"

# Portable read loop rather than `mapfile`, which is bash 4+ — macOS ships bash 3.2, so an operator
# running this from a Mac would get "mapfile: command not found" and no migrations at all. Same
# reason deploy/backup.sh avoids it. Migration filenames are 0001_name.sql, never containing
# newlines, so a plain line-at-a-time read is safe.
migrations=()
while IFS= read -r migration_path; do
  migrations+=("$migration_path")
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' | sort)
[[ ${#migrations[@]} -gt 0 ]] || die "no migrations found under $MIGRATIONS_DIR"

# Its own schema, not `public`. PostgREST serves `public` (PGRST_DB_SCHEMAS), and
# src/lib/supabase/grants.test.ts enumerates every table in `public` to police the anon surface —
# an installer bookkeeping table has no business in either. `installer` is not in PGRST_DB_SCHEMAS,
# so this is unreachable through /rest/v1 by construction.
"${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -c \
  "create schema if not exists installer;
   create table if not exists installer.schema_migrations (
     filename text primary key,
     applied_at timestamptz not null default now()
   );"

applied_count="$(
  "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAc \
    "select count(*) from installer.schema_migrations" | tr -d '[:space:]'
)"

if [[ "$applied_count" == "${#migrations[@]}" ]]; then
  # Fast path for the overwhelmingly common re-run against a complete install: one query, and none
  # of the 31 files is opened or shipped into the container.
  log "all ${#migrations[@]} migrations already recorded as applied — skipping"
else
  applied_list="$(
    "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -tAc \
      "select filename from installer.schema_migrations" | tr -d '\r'
  )"

  for migration in "${migrations[@]}"; do
    migration_name="$(basename "$migration")"
    if printf '%s\n' "$applied_list" | command grep -qxF "$migration_name"; then
      log "skipping $migration_name (already applied)"
      continue
    fi
    log "applying $migration_name"
    # The ledger insert is appended to the SAME psql invocation, after the migration body, and the
    # whole thing runs as one transaction (-1). ON_ERROR_STOP means a failing migration never
    # reaches the insert, and -1 means it leaves nothing behind either — so the file is retried
    # from scratch on the next run rather than half-recorded.
    {
      cat "$migration"
      printf "\ninsert into installer.schema_migrations (filename) values (%s);\n" \
        "$(printf "'%s'" "${migration_name//\'/\'\'}")"
    } | "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1
  done
fi

# ---------------------------------------------------------------------------
# Step 5: the first admin — members row + GoTrue auth user
# ---------------------------------------------------------------------------
log "Step 5: creating the first admin"

SERVICE_ROLE_KEY="$(env_get SERVICE_ROLE_KEY)"
[[ -n "$SERVICE_ROLE_KEY" ]] || die "SERVICE_ROLE_KEY missing from deploy/.env"

# SQL on STDIN, not in -c. psql's -c takes "a command string that is completely parsable by the
# server", which means it does NOT expand :'var' — a -c query containing one dies with
#   ERROR: syntax error at or near ":"
# Every query below that interpolates a -v variable is therefore fed on stdin, which does expand it.
# :'...' still quotes the value as a literal, so the email is never pasted into SQL text raw.
member_exists="$(
  "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v email="$ADMIN_EMAIL" -tA <<'SQL'
select count(*) from members where email = :'email';
SQL
)"
member_exists="$(printf '%s' "$member_exists" | tr -d '[:space:]')"

if [[ "$member_exists" != "0" ]]; then
  log "a member row for $ADMIN_EMAIL already exists — skipping admin creation"
else
  # GoTrue's admin API is not published outside the compose network (no ports: entry, spec §5), so
  # this calls it from inside the already-running `app` container, which sits on the same internal
  # network and ships Node 22 with a global fetch. Secrets travel as `docker compose exec -e`
  # environment variables rather than argv, so they never show up in `ps` output.
  create_user_response="$(
    "${COMPOSE[@]}" exec -T \
      -e SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
      -e ADMIN_EMAIL="$ADMIN_EMAIL" \
      -e ADMIN_PASSWORD="$ADMIN_PASSWORD" \
      -e ADMIN_NAME="$ADMIN_NAME" \
      app node -e '
        (async () => {
          const { SERVICE_ROLE_KEY, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_NAME } = process.env;
          const res = await fetch("http://auth:9999/admin/users", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + SERVICE_ROLE_KEY,
              "apikey": SERVICE_ROLE_KEY,
            },
            body: JSON.stringify({
              email: ADMIN_EMAIL,
              password: ADMIN_PASSWORD,
              email_confirm: true,
              user_metadata: { name: ADMIN_NAME },
            }),
          });
          const body = await res.text();
          if (!res.ok) { process.stderr.write(body); process.exit(1); }
          process.stdout.write(body);
        })();
      '
  )" || die "creating the auth user via GoTrue's admin API failed (see output above)"

  new_auth_user_id="$(
    RESPONSE_FOR_PARSE="$create_user_response" node -e '
      const data = JSON.parse(process.env.RESPONSE_FOR_PARSE);
      if (!data.id) { console.error("no id in GoTrue response"); process.exit(1); }
      process.stdout.write(data.id);
    '
  )"

  "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -v email="$ADMIN_EMAIL" -v name="$ADMIN_NAME" -v authid="$new_auth_user_id" <<'SQL'
insert into members (email, name, role, auth_user_id)
values (:'email', :'name', 'admin', :'authid'::uuid)
on conflict (email) do nothing;
SQL

  log "created admin member and auth user for $ADMIN_EMAIL"
fi

unset ADMIN_PASSWORD

# ---------------------------------------------------------------------------
# Step 6: THE BREAK-GLASS STEP — approve a bootstrap device
#
# Trusted devices gate every route, approving one needs an emailed code, and /users (where an admin
# could approve one by hand) sits behind the same gate. On a fresh server SMTP is not proven yet, so
# without this step nobody — not even the admin just created above — can sign in at all.
# ---------------------------------------------------------------------------
log "Step 6: approving a bootstrap device (break-glass)"

if [[ -f "$DEVICE_TOKEN_FILE" ]]; then
  log "deploy/first-device-token.txt already exists — leaving the existing bootstrap device as-is"
else
  DEVICE_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
  # Must match hashDeviceToken() in src/features/devices/deviceRules.ts exactly: plain SHA-256 of
  # the raw token, lowercase hex, no salt — a different hash here and the token is useless.
  TOKEN_HASH="$(DEVICE_TOKEN_FOR_HASH="$DEVICE_TOKEN" node -e \
    'process.stdout.write(require("crypto").createHash("sha256").update(process.env.DEVICE_TOKEN_FOR_HASH).digest("hex"))')"

  member_id="$(
    "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -v email="$ADMIN_EMAIL" -tA <<'SQL'
select id from members where email = :'email';
SQL
  )"
  member_id="$(printf '%s' "$member_id" | tr -d '[:space:]')"
  [[ -n "$member_id" ]] || die "could not find the admin member row to attach a bootstrap device to"

  "${COMPOSE[@]}" exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -v mid="$member_id" -v hash="$TOKEN_HASH" <<'SQL'
insert into trusted_devices (member_id, token_hash, label, approved_at)
values (:'mid'::uuid, :'hash', 'install.sh bootstrap device', now())
on conflict (token_hash) do nothing;
SQL

  (
    umask 077
    cat > "$DEVICE_TOKEN_FILE" <<EOF
This is a ONE-TIME bootstrap device token, minted by deploy/install.sh.

It deliberately bypasses the normal emailed-code device-approval path. On a fresh install, SMTP is
not proven yet, and every route in the app — including /users, where an admin could otherwise
approve a device by hand — sits behind the trusted-device gate. Without this token, nobody, not even
the admin account just created, can sign in.

To use it:
  1. Go to https://$APP_HOSTNAME and sign in with the admin email and password you just set.
  2. Before or right after signing in, set a cookie named "ndp_device" on that origin with exactly
     this value (browser devtools > Application/Storage > Cookies, or an extension):

$DEVICE_TOKEN

  3. Once you are in, go to /profile: revoke THIS bootstrap device and approve a normal device
     through the emailed-code flow. Then delete this file.

This file is mode 600 and is never committed to git. Treat its contents like a password — whoever
holds it can sign in as this admin without ever proving control of the email address.
EOF
  )
  chmod 600 "$DEVICE_TOKEN_FILE"

  echo
  echo "WARNING: a break-glass device token was written to deploy/first-device-token.txt (mode 600)."
  echo "It bypasses the emailed-code device-approval path by design and exists only for this first"
  echo "sign-in. Revoke it from /profile once a normal device is approved, then delete the file."
fi

# ---------------------------------------------------------------------------
# Step 7: summary — no secrets
# ---------------------------------------------------------------------------
log "Step 7: summary"
cat <<EOF

network-doc-platform is up.

  URL:          https://$APP_HOSTNAME
  Admin email:  $ADMIN_EMAIL

Still to configure, all optional (edit deploy/.env, then 'docker compose -f deploy/docker-compose.yml up -d'):
  - SMTP    — member invites, password recovery, and emailed device-approval codes all need it.
  - OAuth   — Google / Microsoft sign-in buttons say "not configured" until SUPABASE_AUTH_* is set.
  - Twilio  — phone-number verification stays off until TWILIO_* is set.

See deploy/first-device-token.txt for how to complete your first sign-in. No secrets were printed
by this script.
EOF
