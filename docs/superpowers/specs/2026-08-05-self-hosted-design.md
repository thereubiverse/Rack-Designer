# Self-Hosted Deployment (Slice H7) — Design

Replaces the Render blueprint. The application, the database and everything behind it run on a server
you control, reached over the internet through a browser.

## 1. What "a single application" means here

One `docker compose` stack, one `.env`, and one script that takes it from a bare server to a working
login page. No wiring services together by hand, and no separate Supabase account.

```
internet ──► Caddy :443  (automatic TLS)
               ├─ /auth/v1/*  /rest/v1/*  /storage/v1/*  ──► kong ──┐
               └─ everything else ─────────────────────────► app ───┤
                                                                    │  internal network only
                                                    ┌───────────────┴───────────────┐
                                                    │  auth   rest   storage        │
                                                    └───────────────┬───────────────┘
                                                                    ▼
                                                              postgres  (never published)
```

Seven containers. Supabase's own self-hosting compose ships nine or more; four of them are omitted
below with reasons, because every container that exists is one more thing to patch.

## 2. Why the API has to face the internet at all

Almost everything is server-side: all 61 actions use the service-role client, and the middleware uses
the publishable key from the Edge runtime. None of that needs to be reachable from a browser.

One thing does. Avatars and floor plans are served through **signed storage URLs** —
`createAvatarSignedUrl` and `createPlanSignedUrl` return a URL that the browser then fetches
(`<img src={avatarUrl}>`). Those URLs are built from the configured Supabase URL, so if that is an
internal address the browser cannot resolve it and every picture and plan breaks.

So `/storage/v1` must be public. `/auth/v1` and `/rest/v1` are routed alongside it rather than split,
because the alternative — an internal URL for server calls and a public one for signed URLs — means
two Supabase URLs in the configuration and a class of bug where the wrong one is used.

**Exposing `/rest/v1` is safe now, and was not three slices ago.** Migrations `0027` and `0028`
revoked every privilege on `public` from `anon` and `authenticated`, leaving one column grant. Before
that, publishing this port would have handed the entire database to anyone who found it. The guard in
`src/lib/supabase/grants.test.ts` is what keeps that true.

## 3. The services, and the four that are not here

| Service | Why |
|---|---|
| `postgres` | The database. **Port never published** — reachable only on the compose network. |
| `kong` | API gateway. Routes `/auth/v1`, `/rest/v1`, `/storage/v1` under one origin, which is what `supabase-js` expects. |
| `auth` (GoTrue) | Sign-in, invites, password recovery. |
| `rest` (PostgREST) | Every data query. |
| `storage` | Floor plans and avatars. |
| `app` | The Next server, from the existing `Dockerfile` — already built and verified. |
| `caddy` | TLS and routing. Certificates are obtained and renewed automatically. |

Omitted: **realtime** (nothing subscribes), **imgproxy** (no image transformation is used — avatars
are rendered with `object-cover`, not resized server-side), **studio** and **meta** (an admin UI is
another internet-facing surface with its own auth story; `psql` covers what it would be used for).

They can be added later. Each is a deliberate omission, not an oversight.

## 4. Secrets, which is the fiddly part

Self-hosted Supabase does not have "an API key". It has a `JWT_SECRET`, and the anon and service-role
keys are **JWTs signed with that secret** carrying `role: anon` and `role: service_role`. Hand-writing
them is where self-hosting usually goes wrong.

`scripts/install.sh` generates all of it: a random `JWT_SECRET`, a Postgres password, and the two
JWTs signed with that secret, using Node's built-in crypto — no dependency to install. It writes them
to `.env`, which is gitignored, and prints nothing sensitive to the terminal.

**The `JWT_SECRET` becomes the single most valuable thing on the server.** Anyone holding it can mint
a `service_role` token and read every client's documentation. It is worth more than any individual
password, and it never leaves the server.

## 5. What makes it safe to expose

- **Postgres is not published.** No `ports:` entry — only the compose network reaches it.
- **HTTPS only.** Caddy redirects `:80` and obtains a certificate for the hostname automatically;
  cookies are `Secure` because the origin is HTTPS.
- **The invite-only gate is already the control**, and it was built for this: uniform refusal copy so
  an outsider cannot learn which addresses exist, membership checked on every request by the
  middleware, and every action behind a role.
- **`anon` reaches almost nothing** (§2), so a found `/rest/v1` endpoint is not a database.
- **Studio is not deployed**, so there is no admin console on the internet.

What this does **not** include, stated plainly: no WAF, no fail2ban, no rate limiting beyond what
GoTrue does for auth endpoints, and no intrusion detection. A login page on the internet will be
probed. The activity log records refused sign-ins, which is what makes that visible — acting on it is
still a decision rather than a feature.

## 6. Operating it is now your job

Moving in-house moves the work, it does not remove it:

- **Backups.** `scripts/backup.sh` writes a `pg_dump` and a copy of the storage volume. A backup that
  has never been restored is a hope, not a backup — the doc says to test one.
- **Upgrades.** Postgres, GoTrue, PostgREST and Storage are pinned to explicit versions in the
  compose file rather than `latest`, so a `docker compose pull` cannot change the database engine
  under you. Upgrading is a deliberate act.
- **The server.** Operating system patches, disk, and power are yours.
- **DNS.** The hostname must resolve to the server before Caddy can obtain a certificate; a failure
  here looks like the site not loading at all.

## 7. Migrations and the first member

`install.sh` applies `supabase/migrations/*.sql` in order with `psql`. They were written and verified
in exactly that order, and `supabase/migrations/README.md` records the conventions.

Then the chicken-and-egg problem: `0025` promotes *existing* members to admin, which on a fresh
database is nobody, and `/users` is admin-only. So the script inserts the first member as `admin` and
creates the matching auth user, prompting for the address and a password it never echoes. Without
that step a fresh install has no way in.

## 8. Testing

- **The image already builds and runs** — verified against local Supabase before this slice.
- **Compose config is validated** (`docker compose config`) rather than assumed.
- **A full install is exercised end to end on a throwaway stack**: bring it up on a second set of
  ports, apply migrations, create an admin, sign in, and confirm the gate refuses a non-member —
  then tear it down. The existing local stack is not touched.
- **Postgres is confirmed unreachable** from outside the compose network.
- **`grants.test.ts` is pointed at the new stack once** to confirm the anon surface is closed there
  too; it currently hardcodes the local container name, which this slice must address.
- Tests run by EXPLICIT FILENAME or with the three `--exclude` flags — the integration files wipe the
  database.

## 9. Out of scope

High availability, replication, or failover — one server. Automated OS patching. A staging
environment. Migrating the existing local data: this stands up an empty instance, and the 3 clients,
31 sites and two floor plans stay where they are until you choose to move them. Device-level trust
("approve this laptop") — if that is what "trusted sessions" meant, it is a feature and belongs in
its own slice.
