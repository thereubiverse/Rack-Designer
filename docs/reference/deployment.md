# Deployment

The application is self-hosted: one `docker compose` stack on one server you control, and one script
that takes that server from bare to a working, HTTPS, signed-in application. There is no hosting
provider, no separate Supabase account, and nothing to configure through a dashboard.

Everything lives in `deploy/`. `deploy/docker-compose.yml` defines seven services — `db` (Postgres),
`kong`, `auth` (GoTrue), `rest` (PostgREST), `storage`, `app` (the Next server built from the
repository's `Dockerfile`), and `caddy`. `deploy/install.sh` brings them up, applies the migrations,
creates the first admin, and hands you a way to sign in. The design behind it, including why four of
Supabase's usual services are deliberately absent, is
`docs/superpowers/specs/2026-08-05-self-hosted-design.md`.

**Only Caddy publishes ports**, 80 and 443. Port 80 exists for the ACME challenge and redirects to
443; everything else — the database, GoTrue, PostgREST, Storage, the Next server — is reachable only
on the compose network. Postgres in particular has no `ports:` entry at all, and it must never gain
one: publishing it would put the database on the internet with a password as the only control.

Caddy routes `/auth/v1/*`, `/rest/v1/*` and `/storage/v1/*` to Kong and everything else to the app.
Those three API paths genuinely have to face the internet, because the browser fetches signed storage
URLs directly — every avatar and every floor plan is a URL built from this same origin. That is safe
only because migrations `0027` and `0028` reduced what the publishable key can reach to a single
column grant, and `src/lib/supabase/grants.test.ts` is what keeps it true.

## The steps only you can take

I can prepare configuration and prove the stack comes up; I cannot create accounts or enter
credentials on your behalf. These are yours, and the first one has to come first.

**1. A domain, with DNS pointing at the server.** Caddy requests and renews a TLS certificate for
`APP_HOSTNAME` automatically, and it does that by answering a challenge on port 80 at the address the
name resolves to. So the record has to exist and resolve *before* the first `docker compose up`, not
after. If DNS is not ready, certificate issuance fails and the symptom is the site simply not
loading. This is also not merely a niceness: see the first entry under "Things that will bite" — an
internal-CA certificate breaks the app container outright.

**2. The optional integrations**, none of which block the install. Each stays visibly inert until its
credentials exist, by design, so a missing one explains itself rather than failing obscurely. All of
them are plain keys in `deploy/.env`; edit that file and run
`docker compose -f deploy/docker-compose.yml up -d` to pick the change up.

- **SMTP, via Resend.** This is the one worth doing first after the install. Member invites, password
  recovery, and the one-time device-approval codes all go through it. Create a Resend account and
  **verify a domain you own** — sending from an unverified domain is what puts invites in spam. The
  API key it gives you is the SMTP *password*; the username is the literal string `resend`. Fill in
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM`. `src/lib/email.ts` treats
  mail as unconfigured until host, port and from-address are all set, and in production it logs only
  that sending failed — never the body, because that body may be a device-approval code.
- **Google / Microsoft sign-in.** Create the credentials in Google Cloud Console and an Azure app
  registration. `SUPABASE_AUTH_GOOGLE_CLIENT_ID` / `_SECRET` and `SUPABASE_AUTH_AZURE_CLIENT_ID` /
  `_SECRET` are read by the app to decide whether to *offer* each button. Note what the compose file
  actually does with them: it passes them to the `app` container only. The `auth` service is given no
  `GOTRUE_EXTERNAL_*` provider settings, so completing a handshake needs those added to GoTrue as
  well — offering the button and being able to finish the sign-in are two different pieces of
  configuration.
- **Twilio**, for confirming a member's phone number by text: `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
- **Gemini**, for the Device Wizard's vision calls: `GEMINI_API_KEY`, from Google AI Studio.

`deploy/.env.example` lists every variable the stack reads, with empty placeholders and a note on
each. It is the committed reference; `deploy/.env` — the real one — is gitignored and must stay that
way. This repository is public.

## Running the installer

On the server, with Docker (and the Compose v2 plugin) and Node 18 or newer installed:

```bash
./deploy/install.sh
```

It prompts for four things: the hostname this server will be reached at, and the first admin's email,
name and password. The password is read with `read -s`, so it is never echoed and never reaches shell
history.

Everything else it generates. This is the part worth understanding, because it is the step people get
wrong by hand: **self-hosted Supabase has no "API key"**. It has a `JWT_SECRET`, and the anon and
service-role keys are JWTs signed with that secret carrying `role: anon` and `role: service_role`.
The installer mints a random Postgres password and `JWT_SECRET` with Node's built-in crypto, signs
both tokens itself, then decodes each one back and checks the role and expiry before writing anything
— it refuses to write a token that fails its own check. The results land in `deploy/.env` at mode
600, and nothing sensitive is printed to the terminal at any point.

From there it starts the stack, waits for Postgres to accept connections, and then waits again for
`auth.users` and `storage.buckets` to appear — those tables are created by GoTrue's and storage-api's
own startup migrations, not by anything in this repository, and running our migrations against a
ready-but-schemaless database is how a run dies half-applied. Then it applies
`supabase/migrations/*.sql` in filename order, creates the first admin as a `members` row plus a
matching GoTrue auth user, and mints the bootstrap device below.

**It is safe to re-run.** It does not regenerate secrets once `deploy/.env` exists, and migrations are
tracked in a ledger table keyed by filename (`installer.schema_migrations`, in its own schema so it
stays outside PostgREST's reach). A run that died partway resumes from the file it died on rather than
starting over and colliding with itself.

Every guard is against the **database**, never against a file on disk. The admin's GoTrue user and
`members` row are resolved independently — either one already existing is fine, and a re-run repairs
the link between them — and the bootstrap device below is minted only when the admin has no approved
device at all. That last one matters: keying it off `deploy/first-device-token.txt`, a file this page
tells you to delete, meant a later re-run silently minted a **second** permanent approved device and a
fresh break-glass token. Deleting the file, as instructed, is safe.

## Upgrading an existing deployment

Pull the new code and re-run `deploy/install.sh`. It is safe to re-run (see above): secrets are not
regenerated, and only migrations absent from `installer.schema_migrations` are applied.

**One upgrade needs a step the installer does not do for you.** The multi-tenancy migrations
(`0034`–`0041`) gave every row an owning organisation, and stored objects are namespaced by it —
floor plans and avatars now live under `{orgId}/…`. Objects uploaded *before* that upgrade sit at
the old, unprefixed paths, and nothing moves them automatically. Run the one-off script once, after
the installer has finished:

```bash
cd /path/to/network-doc-platform
set -a; . deploy/.env; set +a
NEXT_PUBLIC_SUPABASE_URL="https://$APP_HOSTNAME" SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY" \
  npx tsx scripts/migrate-storage-to-org-paths.ts --dry-run
# read the output, then run it for real by dropping --dry-run
```

Skip it and the deployment ends up with a mixed layout: rows written after the upgrade under an org
prefix, everything older beside it without one. Nothing breaks *today* — the app reads each path
from its row — but slice 2's storage policies key on the first path segment, and an object that has
no organisation segment cannot be granted to anyone once they land.

It verifies rather than trusts: source bytes are hashed before each move and the object is read back
and re-hashed at its destination before the row is updated, so a row is never pointed at an object
the script has not itself read at the new path. Nothing is deleted, one failed object is reported
instead of ending the run, and re-running resumes. It also **reports** any object no row points at —
those are left exactly where they are; deciding whether an orphan is rubbish or something you want
back is yours, not the script's.

Take a backup first (`deploy/backup.sh`, below). The storage move is the one part of that upgrade
that reverting a migration does not undo.

## The break-glass first device

The installer writes `deploy/first-device-token.txt`, mode 600 and gitignored. It exists because of a
genuine deadlock, not for convenience.

Trusted devices gate every route. Signing in from an unrecognised machine bounces you to
`/verify-device`, and approving that device needs a code delivered by email. An admin could approve
one by hand from `/users` — except `/users` sits behind the same gate. So on a fresh server, where
SMTP is not configured yet and certainly not proven, nobody can get in at all: not a new member, not
the admin the installer just created.

The file contains a one-time token that has already been inserted as an approved device for that
admin. To use it: visit `https://<your-hostname>`, sign in with the admin email and password, and set
a cookie named `ndp_device` on that origin to exactly the token in the file (browser devtools →
Application → Cookies). Only the SHA-256 of the token is stored in the database; the raw value in
that file is the only copy.

**Then close it.** Once you are in, go to `/profile`, approve a normal device through the emailed-code
flow, revoke the bootstrap device, and delete `deploy/first-device-token.txt`. It deliberately
bypasses the emailed-code path, so whoever holds it can sign in as that admin without ever proving
control of the email address. Treat it like a password until it is gone.

## Backups

`deploy/backup.sh` and `deploy/restore.sh` back up and restore this stack. Both take `--compose-file`
and `--env-file` so they work against whichever stack you point them at, and `restore.sh` refuses to
run without an explicit `--yes-overwrite`, because a restore replaces whatever is currently there.

A backup directory holds six files. The database is split along **schema versus data**, not by schema
name, because `postgres` on the `supabase/postgres` image is **not a superuser** and does not own the
`auth` and `storage` tables — it may INSERT into and TRUNCATE them, but not DROP them.

| File | What it is |
|---|---|
| `db-data.sql.gz` | every row from `public`, `auth` and `storage`, from a **single** `pg_dump --data-only` invocation — so one snapshot, internally consistent. |
| `db-schema-public.sql.gz` | structure only for `public`, `--clean --if-exists`. `postgres` owns every table here, so a DROP-then-CREATE replay works. `auth` and `storage` have no schema dump: GoTrue and storage-api recreate their own tables. |
| `db-superuser-only.sql` | the statements `pg_dump` emitted that `postgres` cannot execute, held out of the replayable dump so the restore can keep `ON_ERROR_STOP=1`. Plain text, applied by a human with superuser access if ever needed. |
| `excluded-tables.txt` | the tables the data dump leaves out (`auth.schema_migrations`, `storage.migrations` — GoTrue's and storage-api's own ledgers, which `postgres` may not write). `restore.sh` reads this file to decide which tables it must not empty, so the two ends cannot drift apart. |
| `storage.tar.gz` | the storage volume itself — every floor plan and avatar. A database-only backup silently loses all of them while looking complete. |
| `COMPLETE` | written last, only on success. `restore.sh` refuses a directory without it, and retention only ever counts and deletes directories that have one — so a run that died mid-dump can never evict a good backup. A failed run removes its own directory anyway. |

The split is not tidiness. A whole-database `pg_dump --clean` produces a file whose first statement is
`DROP EVENT TRIGGER IF EXISTS pgrst_drop_watch;`, which `postgres` does not own and cannot run. That
is exactly how the first real restore of this stack failed, leaving the database with its schema
intact and every row gone. The headers of both scripts record the reasoning in full.

**One snapshot, then the files.** `backup.sh` deliberately does not stop the stack — a nightly backup
must not take the site down — so all three schemas' rows are taken in one `pg_dump`, which runs in one
repeatable-read transaction. Taking `public` and `auth` separately, as an earlier version did, produced
a torn backup: a member created between the two dumps came back as a `members` row whose `auth_user_id`
had no `auth.users` row behind it. The storage archive is then taken **after** the database, so anything
uploaded during the remaining window is a file with no row (harmless, costs disk) rather than a row with
no file (a broken link in the app). That window is not closed; closing it needs a quiesce.

**Every archive is verified before a restore destroys anything.** `restore.sh` decompresses and checks
both SQL dumps and the storage archive up front and replays from the verified copies. This matters more
than it sounds: `gunzip -c` on a truncated archive writes the valid *prefix* and only then fails, and
psql — having seen a clean EOF — **commits**. A backup written by a filesystem that filled mid-`gzip`
would otherwise replay `DROP SCHEMA public`, recreate half the tables, commit, and only then report a
failure claiming nothing had been applied.

**Test a restore before you need one. A backup that has never been restored is a hope, not a backup.**
Run `backup.sh` and then `restore.sh` against a throwaway stack — a separate compose project, never
the production one — and confirm the data actually comes back. The first time `restore.sh` runs
should not be during a real incident, against data nobody has ever confirmed returns.

**`deploy/.env` is not in the backup, and that is the most dangerous gap here.** The scripts capture
the database and the storage volume; they never touch `deploy/.env`, which holds the only copy of
`JWT_SECRET` and the `ANON_KEY` / `SERVICE_ROLE_KEY` pair this stack was generated with. Restoring a
database backup onto a rebuilt server without that file produces a database nobody can authenticate
against: every session token and API key it contains was signed with a secret that no longer exists
anywhere. Keep a copy somewhere safe and separate from the backups themselves — a password manager or
a secrets store, not `deploy/backups/`.

## Verifying the deployment

Run the grants guard against the deployed database once, right after installing:

```bash
GRANTS_TEST_CONTAINER=$(docker compose -f deploy/docker-compose.yml ps -q db) \
  ./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts
```

It is read-only. Without `GRANTS_TEST_CONTAINER` it points at the local development container, which
is the default and is why this step is easy to skip.

Do not skip it. A fresh `supabase/postgres` image and the local Supabase CLI stack ship *different*
default privileges, so the deployment can be open while this machine shows nothing wrong — and it
was. Pointing this test at the first real install is what caught `anon` being able to execute
`consume_device_attempt`, a `security definer` function that returns the device-approval code: a POST
to `/rest/v1/rpc/consume_device_attempt` carrying nothing but the publishable key came back with the
code. Anyone who found it could approve their own machine, defeating the trusted-device factor on
every fresh install. Migration `0032` closed it.

`supabase/migrations/README.md` is the full account of the anon/authenticated surface — what the two
roles can still reach, why new migrations grant them nothing, and why every new function still needs
its own `revoke all on function … from public`. Read that before writing the next migration; it is
not repeated here.

## Things that will bite

**A hostname without a publicly-trusted certificate breaks the app container.** Every server-side
Supabase call the app makes goes to `https://APP_HOSTNAME` — the public origin, because that same
value is baked into the signed storage URLs the browser fetches. With a real domain, Caddy obtains a
Let's Encrypt certificate and Node trusts it. With a name Let's Encrypt cannot issue for — a
`.localhost`, `.test`, or internal-only hostname, where Caddy falls back to its own internal CA — the
app container fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` and nobody can sign in. This was
observed during testing, and it is why a real domain is a prerequisite rather than a preference. If a
publicly-trusted certificate is genuinely impossible, `NODE_EXTRA_CA_CERTS` pointed at the CA's root
in the app container is the escape hatch.

**Caddy carries `APP_HOSTNAME` as a network alias**, so the app container resolves the public hostname
to Caddy on the compose bridge. Without it the lookup returns the server's public IP and the request
has to leave the host and come back in through the published port, which depends on the provider's
NAT hairpinning working. The certificate still matches, because it is issued for exactly that name.
This is deliberate; do not remove the `aliases` entry.

**Restoring an older backup does not remove tables added since.** `--clean` drops only what the dump
contains. Beyond that, the public dump is scoped with `-n public`, so its clean-up ends in
`DROP SCHEMA IF EXISTS public;` with no CASCADE — a table created by a migration applied after the
backup makes that statement error and the whole replay roll back, changing nothing. That is
deliberate: the alternative is a database that is half old data and half new tables and looks fine.
Restoring across a schema change means rolling the schema back first, or dropping the newer tables by
hand once you have decided that is what you want.

**`enable_signup` does not close the OAuth door.** Disabling email self-registration stops one path;
completing a Google sign-in still mints an auth user. The membership gate is what actually controls
access — the flag is defence in depth. Worth knowing now that the app is reachable from the internet.

**The publishable key is genuinely public.** It is in the browser, and it is meant to be. Migrations
`0027` and `0028` reduced its reach to `select (email, disabled_at) on members`, and the grants guard
above asserts that. That is the whole of the protection; there is no second layer behind it.

**Phone verification and OAuth stay inert until their credentials exist**, by design. The buttons say
so rather than failing obscurely.
