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

## What needs to exist

**A host for the Next app.** It needs Node, environment variables, and to sit at a stable URL.
Nothing in the codebase constrains the choice.

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
