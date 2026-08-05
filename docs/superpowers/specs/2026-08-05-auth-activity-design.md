# Sign-in and Sign-out in the Activity Log (Slice H6) — Design

Closes the one gap named at the end of [the activity log slice](./2026-08-04-activity-log-design.md):
every action in the app is recorded except the ones that let you in and out.

## 1. Why these could not be captured with everything else

The activity log captures inside `withMember`, which resolves the acting member before the action
runs. The auth paths cannot use it:

- **`signInWithPasswordAction`** runs for somebody who is not a member *yet*. At the start there is
  nobody to attribute to; by the end there may be.
- **`signOutAction`** ends in `redirect()`, which Next implements by throwing — `withMember`'s catch
  would swallow it and the redirect would never happen.
- **The OAuth callback** is a route handler, not a server action, and never passes through the
  wrapper at all.

So these four outcomes log explicitly. That is a deliberate exception to "capture in one place", and
it is the reason this is a separate slice rather than a line in the last one.

## 2. What gets recorded

| Path | Outcome | Action key |
|---|---|---|
| Password sign-in succeeds | `ok` | `auth.signIn` |
| Password sign-in refused (wrong password, or not a member) | `refused` | `auth.signIn` |
| OAuth sign-in succeeds | `ok` | `auth.signIn` |
| OAuth sign-in refused (identity proved, not a member) | `refused` | `auth.signIn` |
| Sign-out | `ok` | `auth.signOut` |

`oauthUrlAction` records nothing. It mints a redirect URL and has no outcome; what matters is what
happens at the callback, which is logged.

`details` carries `method` — `password`, `google` or `azure` — and nothing else. Which door someone
came through is the useful part; there is nothing else about a sign-in worth keeping.

**A refused attempt from an unknown address is recorded.** It has no member to link to, so
`member_id` is null — which migration 0026 already allows, because the column is nullable and
`ON DELETE SET NULL`. Repeated refusals from an address nobody recognises is the single most useful
thing this log can show, and without these entries it is invisible.

## 3. The email field is a place a password can land

`activity_log.actor_email` is `NOT NULL`, and the feed renders it for any entry with no member name —
which is exactly the unknown-address case above. People type passwords into email boxes. Without a
check, one mistyped sign-in writes a live password into a table every member of the company reads.

This is the same failure the redaction allowlist exists to prevent, arriving through a different
door, so it gets the same treatment: **the attempted address is recorded only if it looks like an
email address.** A pure `safeActorEmail` normalises and shape-checks it — one `@`, something either
side, no whitespace, under a sane length — and anything else becomes the fixed string
`(not an email address)`.

That deliberately loses information about malformed attempts. It is the right trade: the entry still
records that a refused sign-in happened and when, which is the part that matters, and the alternative
is storing arbitrary submitted text — which is how a password ends up in a log.

## 4. The log records the real reason; the user still does not see it

`signInWithPasswordAction` internally knows whether the credentials were wrong or the account is not
a member. It deliberately tells the user neither, returning one message for both, so an outsider
cannot learn which addresses exist.

The log records the true reason (`bad-credentials` or `not-a-member`) in the `error` column anyway,
because the two mean completely different things to whoever is investigating — "Bob has forgotten his
password" versus "Bob was never invited" — and answering that today means reading server logs.

This is safe precisely because of the previous slice: `activity_log` is unreadable with the
publishable key, and the feed sits behind the membership gate. Only people already inside can see it,
and they learn nothing they could not learn by asking. If the feed is ever exposed more widely, this
is the line to revisit.

## 5. Components

| Piece | File | Responsibility |
|---|---|---|
| Pure | `src/features/activity/authLog.ts` | `safeActorEmail`, and building the entry |
| Keys | `src/features/activity/redact.ts` | `auth.signIn` allows `method`; `auth.signOut` allows `method` |
| Copy | `src/features/activity/summarise.ts` | Verbs for both keys |
| Call sites | `src/features/auth/authActions.ts`, `src/app/auth/callback/route.ts` | Four explicit calls |

Writing an entry must not break signing in or out, for the same reason it must not break a save: the
write is wrapped and a failure is logged to the server console only. Signing out in particular must
still reach its `redirect()`, so the log write happens **before** it, not after.

## 6. Testing

- **Pure** (`authLog.test.ts`): `safeActorEmail` keeps a normal address, lowercases and trims it,
  and returns the placeholder for a password-shaped string, for something with no `@`, for
  whitespace, for an over-long value and for an empty one. **This is the load-bearing test** — it is
  what stands between a mistyped sign-in and a password in the log.
- **Actions**: a successful password sign-in writes one `ok` entry carrying `method: password` and
  the member; a wrong password writes one `refused` entry with a null member and the attempted
  address; sign-out writes its entry **before** redirecting; a throwing log write does not prevent
  sign-in, sign-out or the redirect.
- **Live**: sign out and back in, sign in with a deliberately wrong password, and attempt one with an
  address that is not a member — then confirm four entries with the right outcomes, and confirm by
  SQL that no entry contains a password.
- Tests run by EXPLICIT FILENAME or with the three `--exclude` flags — the integration files wipe the
  local database.

## 7. Out of scope

Rate limiting or lockout after repeated failures — this slice makes them visible, which is the
prerequisite; acting on them is a separate decision. Alerting. Recording IP address or user agent:
useful for forensics, but neither is available to the app today without new plumbing, and the entry
is worth having without them. Sessions expiring, which is not an action anyone takes.
