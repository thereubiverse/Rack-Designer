# Phone Verification (Slice H2b) — Design

Extends [the Profile slice](./2026-08-04-profile-design.md), and lands on the same branch: the phone
number is a profile field, and this is how that field earns trust.

## 1. What this is for, and what it is not for

A member's phone number exists so somebody can reach them — a foreman on site, a technician on a
call-out. The number being *wrong* is the failure this prevents: a typo, a digit transposed, an old
number carried over from a previous phone.

It is **not** a security control. The number is not an MFA factor and not a password-recovery
channel, and nothing in the app trusts it to prove identity. That decision shapes everything below:
the code is a check against mistakes, not a secret defending an account.

It also bounds the threat model. A member can only edit their own profile, so the only person a
member could mislead with a false number is themselves and whoever tries to call them. There is no
attacker to design against here — only human error.

## 2. Why not Supabase's built-in phone OTP

Supabase Auth can do this out of the box: `updateUser({ phone })` sends a code, `verifyOtp` confirms
it. Less code, and the OTP machinery is already tested.

It is rejected because of what it does as a side effect: it writes the number onto the **auth user**.
That makes the phone a credential — `signInWithOtp({ phone })` becomes a live way into the account,
bypassing the password entirely. We would be adding a permanent second front door to the
authentication system in order to spell-check a contact field.

The membership gate would still hold (the middleware checks `members.disabled_at` on every request,
so a non-member gains nothing), so this is not a hole. It is a cost, paid forever, for a feature
whose purpose is data quality.

So the phone stays an ordinary column and verification is self-contained. This also means the
verification never touches `auth.users`, and the profile page keeps working exactly as it does today
for anyone who never verifies.

Because the code is not defending an account, it is stored as plain text with a short expiry rather
than hashed. Anyone who can read that table already has the service role and therefore the whole
database; hashing would be ceremony, not protection. This reasoning is written down here so that if
the phone ever *does* become a security factor, whoever makes that change knows this assumption is
the one to revisit.

## 3. Verified is a property of a number, not of a member

### `0023_member_phone_verification.sql`

```sql
alter table members add column phone_verified_at timestamptz;

create table phone_verifications (
  member_id  uuid primary key references members (id) on delete cascade,
  phone      text        not null,   -- E.164, the number the code was sent to
  code       text        not null,
  attempts   int         not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
```

`member_id` is the primary key, so a member has **at most one** verification in flight. Asking for a
new code replaces the old one rather than leaving several valid at once — which is both simpler to
reason about and stops a stale code from a mistyped number confirming a different one later.

`phone` records what the code was actually sent to. On confirmation the app compares it against what
is in the profile now; if the member edited the field while a code was in flight, the code confirms
nothing and is rejected. Without this, entering a code from an old text could mark an unrelated
number verified.

**Editing the phone clears `phone_verified_at`.** A number that changed has not been confirmed.
Comparison is on the normalised form, so reformatting `(718) 555-0142` to `718-555-0142` is not a
change and does not cost the member their verification.

`phone_verifications` gets the same treatment as `members` in 0020/0022: the blanket grant is
re-narrowed at the end of the migration so `anon` cannot read live codes.

## 4. Formatting: humans type one thing, carriers need another

Members type `(718) 555-0142`. Twilio needs `+17185550142`. Both are correct and neither should be
forced on the other, so `phone` keeps whatever the member typed — it is what a person reads and
dials — and the E.164 form is derived when a code is sent.

`toE164` is pure and separately tested. It strips formatting, assumes **+1** when no country code is
present (this company works across New York), and returns null when it cannot be confident —
too few digits, too many, or an explicit `+` followed by something implausible. A null is a
message asking for the area code, never a silent guess: texting the wrong number because the app
invented a country code is precisely the error this feature exists to prevent.

## 5. Until an SMS provider exists

Nothing can be sent today: that needs a Twilio (or MessageBird, Vonage, Textlocal) account, which is
an external dependency on an account only the user can create, and each message costs money.

So the feature degrades the way the Google and Microsoft buttons do. The number is editable and
saveable at any time; when it is set and unverified it carries a muted **Not verified** badge and a
**Verify** button. With no provider configured, that button returns *"Text confirmation isn't set up
yet."* rather than failing obscurely — and starts working, with no code change, once the credentials
exist.

`smsConfigured()` mirrors `providerConfigured()` in `authActions.ts`: presence of the Twilio
environment variables, read server-side, never written to a committed file.

Locally the whole flow is exercisable for free with `[auth.sms.test_otp]`-style fixed codes — the
provider wrapper is faked in tests and can be pointed at a stub in development, so the slice is
fully testable without an account.

## 6. Rate limiting, because texts cost money

Even without an attacker, a stuck retry loop is a bill. Three limits:

- **One code per member at a time** — enforced by the primary key.
- **A code is valid for 10 minutes**, then it is expired and a new one must be requested.
- **Five attempts**, then the code is spent and must be re-requested. This stops an unbounded
  guessing loop by accident far more than by malice.
- **A new code cannot be requested within 60 seconds** of the last one, which is what stops a
  double-clicked button costing two messages.

The refusal messages here are specific — "That code has expired", "That code isn't right" — because
the person is authenticated and looking at their own settings. The generic-refusal rule exists to
stop outsiders learning which addresses exist; it does not apply to someone confirming their own
phone.

## 7. Components

| Piece | File | Responsibility |
|---|---|---|
| Migration | `supabase/migrations/0023_member_phone_verification.sql` | Column, table, re-narrowed grants |
| Pure | `src/features/profile/phoneRules.ts` | `toE164`, `sameNumber`, code generation, expiry/attempt checks |
| Provider | `src/features/profile/sms.ts` | `smsConfigured()`, `sendSms()` — a thin Twilio REST wrapper, faked in tests |
| Repository | `src/features/profile/repository.ts` | Read/write/clear a pending verification |
| Actions | `src/features/profile/actions.ts` | `sendPhoneCodeAction`, `confirmPhoneCodeAction` |
| UI | `src/features/profile/ProfileForm.tsx` | Badge, Verify button, code entry |

Both new actions are wrapped in `withMember` and operate solely on `member.id`, exactly as the
existing profile actions do.

## 8. Testing

- **Pure** (`phoneRules.test.ts`): `toE164` converts `(718) 555-0142` → `+17185550142`; leaves an
  explicit `+44…` alone; returns null for 5 digits and for 15; `sameNumber` treats
  `(718) 555-0142` and `718-555-0142` as the same and `…0143` as different.
- **Actions**, DB-free: sending a code with no provider configured returns the not-set-up message and
  **does not** write a verification row; a second request inside 60 seconds is refused and **sends no
  second message** (the test that protects the bill); a wrong code increments attempts and does not
  verify; the sixth attempt is refused even if correct; an expired code is refused; a correct code
  within the window sets `phone_verified_at` and deletes the pending row; **a correct code is
  refused when the profile's phone no longer matches the number it was sent to.**
- **Form**: the badge and Verify button appear only for a non-empty, unverified number; a verified
  number shows neither; saving a changed number clears the verified state in the UI.
- **Live**: with no provider, Verify reports it is not set up and writes no row. The full send →
  receive → confirm path cannot be verified without a real account, and that is stated as untested
  rather than assumed working.

## 9. Out of scope

Phone as a sign-in method or MFA factor — see section 2. International formatting beyond a +1
default and explicit country codes. Carrier or line-type lookup. Verifying anything else on the
profile. Reminding members that their number is unverified; the badge is the whole nudge.
