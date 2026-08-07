#!/usr/bin/env bash
# deploy/install.sh — take a bare server to a working login page.
#
# See docs/superpowers/specs/2026-08-05-self-hosted-design.md and .superpowers/sdd/task-2-brief.md
# for the design this implements. Safe to re-run: it does not regenerate secrets once deploy/.env
# exists, every write below either converges on the same end state (`on conflict`) or is guarded by a
# check against the DATABASE — never against a file on disk, which the operator is told to delete.
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
SUPABASE_AUTH_GOOGLE_ENABLED=false
SUPABASE_AUTH_GOOGLE_CLIENT_ID=
SUPABASE_AUTH_GOOGLE_SECRET=
SUPABASE_AUTH_AZURE_ENABLED=false
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

# Read ONCE, here, and use $POSTGRES_DB for every psql/pg_isready invocation below. deploy/.env.example
# invites the operator to set POSTGRES_DB, and docker-compose.yml, backup.sh and restore.sh all honour
# it — this script used to hardcode `-d postgres` in eight places, so setting it to anything else made
# the schema-readiness wait poll a database that does not exist, time out after 180s, and blame the
# auth service. The `:-postgres` mirrors the `${POSTGRES_DB:-postgres}` default in docker-compose.yml:
# an empty value in the env file means "the image's default", not "connect to the empty-named database".
POSTGRES_DB="$(env_get POSTGRES_DB)"
POSTGRES_DB="${POSTGRES_DB:-postgres}"

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

read -r -p "Organisation name [default: your email domain]: " ORG_NAME
if [[ -z "$ORG_NAME" ]]; then
  # `${ADMIN_EMAIL#*@}` strips up to the first '@' — and when the string contains no '@' at all it
  # returns the WHOLE string unchanged rather than an empty one. So the `[[ -n "$ORG_NAME" ]]` guard
  # that used to be the only check here could not fail under any input: an address typed as `bob`
  # would have quietly produced an organisation named `bob`. Check the thing that actually decides
  # the answer — whether there is a domain to take.
  [[ "$ADMIN_EMAIL" == *@* ]] \
    || die "'$ADMIN_EMAIL' has no '@', so there is no domain to name an organisation after — re-run and type an organisation name"
  ORG_NAME="${ADMIN_EMAIL#*@}"
  # Now reachable, and for a real input: `bob@` passes the test above and leaves this empty.
  [[ -n "$ORG_NAME" ]] || die "'$ADMIN_EMAIL' has nothing after the '@' — re-run and type an organisation name"
fi

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
until "${COMPOSE[@]}" exec -T db pg_isready -U postgres -d "$POSTGRES_DB" -h 127.0.0.1 >/dev/null 2>&1; do
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
    "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -tAc \
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
"${COMPOSE[@]}" exec -T db psql -U supabase_admin -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -c \
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
"${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -c \
  "create schema if not exists installer;
   create table if not exists installer.schema_migrations (
     filename text primary key,
     applied_at timestamptz not null default now()
   );"

# The applied SET, never the applied COUNT. A count comparison passes whenever the two numbers agree
# for any reason at all: delete one migration file and add another and the totals still match, so the
# new file is recorded as "already applied" and never runs — a schema change that silently does not
# happen, which is the worst failure this step has. Comparing the sorted filenames answers the actual
# question ("is every file on disk in the ledger?") and costs the same one query.
applied_list="$(
  "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -tAc \
    "select filename from installer.schema_migrations order by filename" | tr -d '\r'
)"

expected_names="$(
  for migration in "${migrations[@]}"; do basename "$migration"; done | sort
)"
# `sort` both sides rather than trusting psql's collation to match the shell's: psql orders by the
# database's collation, sort by the locale's, and 0001_a.sql vs 0001-a.sql order differently under
# some of them. Filenames here are ASCII, so a plain sort makes the two comparable with certainty.
applied_sorted="$(printf '%s\n' "$applied_list" | command grep -v '^$' | sort || true)"

if [[ "$applied_sorted" == "$expected_names" ]]; then
  # Fast path for the overwhelmingly common re-run against a complete install: one query, and none
  # of the migration files is opened or shipped into the container.
  log "all ${#migrations[@]} migrations already recorded as applied — skipping"
else
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
    } | "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -1
  done
fi

# ---------------------------------------------------------------------------
# Step 5: the first admin — a GoTrue auth user AND a members row, resolved INDEPENDENTLY
#
# These are two records in two different places and a run can die between them, so neither may be
# used as a proxy for the other. The previous version keyed the whole step off `count(*) from
# members`, which broke in both directions:
#
#   * GoTrue user created, members insert never reached -> a re-run saw no member, POSTed to
#     /admin/users again, GoTrue answered 422 for the duplicate email, and the script died with no
#     way forward short of hand-deleting the user.
#   * members row present, GoTrue user absent (deleted by hand, or a restore of a public-only dump)
#     -> the whole step was skipped and the installer reported success on an account that can never
#     sign in, because there is nothing to authenticate against.
#
# So: look the user up in GoTrue by email and create it only if it is genuinely absent, then upsert
# the members row against whichever id we now hold. Both halves converge on the correct end state no
# matter which one already existed.
# ---------------------------------------------------------------------------
log "Step 5: the first admin"

SERVICE_ROLE_KEY="$(env_get SERVICE_ROLE_KEY)"
[[ -n "$SERVICE_ROLE_KEY" ]] || die "SERVICE_ROLE_KEY missing from deploy/.env"

# GoTrue's admin API is not published outside the compose network (no ports: entry, spec §5), so this
# calls it from inside the already-running `app` container, which sits on the same internal network
# and ships Node 22 with a global fetch.
#
# The service-role key, the admin's email and the admin's PASSWORD travel on STDIN as one JSON blob.
# They used to be passed as `docker compose exec -e VAR=value`, with a comment claiming they were
# therefore invisible to `ps` — that was false. `-e` arguments are argv of the HOST `docker compose`
# process, so any local user running `ps auxww` during an install saw the admin password and the
# service-role key in full. Stdin is a pipe: it appears in no process listing at all. (sign_jwt above
# always did this correctly, with an env-var prefix; this is the same idea for a value that has to
# cross into a container, where an env-var prefix cannot reach.)
#
# The blob itself is built by a local node process reading env vars — not from a shell here-string
# with the values interpolated — so nothing has to be escaped by hand and no value reaches an argv.
admin_payload="$(
  KEY_FOR_PAYLOAD="$SERVICE_ROLE_KEY" \
  EMAIL_FOR_PAYLOAD="$ADMIN_EMAIL" \
  PASSWORD_FOR_PAYLOAD="$ADMIN_PASSWORD" \
  NAME_FOR_PAYLOAD="$ADMIN_NAME" \
  node -e 'process.stdout.write(JSON.stringify({
    key: process.env.KEY_FOR_PAYLOAD,
    email: process.env.EMAIL_FOR_PAYLOAD,
    password: process.env.PASSWORD_FOR_PAYLOAD,
    name: process.env.NAME_FOR_PAYLOAD,
  }))'
)"

# shellcheck disable=SC2016 # intentional: the JS below is read by node in the container, not the shell.
gotrue_result="$(
  printf '%s' "$admin_payload" | "${COMPOSE[@]}" exec -T app node -e '
    (async () => {
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const { key, email, password, name } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
        "apikey": key,
      };

      // LOOK UP FIRST. GoTrue has no "get user by email" endpoint, only a paged list with an
      // optional `filter`. The filter is applied server-side when supported and ignored when it is
      // not, so the pages are walked and matched here as well rather than trusting it — an ignored
      // filter must not be read as "no such user", which is exactly the mistake that turns a
      // half-finished run into an unresumable one.
      let existing = null;
      for (let page = 1; page <= 50 && !existing; page++) {
        const url = "http://auth:9999/admin/users?page=" + page + "&per_page=200&filter=" +
          encodeURIComponent(email);
        const res = await fetch(url, { headers });
        if (!res.ok) {
          process.stderr.write("GoTrue list users failed: " + res.status + " " + (await res.text()));
          process.exit(1);
        }
        const data = await res.json();
        const users = Array.isArray(data.users) ? data.users : [];
        if (users.length === 0) break;
        existing = users.find((u) => String(u.email || "").toLowerCase() === email) || null;
      }
      if (existing) {
        process.stdout.write(JSON.stringify({ id: existing.id, created: false }));
        return;
      }

      const res = await fetch("http://auth:9999/admin/users", {
        method: "POST",
        headers,
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { name },
        }),
      });
      const body = await res.text();
      if (!res.ok) { process.stderr.write(body); process.exit(1); }
      const data = JSON.parse(body);
      if (!data.id) { process.stderr.write("no id in GoTrue response: " + body); process.exit(1); }
      process.stdout.write(JSON.stringify({ id: data.id, created: true }));
    })().catch((err) => { process.stderr.write(String((err && err.stack) || err)); process.exit(1); });
  '
)" || die "resolving the auth user via GoTrue's admin API failed (see output above)"

unset admin_payload

auth_user_id="$(
  RESPONSE_FOR_PARSE="$gotrue_result" node -e '
    const data = JSON.parse(process.env.RESPONSE_FOR_PARSE);
    if (!data.id) { console.error("no id in GoTrue response"); process.exit(1); }
    process.stdout.write(data.id);
  '
)"
auth_user_created="$(
  RESPONSE_FOR_PARSE="$gotrue_result" node -e '
    process.stdout.write(JSON.parse(process.env.RESPONSE_FOR_PARSE).created ? "yes" : "no");
  '
)"

if [[ "$auth_user_created" == "yes" ]]; then
  log "created the GoTrue auth user for $ADMIN_EMAIL"
else
  log "a GoTrue auth user for $ADMIN_EMAIL already exists — reusing it, and leaving its password unchanged"
fi

# SQL on STDIN, not in -c. psql's -c takes "a command string that is completely parsable by the
# server", which means it does NOT expand :'var' — a -c query containing one dies with
#   ERROR: syntax error at or near ":"
# Every query below that interpolates a -v variable is therefore fed on stdin, which does expand it.
# :'...' still quotes the value as a literal, so the email is never pasted into SQL text raw.
#
# The organisation: look it up by name first and insert only when absent — the same shape as the
# member and bootstrap-device checks, which decide against the DATABASE rather than a file.
# `organisations` has no unique constraint on `name` (verified: only `organisations_pkey`), and two
# different companies may legitimately share a name in a multi-tenant product, so one is
# deliberately NOT added here. That means an `on conflict do nothing` on the insert can never fire —
# a data-modifying CTE always executes regardless of a downstream conflict that never happens — so
# the previous version minted a brand-new organisation on every re-run, and its `coalesce` fallback
# (`order by created_at limit 1`) was dead code that, had it ever run, would have picked migration
# 0034's hardcoded QTSI row over this operator's. Looking the name up first makes re-running the
# installer converge on the same organisation instead.
org_id="$(
  "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -v orgname="$ORG_NAME" -tA <<'SQL'
select id from organisations where name = :'orgname' order by created_at limit 1;
SQL
)"
org_id="$(printf '%s' "$org_id" | tr -d '[:space:]')"

if [[ -n "$org_id" ]]; then
  log "using existing organisation '$ORG_NAME' ($org_id)"
else
  # -q here is load-bearing, not cosmetic: psql prints the command tag for a non-SELECT (e.g.
  # `INSERT 0 1`) to stdout even under `-tA` — `-t`/`-A` only strip column headers and alignment,
  # not the tag. Without `-q` that tag gets welded onto the id below by `tr -d '[:space:]'`,
  # producing e.g. "f1be42c7-...-52f28c872445INSERT01", which is not a valid uuid and fails the
  # members insert further down. `-q` suppresses it so only the returned id reaches org_id.
  org_id="$(
    "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
      -v orgname="$ORG_NAME" -qtA <<'SQL'
insert into organisations (name) values (:'orgname') returning id;
SQL
  )"
  org_id="$(printf '%s' "$org_id" | tr -d '[:space:]')"
  [[ -n "$org_id" ]] || die "inserting organisation '$ORG_NAME' returned no id — refusing to continue"
  log "created organisation '$ORG_NAME' ($org_id)"
fi

# The upsert repairs the link rather than skipping: `do nothing` was what let a members row survive
# pointing at an auth user that no longer exists. name, role and org_id are deliberately NOT
# overwritten on conflict — an operator who renamed themselves or an admin who was demoted on
# purpose should stay that way; the auth_user_id is the only field this step owns. `returning`
# reports which branch ran.
member_state="$(
  "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -v email="$ADMIN_EMAIL" -v name="$ADMIN_NAME" -v authid="$auth_user_id" -v orgid="$org_id" -qtA <<'SQL'
insert into members (email, name, role, auth_user_id, org_id)
values (:'email', :'name', 'admin', :'authid'::uuid, :'orgid'::uuid)
on conflict (email) do update
   set auth_user_id = excluded.auth_user_id
returning case when xmax = 0 then 'inserted' else 'relinked' end;
SQL
)"
member_state="$(printf '%s' "$member_state" | tr -d '[:space:]')"
[[ -n "$member_state" ]] || die "the members upsert for $ADMIN_EMAIL returned nothing — refusing to continue"
log "members row for $ADMIN_EMAIL: $member_state, linked to auth user $auth_user_id"

# Belt and braces: assert the end state both halves were supposed to produce, so a future change that
# breaks the link fails here rather than at the operator's first sign-in attempt.
linked="$(
  "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
    -v email="$ADMIN_EMAIL" -tA <<'SQL'
select count(*) from members m
  join auth.users u on u.id = m.auth_user_id
 where m.email = :'email';
SQL
)"
linked="$(printf '%s' "$linked" | tr -d '[:space:]')"
[[ "$linked" == "1" ]] || die "the admin's members row is not linked to a live auth.users row (found $linked) — sign-in would fail"

unset ADMIN_PASSWORD

# ---------------------------------------------------------------------------
# Step 6: THE BREAK-GLASS STEP — approve a bootstrap device
#
# Trusted devices gate every route, approving one needs an emailed code, and /users (where an admin
# could approve one by hand) sits behind the same gate. On a fresh server SMTP is not proven yet, so
# without this step nobody — not even the admin just created above — can sign in at all.
#
# THE DECISION IS KEYED OFF THE DATABASE, NOT OFF THE TOKEN FILE. It used to be keyed off
# deploy/first-device-token.txt existing — while that same file, and docs/reference/deployment.md,
# both tell the operator to DELETE it once a normal device is approved. Following that instruction
# and then re-running the installer (which the header advertises as safe) silently minted a SECOND
# permanent approved device and a fresh break-glass token: the emailed-code factor restored as a
# standing bypass, with nothing on screen saying so.
#
# An approved trusted_devices row is the thing that actually decides whether anyone can get in, so
# that is what is checked. The bootstrap device exists for exactly one situation — the admin has no
# approved device at all — and it is minted only in that situation.
# ---------------------------------------------------------------------------
log "Step 6: a bootstrap device (break-glass)"

member_id="$(
  "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v email="$ADMIN_EMAIL" -tA <<'SQL'
select id from members where email = :'email';
SQL
)"
member_id="$(printf '%s' "$member_id" | tr -d '[:space:]')"
[[ -n "$member_id" ]] || die "could not find the admin member row to attach a bootstrap device to"

approved_devices="$(
  "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v mid="$member_id" -tA <<'SQL'
select count(*) from trusted_devices
 where member_id = :'mid'::uuid and approved_at is not null;
SQL
)"
approved_devices="$(printf '%s' "$approved_devices" | tr -d '[:space:]')"
[[ "$approved_devices" =~ ^[0-9]+$ ]] || die "could not count the admin's approved devices (got: $approved_devices)"

if (( approved_devices > 0 )); then
  log "the admin already has $approved_devices approved trusted device(s) — NOT minting a break-glass device"
  if [[ -f "$DEVICE_TOKEN_FILE" ]]; then
    echo "Note: deploy/first-device-token.txt is still on disk. Once you have a normal approved device,"
    echo "revoke the bootstrap device from /profile and delete that file."
  fi
else
  DEVICE_TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')"
  # Must match hashDeviceToken() in src/features/devices/deviceRules.ts exactly: plain SHA-256 of
  # the raw token, lowercase hex, no salt — a different hash here and the token is useless.
  TOKEN_HASH="$(DEVICE_TOKEN_FOR_HASH="$DEVICE_TOKEN" node -e \
    'process.stdout.write(require("crypto").createHash("sha256").update(process.env.DEVICE_TOKEN_FOR_HASH).digest("hex"))')"

  "${COMPOSE[@]}" exec -T db psql -U postgres -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 \
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

EOF
if (( approved_devices > 0 )); then
  echo "This admin already had an approved device, so no break-glass token was minted. Sign in as usual."
else
  echo "See deploy/first-device-token.txt for how to complete your first sign-in."
fi
echo "No secrets were printed by this script."
