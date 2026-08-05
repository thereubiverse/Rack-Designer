# Trusted Devices (Slice H8) — Design

Built **before** the app goes on the internet, because it is the thing that makes exposing it
reasonable. A correct password on an unknown machine gets no access at all.

## 1. What it does

Signing in successfully is no longer sufficient. The browser must also present a device this member
has approved. An unrecognised one gets a six-digit code emailed to the member's own address; entering
it approves that device and lets them in. Until then, nothing.

This is a second factor in everything but name: the password is something you know, the approved
device is something you have. It is the difference between a leaked password costing you an account
and costing you every client's network documentation.

## 2. Where it is enforced, and how without re-opening the database

The membership check lives in `src/middleware.ts`, and the device check belongs beside it — one place,
before any page renders.

That runs on the Edge runtime with the **publishable key**, which migrations `0027` and `0028`
deliberately stripped down to `select (email, disabled_at) on members`. Granting it read access to a
device table would give that back exactly the kind of surface that slice closed, and would let any
member enumerate every other member's devices.

So the check goes through a `security definer` function instead:

```sql
create function is_device_trusted(p_email text, p_token_hash text) returns boolean
```

It answers one yes/no question and leaks nothing else.

**Corrected during implementation:** this was first written taking `p_member_id`, which is
uncallable — the middleware never has `members.id`, only the email from the JWT. Migration `0030`
replaces it with the email-resolving signature above. Migration `0031` adds
`consume_device_attempt`, because checking the attempt count and incrementing it in two statements
let concurrent requests share one attempt and made the six-digit code brute-forceable.

On both, `execute` is **revoked from `public`** before being granted to the one role that needs it —
Postgres grants execute to PUBLIC by default, so revoking from `authenticated` alone does nothing, a
trap this codebase already hit with `claim_phone_verification` in `0024`. `is_device_trusted` goes to
`authenticated` (the Edge middleware calls it); `consume_device_attempt` goes to `service_role` only,
because a server action calls it and the middleware never does.

## 3. Data

### `0029_trusted_devices.sql`

```sql
create table trusted_devices (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references members (id) on delete cascade,
  -- SHA-256 of the cookie value. The raw token exists only in the browser's cookie and in the
  -- request that set it; a dump of this table cannot be replayed as a device.
  token_hash  text not null unique,
  -- A guess from the user agent ("Chrome on macOS"), so the member recognises which device this is
  -- when revoking one. Never trusted for anything, and never used to identify the device.
  label       text not null default '',
  approved_at timestamptz,          -- null = pending; the device exists but grants nothing
  last_seen_at timestamptz,
  created_at  timestamptz not null default now()
);

create table device_challenges (
  device_id  uuid primary key references trusted_devices (id) on delete cascade,
  code       text        not null,
  attempts   int         not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

`device_id` is the primary key of `device_challenges`, so a device has at most one code in flight —
the same shape as `phone_verifications`, which worked.

Both tables are unreadable by `anon` and `authenticated`; the migration carries no grant tail, per
`supabase/migrations/README.md`.

## 4. The cookie

32 random bytes, base64url. `httpOnly` so script cannot read it, `secure`, `sameSite=lax`, and a one
year expiry — a device you approve should stay approved until you revoke it, or the feature becomes
an irritation people route around.

Only its SHA-256 is stored. Losing the database does not yield working device tokens.

It is deliberately **not** tied to IP address or user agent. Both change constantly — mobile networks
rotate addresses, browsers update themselves — and a device check that fails when someone walks from
wifi to cellular would train people to expect spurious refusals.

## 5. The email, and how this is testable before SMTP exists

The code is sent by **the application**, not by Supabase Auth. GoTrue has templates for invites and
recovery, not for this, and routing a custom message through it would mean bending one of those to a
purpose it does not have.

So a thin `sendEmail()` wrapper over SMTP, mirroring `sms.ts`: configured by environment variables,
absent means not configured, and the caller degrades rather than failing obscurely.

- **Locally** it points at Mailpit, which the Supabase stack already runs. `smtp_port` is currently
  commented out in `config.toml`; uncommenting it publishes SMTP on 54325 and the whole flow becomes
  exercisable end to end, code and all, without sending a real message anywhere.
- **In production** the same two variables point at Resend.

**When SMTP is not configured at all**, `sendEmail` writes the body to the server log *in development
only*, never in production — a production misconfiguration must not become a stream of one-time codes
in a log file.

That branch is currently unreachable for device codes: the action returns early on `emailConfigured()`
being false, so `sendEmail` is never called. The guard stays because the wrapper is general, but a
fresh checkout with no SMTP cannot approve a device at all — it needs Mailpit, which the local stack
already runs.

## 6. Rate limits, mirroring what already works

The phone-verification shape is reused rather than reinvented, because it survived review: one code
per device at a time, valid ten minutes, five attempts before it is spent, and no new code within
sixty seconds. Every email costs money and every code is a guess someone else could make.

## 7. What must never be logged

The activity log records `device.challenge`, `device.approve`, `device.revoke`,
`device.adminApprove` and `device.adminRevoke` — actor, action and outcome, and **no details at
all**.

Two corrections to what this section originally claimed. It said entries carry the device *label*:
they cannot, because `redact` is handed the action's first argument and the label is derived
server-side from the user-agent header, so every allowlist here is `[]`. And it said a refused
sign-in from an unapproved device is logged: it is not. The middleware runs on the Edge runtime and
cannot reach the service-role client, so a bounce the member never acts on leaves no trace —
`device.challenge` records only that they pressed the button.

The code and the token are absent from `LOGGED_FIELDS`, which means `redact` drops them by default.
That is the allowlist doing its job, and there is already a test asserting no allowlisted field name
is a known secret.

## 8. Getting locked out is the real risk

A member with no access to their email cannot approve a device themselves. That is a genuine failure
mode for a technician standing in a client's building.

Two mitigations, both deliberate:

- **An already-approved device keeps working**, so this only bites on a genuinely new machine.
- **An admin can revoke a device from `/users`, and can approve a pending one.** The emailed code is
  the normal path; the admin route is the way out when email is the thing that is broken.

**That route has a bootstrap hole, and it is not solved.** `/users` sits behind this same gate, so it
only helps when an admin *already* holds an approved device. On a fresh deployment, or any moment
when no admin does, a mail failure means nobody can reach the screen and the only exit is
`update trusted_devices set approved_at = now()` against the database. A deployment runbook needs
that line until there is a break-glass path.

Related: the cookie is `secure`, so a deployment served over plain HTTP loops on `/verify-device`
forever, minting a device row per attempt. HTTPS is not optional for this feature.

## 9. Components

| Piece | File | Responsibility |
|---|---|---|
| Migration | `supabase/migrations/0029_trusted_devices.sql` | Two tables, the function, its grants |
| Pure | `src/features/devices/deviceRules.ts` | Token generation, hashing, label from user agent, expiry/attempt checks |
| Email | `src/lib/email.ts` | `emailConfigured()`, `sendEmail()` — thin SMTP wrapper, faked in tests |
| Repository | `src/features/devices/repository.ts` | Device and challenge reads/writes |
| Actions | `src/features/devices/actions.ts` | Confirm a code, resend, revoke; admin approve/revoke |
| Gate | `src/middleware.ts` | The check, beside the membership check |
| UI | `src/app/verify-device/page.tsx`, `/profile`, `/users` | Enter a code; list and revoke your devices; admin view |

## 10. Testing

- **Pure** (`deviceRules.test.ts`): a token is 32 bytes and never repeats; the hash is stable and
  one-way; a label is derived from a user agent and falls back sensibly for a junk one; expiry and
  attempt rules match the pinned constants.
- **Middleware**: a request with no device cookie is sent to `/verify-device`; with a cookie for a
  **pending** device, likewise; with an approved one, through. **The load-bearing negative**: a
  member who has signed in correctly but whose device is unapproved reaches no page at all.
- **Actions**: a wrong code increments attempts and does not approve; the sixth attempt is refused
  even if correct; an expired code is refused; a code for another member's device is refused; and
  **approving requires the challenge to belong to the cookie presented**, not merely to exist.
- **Redaction**: the code and the token never appear in an activity entry.
- **Live**: sign in from an approved device, then clear the cookie to simulate a new machine, read the
  code out of Mailpit, approve, and confirm access — then revoke from `/profile` and confirm the next
  request is stopped.
- Tests run by EXPLICIT FILENAME or with the three `--exclude` flags — the integration files wipe the
  local database.

## 11. Out of scope

Remembering a device per-browser-profile rather than per-cookie (they are the same thing here).
Push or SMS approval — email only; the SMS plumbing exists but phone numbers are unverified for most
members. Geographic or impossible-travel checks. Session revocation across devices when a password
changes, which is a related but separate idea. Backup codes to print and keep in a wallet — worth
considering once this has been lived with.
