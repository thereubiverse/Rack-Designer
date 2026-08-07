#!/usr/bin/env bash
# deploy/test-smtp.sh — send one real email through the SMTP_* settings in deploy/.env and report
# clearly whether it actually worked.
#
# Two independent paths read those same five variables: GoTrue (GOTRUE_SMTP_* in
# deploy/docker-compose.yml) sends invites and password recovery, and the app (src/lib/email.ts)
# sends device-approval codes over nodemailer. Neither fails loudly on a bad credential — GoTrue
# logs and moves on, and sendEmail() is deliberately written to never throw, and in production it
# logs only "email is not configured", never the body, so a misconfiguration cannot leak a one-time
# code into a log. Correct, but it means a bad password looks identical to "invites just don't
# arrive" from the outside. This script is the way to find out BEFORE relying on either path.
#
# Distinguishes three failure modes that need different fixes:
#   cannot connect        — wrong host/port, or the port is blocked
#   authentication rejected — wrong username/key
#   sender rejected        — SMTP_FROM's domain is not verified with the provider (with Resend, this
#                            is the most likely cause, and the one that least looks like a cause: the
#                            symptom is just "nothing arrives")
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." &>/dev/null && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [-e|--env-file FILE] <to-address>

Reads SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM out of deploy/.env (or the file
given with --env-file) and sends ONE real test email to <to-address>, then reports whether it was
delivered, could not connect, was rejected on authentication, or was rejected because of the sender
address/domain — the checks below tell you what each one means.

MUST be run from the REPOSITORY ROOT, not from deploy/, e.g.:

    deploy/test-smtp.sh you@example.com

This script has no dependencies of its own; it calls node, and node's require() only finds
nodemailer (already a dependency of this project) when the process's current working directory is
the repository root.

  -e, --env-file FILE   .env file to read SMTP_* from (default: $ENV_FILE)
  -h, --help             show this help
EOF
}

TO_ADDRESS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--env-file)
      [[ $# -ge 2 ]] || die "$1 requires an argument"
      ENV_FILE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    --) shift; break ;;
    -*) printf 'unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
    *)
      [[ -z "$TO_ADDRESS" ]] || die "unexpected extra argument: $1"
      TO_ADDRESS="$1"; shift ;;
  esac
done
# Any arguments left after a literal `--` are still just the recipient slot.
if [[ $# -gt 0 ]]; then
  [[ -z "$TO_ADDRESS" ]] || die "unexpected extra argument: $1"
  TO_ADDRESS="$1"
fi

if [[ -z "$TO_ADDRESS" ]]; then
  usage >&2
  die "a recipient address is required"
fi

[[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"

# read_var NAME — value of the last "NAME=..." line in ENV_FILE, or empty if absent. Mirrors the
# DEPLOY_MODE read in deploy/backup.sh: `|| true` because under `set -o pipefail` a grep that matches
# nothing fails the whole pipeline, and with `set -e` that would abort this script for any SMTP
# variable that simply isn't set yet.
read_var() {
  command grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true
}

SMTP_HOST_VAL="$(read_var SMTP_HOST)"
SMTP_PORT_VAL="$(read_var SMTP_PORT)"
SMTP_USER_VAL="$(read_var SMTP_USER)"
SMTP_PASSWORD_VAL="$(read_var SMTP_PASSWORD)"
SMTP_FROM_VAL="$(read_var SMTP_FROM)"

# Fail before attempting anything, listing every variable missing at once rather than one at a time.
missing=()
[[ -n "$SMTP_HOST_VAL" ]] || missing+=(SMTP_HOST)
[[ -n "$SMTP_PORT_VAL" ]] || missing+=(SMTP_PORT)
[[ -n "$SMTP_USER_VAL" ]] || missing+=(SMTP_USER)
[[ -n "$SMTP_PASSWORD_VAL" ]] || missing+=(SMTP_PASSWORD)
[[ -n "$SMTP_FROM_VAL" ]] || missing+=(SMTP_FROM)
if (( ${#missing[@]} > 0 )); then
  die "missing from $ENV_FILE: ${missing[*]} — fill these in (see docs/reference/deployment.md) before testing"
fi

command -v node >/dev/null 2>&1 || die "node is required (deploy/install.sh requires node >= 18; this script needs it too)"

# Confirm nodemailer resolves BEFORE the send attempt, so a wrong working directory produces this
# one clear line instead of node's own "Cannot find module" a few lines further down.
if ! (cd "$REPO_ROOT" && node -e "require.resolve('nodemailer')" >/dev/null 2>&1); then
  die "cannot find nodemailer under $REPO_ROOT/node_modules — run 'npm install' there, then run this script from the repository root (see --help)"
fi

log "Sending a test email via $SMTP_HOST_VAL:$SMTP_PORT_VAL to $TO_ADDRESS (from $SMTP_FROM_VAL)"

# The password is NEVER put on the command line — ps shows every process's argv to every user on the
# box — and it is never echoed or logged by this script. It only ever travels to node through the
# environment of this one subprocess, read back out of process.env inside the script below. This is
# the same convention deploy/install.sh uses to hand JWT_SECRET to its own `node -e` invocations.
set +e
NODE_OUTPUT="$(
  cd "$REPO_ROOT" \
  && SMTP_HOST_FOR_TEST="$SMTP_HOST_VAL" \
     SMTP_PORT_FOR_TEST="$SMTP_PORT_VAL" \
     SMTP_USER_FOR_TEST="$SMTP_USER_VAL" \
     SMTP_PASSWORD_FOR_TEST="$SMTP_PASSWORD_VAL" \
     SMTP_FROM_FOR_TEST="$SMTP_FROM_VAL" \
     TO_ADDRESS_FOR_TEST="$TO_ADDRESS" \
     node -e '
      const nodemailer = require("nodemailer");

      const host = process.env.SMTP_HOST_FOR_TEST;
      const port = Number(process.env.SMTP_PORT_FOR_TEST);
      const user = process.env.SMTP_USER_FOR_TEST;
      const pass = process.env.SMTP_PASSWORD_FOR_TEST;
      const from = process.env.SMTP_FROM_FOR_TEST;
      const to = process.env.TO_ADDRESS_FOR_TEST;

      // Mirrors src/lib/email.ts exactly: port 465 is implicit TLS, everything else (587 included)
      // starts in plaintext and upgrades with STARTTLS. Same rule, same code, both places.
      const transporter = nodemailer.createTransport({
        host, port, secure: port === 465, auth: { user, pass },
      });

      // Everything this script needs to decide is printed on STDOUT in a fixed, single-purpose
      // format so the shell side never has to parse prose. STDERR is not used, so nothing here
      // depends on the relative ordering of the two streams.
      transporter.sendMail({
        from, to,
        subject: "deploy/test-smtp.sh test email",
        text: "This is a test message sent by deploy/test-smtp.sh to confirm the SMTP settings in deploy/.env actually work.",
      }).then((info) => {
        process.stdout.write("RESULT=OK\n");
        process.stdout.write("MESSAGE_ID=" + (info.messageId || "(none)") + "\n");
        process.exit(0);
      }).catch((err) => {
        // Classified from what nodemailer reports, not by matching text out of the provider'"'"'s
        // reply (that text is provider-specific and not something to depend on).
        //
        // No SMTP response code at all means the failure happened before any dialogue with the
        // server got that far — DNS failure, refused/reset connection, or a timeout. Once a
        // response code exists, the server actually said something: 530/534/535 is SMTP'"'"'s own
        // vocabulary for "the credentials are unacceptable", and 501/550/551/553/554 is its
        // vocabulary for "the mail itself (here: the sender) is unacceptable" — see RFC 5321 §4.2.
        let kind;
        const rc = typeof err.responseCode === "number" ? err.responseCode : undefined;
        if (rc === undefined) {
          kind = (err.code === "EAUTH") ? "AUTH" : "CONNECT";
        } else if (rc === 530 || rc === 534 || rc === 535) {
          kind = "AUTH";
        } else if (rc === 501 || rc === 550 || rc === 551 || rc === 553 || rc === 554) {
          kind = "SENDER";
        } else {
          kind = "UNKNOWN";
        }
        const detail = String(err && err.message ? err.message : err).replace(/\s+/g, " ").trim();
        process.stdout.write("RESULT=FAIL\n");
        process.stdout.write("KIND=" + kind + "\n");
        process.stdout.write("DETAIL=" + detail + "\n");
        process.exit(1);
      });
    '
)"
NODE_STATUS=$?
set -e

RESULT_LINE="$(printf '%s\n' "$NODE_OUTPUT" | command grep -E '^RESULT=' | tail -n1)"

if [[ "$RESULT_LINE" == "RESULT=OK" ]]; then
  MESSAGE_ID="$(printf '%s\n' "$NODE_OUTPUT" | command grep -E '^MESSAGE_ID=' | tail -n1 | cut -d= -f2-)"
  log "Sent. Message-Id: $MESSAGE_ID"
  printf 'Check the recipient inbox (or, against Mailpit, http://127.0.0.1:54324) to confirm it actually arrived — a successful SMTP handshake is not the same as delivery.\n'
  exit 0
fi

if [[ "$RESULT_LINE" != "RESULT=FAIL" ]]; then
  die "could not understand the send attempt's output (exit $NODE_STATUS):
$NODE_OUTPUT"
fi

KIND="$(printf '%s\n' "$NODE_OUTPUT" | command grep -E '^KIND=' | tail -n1 | cut -d= -f2-)"
DETAIL="$(printf '%s\n' "$NODE_OUTPUT" | command grep -E '^DETAIL=' | tail -n1 | cut -d= -f2-)"

log "FAILED: $KIND"
printf 'detail: %s\n\n' "$DETAIL"

case "$KIND" in
  CONNECT)
    printf 'Cannot connect. Check that SMTP_HOST and SMTP_PORT (%s:%s) are correct and that the port is not blocked by a firewall or security group.\n' \
      "$SMTP_HOST_VAL" "$SMTP_PORT_VAL"
    ;;
  AUTH)
    printf "Authentication was rejected. Check SMTP_USER and SMTP_PASSWORD — for Resend, the username must be the literal string 'resend' and the password is the API key, not the account password.\n"
    ;;
  SENDER)
    printf 'The sender was rejected. Check that the domain of SMTP_FROM (%s) is verified with your SMTP provider — with Resend this is the most likely cause, and the one that looks the least like a cause: the symptom is just "nothing arrives".\n' \
      "$SMTP_FROM_VAL"
    ;;
  *)
    printf 'Unrecognised failure — see the detail line above.\n'
    ;;
esac

exit 1
