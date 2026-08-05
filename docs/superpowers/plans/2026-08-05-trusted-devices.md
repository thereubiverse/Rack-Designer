# Trusted Devices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A correct password on an unrecognised device grants no access until a code emailed to the member is entered.

**Architecture:** The check sits in the middleware beside the membership check, and asks a `security definer` function one yes/no question rather than reading a table — the publishable key must not gain a new read surface. The device is a hashed random cookie. The code is emailed by the application over SMTP, so it is testable against Mailpit today.

**Spec:** `docs/superpowers/specs/2026-08-05-trusted-devices-design.md`

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** `*.integration.test.ts` files WIPE THE LOCAL DATABASE, which holds real data. Named files only, or: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package. Clean at **every** commit.
- Use `command grep`, not bare `grep`. Quote globs.
- Piping SQL into psql REQUIRES `docker exec -i`. Container: `supabase_db_network-doc-platform`.
- **MIGRATIONS GRANT NOTHING to `anon` or `authenticated`** — read `supabase/migrations/README.md` first. No blanket grant tail; `0027` removed it and `grants.test.ts` fails if it returns.
- **Postgres grants EXECUTE on a new function to PUBLIC.** Revoking from `anon, authenticated` alone does nothing — revoke from `public`.
- NEVER put a real secret in a git-tracked file, a test fixture, or a log entry.
- Forms use `onSubmit` + `e.preventDefault()` + `new FormData(e.currentTarget)`, NEVER `<form action={fn}>`.
- Every export in a `"use server"` module must be wrapped in `withMember`, `withEditor` or `withAdmin`, and carry an activity-log key.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: Migration — devices, challenges, and the gate function

**Files:** Create `supabase/migrations/0029_trusted_devices.sql`

- [ ] **Step 1: Write it**

```sql
-- A device the member has proved control of. The middleware checks this on every request.
create table trusted_devices (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references members (id) on delete cascade,
  -- SHA-256 of the cookie value. The raw token exists only in the browser; a dump of this table
  -- cannot be replayed as a device.
  token_hash   text not null unique,
  -- A guess from the user agent, so a member recognises which device they are revoking. Never
  -- trusted for anything and never used to identify the device.
  label        text not null default '',
  approved_at  timestamptz,          -- null = pending. A pending device grants nothing.
  last_seen_at timestamptz,
  created_at   timestamptz not null default now()
);

create index trusted_devices_member_idx on trusted_devices (member_id, created_at desc);

-- At most one code in flight per device — the same shape as phone_verifications.
create table device_challenges (
  device_id  uuid primary key references trusted_devices (id) on delete cascade,
  code       text        not null,
  attempts   int         not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- THE GATE. The middleware runs on the Edge runtime with the PUBLISHABLE key, which 0027/0028
-- reduced to `select (email, disabled_at) on members`. Granting it read access to trusted_devices
-- would hand back the surface those migrations closed, and would let any member enumerate every
-- other member's devices. This answers one yes/no question and leaks nothing else.
--
-- It also stamps last_seen_at, so "when did this device last connect" costs no extra round trip.
create or replace function is_device_trusted(p_member_id uuid, p_token_hash text)
returns boolean language plpgsql security definer as $$
declare ok boolean;
begin
  update trusted_devices
     set last_seen_at = now()
   where member_id = p_member_id
     and token_hash = p_token_hash
     and approved_at is not null
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- Postgres grants EXECUTE on a new function to PUBLIC, so revoking from anon/authenticated alone
-- would do nothing at all. Revoke from public FIRST, then grant to the one role that needs it.
-- (0024 shipped this wrong and it had to be corrected.)
revoke all on function is_device_trusted(uuid, text) from public;
grant execute on function is_device_trusted(uuid, text) to authenticated;
```

No grant tail. New tables are reachable by `service_role` through the default privileges 0028 set.

- [ ] **Step 2: Apply and verify — five probes**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0029_trusted_devices.sql
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select * from trusted_devices;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select * from device_challenges;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select is_device_trusted('00000000-0000-0000-0000-000000000000'::uuid,'x');"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role authenticated; select is_device_trusted('00000000-0000-0000-0000-000000000000'::uuid,'x');"
./node_modules/.bin/vitest run src/lib/supabase/grants.test.ts
```
Expected: permission denied; permission denied; **permission denied** (anon must NOT execute it);
**false** (authenticated may); and `grants.test.ts` still passes — it asserts no table privilege for
either role, which the new tables must satisfy.

- [ ] **Step 3: Commit**

---

### Task 2: Pure device rules

**Files:** Create `src/features/devices/deviceRules.ts` + `deviceRules.test.ts`

**Interfaces:**
```ts
export const DEVICE_COOKIE: string;            // "ndp_device"
export const DEVICE_COOKIE_MAX_AGE_S: number;  // 365 days
export const CODE_TTL_MS: number;              // 10 minutes
export const MAX_ATTEMPTS: number;             // 5
export const RESEND_COOLDOWN_MS: number;       // 60 seconds
export function generateDeviceToken(): string;
export function hashDeviceToken(token: string): string;
export function generateCode(): string;
export function deviceLabel(userAgent: string | null | undefined): string;
export type ChallengeState = "ok" | "expired" | "spent";
export function challengeState(c: { expiresAtMs: number; attempts: number }, nowMs: number): ChallengeState;
export function cooldownRemainingMs(createdAtMs: number, nowMs: number): number;
```

These deliberately mirror `src/features/profile/phoneRules.ts` rather than importing from it. The
shapes are the same because that shape survived review; the constants belong to different features
and coupling devices to the phone module to save twenty lines would be the worse trade. Say so in a
comment so it reads as a decision.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import {
  generateDeviceToken, hashDeviceToken, generateCode, deviceLabel,
  challengeState, cooldownRemainingMs, MAX_ATTEMPTS, RESEND_COOLDOWN_MS,
} from "./deviceRules";

describe("generateDeviceToken", () => {
  it("is long, url-safe, and never repeats", () => {
    const seen = new Set(Array.from({ length: 200 }, generateDeviceToken));
    expect(seen.size).toBe(200);
    for (const t of seen) expect(t).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

describe("hashDeviceToken", () => {
  it("is stable for the same token and different for another", () => {
    const a = generateDeviceToken();
    expect(hashDeviceToken(a)).toBe(hashDeviceToken(a));
    expect(hashDeviceToken(a)).not.toBe(hashDeviceToken(generateDeviceToken()));
  });

  it("does not contain the token — a database dump must not yield working cookies", () => {
    const a = generateDeviceToken();
    expect(hashDeviceToken(a)).not.toContain(a);
    expect(hashDeviceToken(a)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("generateCode", () => {
  it("is six digits and varies", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
    expect(new Set(Array.from({ length: 50 }, generateCode)).size).toBeGreaterThan(1);
  });
});

describe("deviceLabel", () => {
  it("names something a person would recognise", () => {
    expect(deviceLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"))
      .toMatch(/Chrome.*Mac/i);
    expect(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"))
      .toMatch(/iPhone|Safari/i);
  });

  it("falls back rather than throwing on junk, null or empty", () => {
    for (const junk of [null, undefined, "", "   ", "!!!"]) {
      expect(deviceLabel(junk).length).toBeGreaterThan(0);
    }
  });

  it("never returns something enormous, whatever the header says", () => {
    expect(deviceLabel("x".repeat(5000)).length).toBeLessThanOrEqual(80);
  });
});

describe("challengeState", () => {
  const fresh = { expiresAtMs: 10_000, attempts: 0 };
  it("is usable before it expires", () => expect(challengeState(fresh, 9_999)).toBe("ok"));
  it("expires exactly at the deadline", () => expect(challengeState(fresh, 10_000)).toBe("expired"));
  it("is spent once attempts are used", () =>
    expect(challengeState({ expiresAtMs: 10_000, attempts: MAX_ATTEMPTS }, 0)).toBe("spent"));
  it("reports expiry ahead of spent when both are true", () =>
    expect(challengeState({ expiresAtMs: 1, attempts: MAX_ATTEMPTS }, 5)).toBe("expired"));
});

describe("cooldownRemainingMs", () => {
  it("blocks a second send inside the window and is zero after", () => {
    expect(cooldownRemainingMs(1_000, 1_000)).toBe(RESEND_COOLDOWN_MS);
    expect(cooldownRemainingMs(1_000, 1_000 + RESEND_COOLDOWN_MS)).toBe(0);
  });
});
```

- [ ] **Step 2: Run and watch it fail. Step 3: implement** using `node:crypto`
  (`randomBytes(32).toString("base64url")`, `createHash("sha256")`, `randomInt`).
  `deviceLabel` parses coarsely — browser family and OS family, capped at 80 characters, and a
  fallback of `"Unknown device"`. It is for human recognition only; do not attempt real UA parsing.
- [ ] **Step 4: Run, typecheck, commit.**

---

### Task 3: The email wrapper

**Files:** Create `src/lib/email.ts`; modify `.env.local.example`

**Interfaces:**
```ts
export function emailConfigured(): boolean;
export async function sendEmail(to: string, subject: string, text: string): Promise<{ sent: boolean; reason?: string }>;
```

- [ ] **Step 1: Add the dependency** — `npm install nodemailer` and `npm install -D @types/nodemailer`.
  It speaks SMTP to both Mailpit and Resend, so there is one code path rather than an HTTP client for
  production and something else for development.

- [ ] **Step 2: Implement**, mirroring `src/features/profile/sms.ts`:
  - `import "server-only"`.
  - Reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` **through functions**,
    not captured at module load.
  - `sendEmail` NEVER throws. It returns `{ sent: false, reason }`.
  - **When SMTP is not configured**: in `NODE_ENV !== "production"` only, `console.info` the subject
    and body so the flow is usable on a fresh checkout; in production, return not-sent and log
    nothing but the failure. A one-time code must never reach a production log.
  - Never put the provider's response body into a thrown or returned message — it can echo the
    recipient.

- [ ] **Step 3: `.env.local.example`** gains `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`,
  `SMTP_FROM`, all empty, with a comment that local development points at Mailpit on `127.0.0.1:54325`
  once `smtp_port` is uncommented in `supabase/config.toml`.

- [ ] **Step 4: Typecheck and commit.** No tests: it is a thin wrapper faked wholesale by the action
  tests, exactly like `sms.ts`.

---

### Task 4: Repository and actions

**Files:** Create `src/features/devices/repository.ts`, `actions.ts`, `actions.test.ts`; modify `src/features/activity/redact.ts` and `summarise.ts`

**Repository** (`import "server-only"`, house error style):
`findDeviceByHash`, `insertPendingDevice`, `approveDevice`, `listDevicesForMember`,
`listPendingDevices`, `deleteDevice`, `readChallenge`, `writeChallenge`, `bumpChallengeAttempts`,
`clearChallenge`.

**Actions** — all wrapped, all keyed:

| Export | Wrapper | Key |
|---|---|---|
| `startDeviceApprovalAction` | `withMember` | `device.challenge` |
| `confirmDeviceAction` | `withMember` | `device.approve` |
| `resendDeviceCodeAction` | `withMember` | `device.challenge` |
| `revokeMyDeviceAction` | `withMember` | `device.revoke` |
| `adminApproveDeviceAction` | `withAdmin` | `device.adminApprove` |
| `adminRevokeDeviceAction` | `withAdmin` | `device.adminRevoke` |

`LOGGED_FIELDS` gains each key allowing **`label` only**. The code and the token appear nowhere, so
`redact` drops them — and the existing guard test asserts no allowlisted field name is a known
secret. `summarise` gains verbs for each.

**The rules that must be right, each with a test:**

1. `confirmDeviceAction` resolves the device **from the cookie**, then checks the challenge belongs
   to that device AND that device belongs to `member.id`. A code must not approve a device the
   caller does not hold, nor one belonging to another member.
2. A wrong code bumps attempts and does not approve. The sixth attempt is refused even if correct.
3. An expired challenge is refused and cleared.
4. `startDeviceApprovalAction` sets the cookie **only** when it creates a device, and enforces the
   60-second cooldown before sending another email.
5. On success the challenge row is deleted, so a code cannot be replayed.

Cookies are set with `cookies()` from `next/headers` — legal in a server action.
`httpOnly: true, secure: true, sameSite: "lax", maxAge: DEVICE_COOKIE_MAX_AGE_S, path: "/"`.

**Note on the spec:** §7 says a refused sign-in from an unapproved device is logged. It is not logged
from the middleware — Edge cannot reach the service-role client. `device.challenge` is the entry that
records "an unrecognised device announced itself", from a place that can write. Note this in the
report so the spec can be corrected rather than quietly diverged from.

- [ ] TDD as usual; then typecheck, run the named files, commit.

---

### Task 5: The gate

**Files:** Modify `src/middleware.ts`; create `src/middleware.device.test.ts`

- [ ] **Step 1:** After the membership check passes, and only for paths that are not public:
  - `/verify-device` is **exempt** from the device check (it requires a member but not a device), or
    the redirect loops forever. It is NOT added to `isPublicPath` — an unauthenticated visitor must
    still be sent to `/login`.
  - Read `DEVICE_COOKIE`. Missing → redirect to `/verify-device`.
  - Present → `supabase.rpc("is_device_trusted", { p_member_id, p_token_hash })`. True → through.
    False → `/verify-device`.
  - **Fail OPEN on an RPC error**, matching the membership check's existing behaviour, and
    `console.error` it. An outage must not lock out the company; the trade is written down in the
    middleware's comment already and this follows it rather than inventing a second policy.

- [ ] **Step 2: Tests** — the load-bearing one is that a member with a valid session and an
  **unapproved** device reaches no protected page. Also: no cookie redirects; an approved device
  passes; `/verify-device` is reachable without a device but not without a session; an RPC error
  fails open.

- [ ] **Step 3:** Typecheck, run named files, full suite, commit.

---

### Task 6: The screens

**Files:** Create `src/app/verify-device/page.tsx`, `src/features/devices/VerifyDevice.tsx`; modify `ProfileForm.tsx` and `UsersTable.tsx`

- [ ] `/verify-device`: requires a member (redirect to `/login` otherwise); if the current device is
  already approved, redirect to `/`. Otherwise a card explaining the device is not recognised, a
  button that calls `startDeviceApprovalAction`, then a six-digit input and Confirm, plus Resend with
  the cooldown surfaced. House style — read `ProfileForm.tsx` and match it.
- [ ] `/profile` gains a **Devices** card: this device marked, each with label, approved date, last
  seen, and a Revoke control. Revoking the current device signs you back into verification on the
  next request, which is correct; say so in the confirm copy.
- [ ] `/users` gains, per member, any **pending** devices with Approve and Reject — the way out when
  email is the broken thing (spec §8).
- [ ] Tests for the conditional rendering; typecheck; `next build`; full suite; commit.

---

### Task 7: Live verification

**Files:** none — evidence. Run by the controller.

- [ ] **Step 1: Back up first, then enable Mailpit SMTP.** `pg_dump` to `~/backups/`, uncomment
  `smtp_port = 54325` in `supabase/config.toml`, restart the stack, confirm the data is intact.
- [ ] **Step 2:** Point `.env.local` at Mailpit (`SMTP_HOST=127.0.0.1`, `SMTP_PORT=54325`).
- [ ] **Step 3:** Clear the device cookie to simulate a new machine. Sign in — expect `/verify-device`
  and **no** access to any page. Read the code from Mailpit, enter it, confirm access.
- [ ] **Step 4:** Confirm by SQL that the code never reached `activity_log`, and that the stored
  `token_hash` is not the cookie value.
- [ ] **Step 5:** Revoke the device from `/profile`; confirm the next request is stopped.
- [ ] **Step 6:** Restore the state, and record the outcome in the ledger.

---
