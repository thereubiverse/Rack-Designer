# Authentication (Slice H1) — Design

## 1. Why this exists, and why it comes first

The user asked for an activity log recording every action, attributed to whoever performed it: the
app is going to be used by installers, foremen, project managers, estimators, technicians and help
desk, and "it will be necessary to track who does what".

That log cannot be built yet. The app has **no authentication of any kind** — no users, no sessions,
no sign-in, and `createServiceClient` states it plainly: *"Phase 1 uses the service role because
there is no auth yet."* Every request runs as one shared key. There is no *who* to attribute to.

Retrofitting attribution afterwards is worse than it sounds: the log's schema, queries, filters and
entire UI are shaped by who did it — a feed you cannot filter by person is a different product. And
a page headed "Activity Log" that cannot say who did anything is worse than no page, because people
will treat it as authoritative the first time there is a dispute.

So the work decomposes into three projects with a forced order. **This spec is the first.**

1. **Authentication** — this document.
2. **Activity log** — attributed to the signed-in member.
3. **Roles & permissions** — the inert "Users & Permissions" nav item. A separate problem from
   *recording* what happened.

## 2. Scope

Invite-only membership. Members sign in with email and password, Google, or Microsoft. Every route
is protected, every server action knows who is acting, and the database continues to use the service
role.

**Explicitly not in this slice:** roles or permissions of any kind (every member has identical
powers); the activity log itself; row-level security; password reset flows beyond what Supabase Auth
provides out of the box; and the team admin UI, which is [Slice H2](#8-suggested-split).

## 3. The central distinction: authentication is not membership

Anyone on earth with a Google account can complete a Google sign-in — that is what Google is for. It
proves an identity. It does not mean the person belongs in this app.

Membership is therefore a separate, app-owned fact.

### `0017_members.sql`

```sql
create table members (
  id           uuid primary key default gen_random_uuid(),
  -- The invite is addressed to an email, and it is how a sign-in of ANY kind is matched back to a
  -- member. Stored lowercase and trimmed; see normaliseEmail.
  email        text not null unique,
  name         text not null default '',
  -- Filled on first successful sign-in. Null means invited but never signed in yet — which is a
  -- normal state, not an error, and is what the admin screen in H2 will show as "pending".
  auth_user_id uuid unique,
  invited_at   timestamptz not null default now(),
  -- Revocation. NOT a delete: every activity-log entry this person ever creates must still resolve
  -- to a name, and deleting the row would orphan exactly the history this whole effort exists to
  -- produce. Same reasoning as archived_at on clients.
  disabled_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index members_auth_user_idx on members (auth_user_id) where auth_user_id is not null;
```

Every migration ends with the three blanket grant statements from `0001`'s tail, byte-identical.

**The gate.** Every sign-in, by every method, ends with the same question: *is this email an active
member?* If not, the session is terminated immediately and the person is returned to the login page
with a neutral message. Google gets you a verified identity; the invite list gets you in.

The refusal message must not distinguish "never invited" from "revoked" from "no such account" — it
is the same sentence in all three cases. Anything finer tells an outsider which addresses exist.

## 4. Components

| Piece | File | Responsibility |
|---|---|---|
| Migration | `supabase/migrations/0017_members.sql` | The table above |
| Auth config | `supabase/config.toml` | `[auth] enable_signup = false` (currently `true`, line 176); add `[auth.external.google]` and `[auth.external.azure]` — Supabase names the Microsoft provider **azure**, and only `[auth.external.apple]` exists in the file today |
| Session client | `src/lib/supabase/auth.ts` | `@supabase/ssr` cookie client; `getSession()`. **New dependency** — the project has only `@supabase/supabase-js@^2.45.0` today, and cookie-based SSR sessions need `@supabase/ssr` added |
| Membership | `src/features/auth/members.ts` | `normaliseEmail`, `memberDecision` (pure), `getCurrentMember` |
| Route guard | `src/middleware.ts` | Protects everything except `/login`, `/auth/callback`, static assets |
| Login page | `src/app/login/page.tsx` + `src/features/auth/LoginForm.tsx` | Password form, Google and Microsoft buttons |
| OAuth callback | `src/app/auth/callback/route.ts` | Code exchange, then the membership gate |
| Action guard | `src/features/auth/withMember.ts` | The wrapper every server action runs inside |

`memberDecision` is pure and separately tested: given a member row (or none) it returns
`allowed` / `refused`. It is the one piece of real logic in the slice, and the one that must not be
wrong.

## 5. `withMember` is the seam that matters

54 server actions need a session check. Writing it 54 times guarantees the 55th forgets, and with
the database on the service role a forgotten check is an open door with nothing behind it to catch
the mistake.

So it lives in one wrapper:

```ts
export function withMember<A extends unknown[], R>(
  action: (member: Member, ...args: A) => Promise<R>
): (...args: A) => Promise<R | { ok: false; error: string }>;
```

32 of the 54 actions already share the identical signature
`(formData: FormData) => Promise<{ ok: boolean; error?: string }>`, so most convert mechanically.

**This same wrapper is where the activity log hooks in.** It already knows the actor, the action, its
arguments and its outcome — the entire content of a log entry. Building it now means the log is a
change to one function later rather than a second pass over 54 actions.

## 6. What will bite

**You can lock yourself out of your own app.** Every route is public today; the moment middleware
lands, no working login means no access. The build order is therefore fixed and is not negotiable:
members table → login page → a real member row for the user → *then* middleware. Never middleware
first.

**Google and Microsoft need credentials only the user can create** — a client ID and secret from
Google Cloud Console and from Azure app registrations. This is an external dependency on their
accounts and cannot be done for them. Email/password works without it, so the rest of the slice is
not blocked; the OAuth buttons are wired but inert until the credentials exist, and the spec treats
that as an expected intermediate state rather than a failure.

**Verification changes shape.** Every browser check against the running app now needs a session
first. A seeded test member and a password are part of the slice, not an afterthought.

**`enable_signup = false` does not close the OAuth door.** It stops email/password self-registration,
but a Google or Microsoft sign-in still creates an `auth.users` row for anyone who completes it. That
is precisely why the membership gate in section 3 is the real control and the config flag is only
defence in depth — building this the other way round is the mistake this spec exists to prevent.

**Local email is catchable.** The Supabase stack already runs Inbucket
(`supabase_inbucket_network-doc-platform`), so invite and recovery links are readable locally
without sending real mail.

## 7. Testing

- **Pure** (`members.test.ts`): `memberDecision` refuses an unknown email, refuses a disabled member,
  and allows an active one; `normaliseEmail` lowercases and trims so `Bob@X.com ` matches `bob@x.com`.
  Both matter because they are the gate.
- **Wrapper** (`withMember.test.ts`), DB-free: with no session the wrapped action is **never called**
  and an error is returned; with an active member the action runs and receives them. The negative is
  the load-bearing assertion.
- **Middleware**: an unauthenticated request to a protected path redirects to `/login` and preserves
  the path it was going to; `/login` and `/auth/callback` stay public.
- **Live, and the acceptance bar**: sign in with a password and reach the dashboard; sign in with
  Google as an invited member; and — the case this design exists for — sign in with a Google account
  that was never invited and be refused. That third one is the test that proves the gate is
  membership rather than authentication.
- Tests run by EXPLICIT FILENAME or `--exclude '**/*.integration.test.ts'` — the integration files
  wipe the local database.

## 8. Suggested split

**H1 (this spec)** — members table, login, session, `withMember`, middleware. Members are seeded
directly by SQL.

**H2** — the team admin screen: invite, revoke, re-invite, and see who is pending. Turns "seeded by
SQL" into a product. Not required by the activity log, so it can wait.

## 9. Out of scope

Roles and permissions. The activity log. Row-level security — revisit when either the browser needs
direct Supabase access, or a role must be genuinely *unable* to read something independent of
application code, which is project 3's natural moment. Self-service sign-up. SSO beyond Google and
Microsoft. Multi-tenancy or per-client user scoping.
