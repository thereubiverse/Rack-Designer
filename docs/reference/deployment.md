# Deployment

Nothing is deployed yet. The app runs on `localhost:3100` against a Supabase stack in local Docker,
and there is no hosting configuration in the repository.

This is the list of what deploying actually requires, written down while the detail is fresh. It is
not a plan — several of these are decisions rather than steps.

## Why an invite cannot work today

The `/users` screen creates the member row, creates the auth user, and asks Supabase to send an
invite email. Two things stop that reaching a colleague:

1. **No SMTP.** Mail goes to Mailpit at `http://127.0.0.1:54324`, which only you can see. The invite
   already lands there — it is genuinely being sent, just nowhere useful.
2. **No reachable URL.** Every link in that mail is built from `site_url`. Even once mail leaves the
   building, a link to `localhost:3100` resolves to the *recipient's* machine, where nothing is
   running.

Fixing only the first produces an email nobody can act on. They go together.

## The host has to be a container, and that is not a preference

Two properties of this app rule out serverless platforms, Vercel included:

- **Uploads exceed serverless body limits.** Floor plans are accepted up to 15 MB
  (`MAX_PLAN_BYTES`) and Device Wizard photos up to 8 MB, with `bodySizeLimit: "12mb"` in
  `next.config.ts`. Vercel caps a serverless function's request body at 4.5 MB. Uploading a real
  floor plan — the centre of the product — would fail. Moving to signed direct-to-storage uploads
  would fix it, and is a genuine piece of work rather than a setting.
- **A platform-specific native binary.** `@napi-rs/canvas` rasterises a PDF page server-side for
  symbol discovery. The dev machine has `canvas-darwin-arm64`; Linux needs `canvas-linux-x64-gnu`.
  The `Dockerfile` therefore installs dependencies *inside* the image rather than copying
  `node_modules` in — verified: the built image contains the linux binding.

**Render** is the chosen host: it builds from the `Dockerfile`, deploys from the GitHub repo through
a dashboard with no CLI, and has no request-body ceiling. `render.yaml` declares the service.

### The image is known to work

It was built and run before any of this was written down, which is how two problems were found:

- `next build` failed because Next prerenders `/_not-found`, which renders the root layout, which
  called `getCurrentMember()` — and there is no Supabase environment at build time. The layout now
  treats a failed lookup as signed-out, which is the correct answer for a prerender.
- The `COPY /app/public` step failed because there was no `public/` directory; the Leaflet icons
  that used to live there were replaced by inline SVG. It now exists with a `.gitkeep`.

Then, running the image against the local Supabase stack: `/login` returned 200 and `/` returned a
307 to it, so the middleware reached the database from inside the container and the auth gate held.
107 MB image, clean boot, no errors in the log.

## The steps only you can take

I can prepare configuration and prove the container builds; I cannot create accounts or enter
credentials on your behalf. These are yours:

1. **Create a Supabase project.** Note its region — put the Render service in the same one.
2. **Create a Render account** and connect the GitHub repository. Choose "New Blueprint" so it reads
   `render.yaml` rather than configuring a service by hand.
3. **Paste the secrets into Render's dashboard**, from the table below. They are declared in
   `render.yaml` as `sync: false`, which means "not stored in the repository" — this repo is public.
4. **Set `NEXT_PUBLIC_SITE_URL`** to the URL Render gives you, and `site_url` in
   `supabase/config.toml` to the same value, then `supabase config push`.
5. **Seed the first member** (below). Nobody can invite anyone until this exists.

## The first member is a chicken-and-egg problem

Migration `0025` backfills existing members to `admin`. On an empty project that is nobody, and
`/users` is admin-only — so a fresh deployment has no way in through the UI. Create the first member
directly against the hosted database, exactly as was done locally:

```sql
insert into members (email, name, role) values ('you@qtsi.us', 'Your Name', 'admin');
```

then create the matching auth user through the Supabase dashboard (Authentication → Users → Add
user), or let the invite email do it once SMTP is configured. Sign in once; `auth_user_id` links
itself.

**A hosted Supabase project**, replacing local Docker. Then:

- `supabase link --project-ref <ref>`
- `supabase db push` — applies migrations `0001`–`0028` in order. They are ordered and were verified
  to replay cleanly; `0025` backfills every existing member to `admin`, which on an empty project
  affects nobody, so **the first real member must be inserted by hand and promoted**, exactly as
  `reubenjsingh@gmail.com` was locally. Otherwise nobody can reach `/users` to invite anyone.
- Storage buckets: `floor-plans` and `avatars` are created by migrations `0012` and `0021`, both
  private. Existing objects do **not** migrate with the database — floor plans and avatars would need
  copying separately, or re-uploading.

**Secrets**, set as environment variables on the host, never in the repository:

| Variable | For |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | the hosted project |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | publishable; middleware only |
| `SUPABASE_SERVICE_ROLE_KEY` | every data query. Server-side only |
| `NEXT_PUBLIC_SITE_URL` | the deployed URL, e.g. `https://docs.qtsi.us` |
| `RESEND_SMTP_PASSWORD` | invites and password recovery |
| `GEMINI_API_KEY` *(optional)* | the Device Wizard, if not set in-app |
| `SUPABASE_AUTH_GOOGLE_CLIENT_ID` / `_SECRET` *(optional)* | Google sign-in |
| `SUPABASE_AUTH_AZURE_CLIENT_ID` / `_SECRET` *(optional)* | Microsoft sign-in |
| `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN` / `_FROM_NUMBER` *(optional)* | phone verification |

## Email specifically

1. Create a Resend account and **verify a domain you own** — `qtsi.us`. Sending from an unverified
   domain is what puts invites in spam.
2. Create an API key. It is the SMTP *password*; the username is the literal string `resend`.
3. Put it in `RESEND_SMTP_PASSWORD` on the host. Never in `config.toml`, which is committed to a
   public repository.
4. Uncomment `[auth.email.smtp]` in `supabase/config.toml`, then `supabase config push`.
5. Set `site_url` in that same file to the deployed URL before pushing. An invite link is built from
   it, so this is the step that makes the email actionable rather than merely delivered.

Leave the block commented for local development. Uncommented, the local stack stops using Mailpit and
every test invite reaches a real inbox.

## Things that will bite

**`enable_signup`.** `[auth] enable_signup = false` stops email self-registration, but it does **not**
close the OAuth door — completing a Google sign-in still mints an auth user. The membership gate is
what actually controls access; the flag is defence in depth. This is already true locally and does
not change on deployment, but it is worth knowing before the app is reachable from the internet.

**The publishable key becomes genuinely public.** Migrations `0027` and `0028` reduced its reach to
`select (email, disabled_at) on members`, and `src/lib/supabase/grants.test.ts` asserts that. That
test shells out to the *local* Docker container, so it does not verify a hosted project — after
`supabase db push`, check the hosted grants once by hand.

**`supabase_admin`'s default privileges.** On a hosted project, as locally, there is a second set of
default privileges owned by `supabase_admin` that grants `anon` full access to tables *it* creates.
`0027` could not alter them, and every table here is `postgres`-owned so it does not bite. If a table
is ever created through Studio, re-check the grants.

**Migrations grant nothing to `anon` or `authenticated`.** See `supabase/migrations/README.md` before
writing the next one.

**Phone verification and OAuth stay inert** until their credentials exist, by design. The buttons
explain themselves rather than failing obscurely.

## Backups

`deploy/backup.sh` and `deploy/restore.sh` dump the database and archive the storage volume (floor
plans, avatars) for the self-hosted compose stack in `deploy/`. Both take `--compose-file` and
`--env-file` so they work against whichever stack you point them at, and `restore.sh` refuses to run
without an explicit `--yes-overwrite` flag, because a restore replaces whatever is currently there.

**Test a restore before you need one.** A backup that has never been restored is a hope, not a
backup — run `backup.sh` and then `restore.sh` against a throwaway stack (a separate compose project,
never the production one) and confirm the data actually comes back, before relying on either script
during a real incident. Task 5 of the self-hosted implementation plan does exactly this
(`docs/superpowers/plans/2026-08-05-self-hosted-stack.md`).

**`deploy/.env` is not in the backup.** `backup.sh` only captures the database and the storage
volume — it never touches `deploy/.env`, which holds the only copy of `JWT_SECRET` and the
`ANON_KEY`/`SERVICE_ROLE_KEY` pair this stack was generated with. Restoring a database backup onto a
rebuilt server without also having `deploy/.env` produces a database nobody can authenticate against:
every existing session token and API key was signed with a secret that no longer exists anywhere.
Keep a copy of `deploy/.env` somewhere safe and separate from these backups — a password manager or
secrets store, not the `deploy/backups/` directory itself.
