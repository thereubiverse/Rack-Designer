# Phone Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A member can confirm their profile phone number by receiving a code as a text and entering it back.

**Architecture:** Self-contained — the phone stays an ordinary `members` column and verification never touches `auth.users`, so no new sign-in path is created. A single pending code per member lives in `phone_verifications`. Pure rules (E.164 conversion, sameness, expiry, attempts) are separated from the actions. The Twilio call sits behind one thin wrapper that is faked in tests.

**Tech Stack:** Next.js 16 (app router, server actions), TypeScript strict, Supabase (local via Docker), Vitest + @testing-library/react, Twilio REST.

**Spec:** `docs/superpowers/specs/2026-08-04-phone-verification-design.md`

**Branch:** `profile` — this continues the Profile slice, it does not start a new one.

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** Files named `*.integration.test.ts` WIPE THE LOCAL DATABASE, which holds real data. Run named files only, or: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- Use `command grep`, not bare `grep`. Quote globs: `--include='*.ts'`.
- Piping SQL into psql REQUIRES `docker exec -i`. Container: `supabase_db_network-doc-platform`.
- Every migration ends with the three blanket grants from `0001_location_hierarchy.sql`'s tail, byte-identical — **and then re-applies the narrowing**, because the blanket grant would otherwise hand `anon` back what 0020 and 0022 took away. Latest migration is `0022_members_hide_pii_from_anon.sql`.
- **NEVER put a real secret in a git-tracked file.** Twilio credentials come from environment variables only; `.env.local` is gitignored and stays that way.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Every exported function in a `"use server"` module is a remotely invocable endpoint and MUST be wrapped in `withMember`.
- Error message house style: the thrown prefix is the function name, e.g. `sendSms: ...`.

---

### Task 1: Migration — the verified stamp and the pending code

**Files:**
- Create: `supabase/migrations/0023_member_phone_verification.sql`

- [ ] **Step 1: Read what you must copy**

Run `tail -8 supabase/migrations/0022_members_hide_pii_from_anon.sql` — it shows both the three
blanket grants and the narrowing that must follow them. Your migration repeats that shape and adds
the new table to it.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0023_member_phone_verification.sql`:

```sql
-- Phone verification. The number stays an ordinary members column and this never touches
-- auth.users: using Supabase's built-in phone OTP would write the number onto the auth user and
-- make signInWithOtp({phone}) a live way into the account — a permanent second front door added in
-- order to spell-check a contact field. See the design doc, section 2.
alter table members add column phone_verified_at timestamptz;

-- member_id is the PRIMARY KEY, so a member has at most ONE code in flight. Asking for a new code
-- replaces the old one instead of leaving several valid at once.
create table phone_verifications (
  member_id  uuid primary key references members (id) on delete cascade,
  -- E.164, the number the code was actually sent to. Compared against the profile at confirm time:
  -- if the member edited the field while a code was in flight, that code confirms nothing.
  phone      text        not null,
  -- Stored plainly, deliberately. This is a check against typos, not a secret defending an account
  -- — anyone who can read this table already holds the service role and therefore the whole
  -- database. If the phone ever becomes an MFA or recovery factor, THIS is the assumption to revisit.
  code       text        not null,
  attempts   int         not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;

-- The blanket grant above re-opens what 0020 and 0022 closed, so re-apply BOTH narrowings last, and
-- add the new table: live codes must not be readable with the publishable anon key.
revoke insert, update, delete on members from anon, authenticated;
revoke select on members from anon, authenticated;
grant select (email, disabled_at) on members to anon, authenticated;

revoke all on phone_verifications from anon, authenticated;
```

- [ ] **Step 3: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0023_member_phone_verification.sql
```

- [ ] **Step 4: Verify — all four probes**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "\d phone_verifications"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select * from phone_verifications;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select phone from members;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select disabled_at from members;"
```
Expected, in order: the table with `member_id` as primary key; **permission denied**; **permission
denied**; **succeeds** (the middleware still needs that one). If probe 2 or 3 succeeds, the
narrowing is in the wrong place — fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0023_member_phone_verification.sql
git commit -m "Add phone verification storage

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure phone rules

**Files:**
- Create: `src/features/profile/phoneRules.ts`
- Test: `src/features/profile/phoneRules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const CODE_TTL_MS: number;          // 10 minutes
  export const MAX_ATTEMPTS: number;         // 5
  export const RESEND_COOLDOWN_MS: number;   // 60 seconds
  export function toE164(raw: string): string | null;
  export function sameNumber(a: string, b: string): boolean;
  export function generateCode(): string;
  export function cooldownRemainingMs(createdAtMs: number, nowMs: number): number;
  export type PendingState = "ok" | "expired" | "spent";
  export function pendingState(p: { expiresAtMs: number; attempts: number }, nowMs: number): PendingState;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/profile/phoneRules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  toE164, sameNumber, generateCode, cooldownRemainingMs, pendingState,
  CODE_TTL_MS, MAX_ATTEMPTS, RESEND_COOLDOWN_MS,
} from "./phoneRules";

describe("toE164", () => {
  it("converts the way a person actually types a US number", () => {
    expect(toE164("(718) 555-0142")).toBe("+17185550142");
    expect(toE164("718-555-0142")).toBe("+17185550142");
    expect(toE164("718.555.0142")).toBe("+17185550142");
    expect(toE164(" 7185550142 ")).toBe("+17185550142");
  });

  it("accepts a US number that already carries its country code", () => {
    expect(toE164("1 718 555 0142")).toBe("+17185550142");
    expect(toE164("+1 (718) 555-0142")).toBe("+17185550142");
  });

  it("leaves an explicit international number alone", () => {
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  it("refuses rather than guessing when it cannot be confident", () => {
    // Guessing here means texting a stranger, which is the exact error this feature prevents.
    expect(toE164("555-0142")).toBeNull();   // no area code
    expect(toE164("12345")).toBeNull();
    expect(toE164("")).toBeNull();
    expect(toE164("not a phone")).toBeNull();
    expect(toE164("+" + "9".repeat(20))).toBeNull();
    expect(toE164("2 718 555 0142")).toBeNull(); // 11 digits not starting with 1
  });
});

describe("sameNumber", () => {
  it("treats a reformatted number as the same one", () => {
    expect(sameNumber("(718) 555-0142", "718-555-0142")).toBe(true);
    expect(sameNumber("(718) 555-0142", "+17185550142")).toBe(true);
  });

  it("sees a different number as different", () => {
    expect(sameNumber("(718) 555-0142", "(718) 555-0143")).toBe(false);
  });

  it("compares unconvertible values without throwing", () => {
    expect(sameNumber("junk", "junk")).toBe(true);
    expect(sameNumber("junk", "other")).toBe(false);
  });
});

describe("generateCode", () => {
  it("is always six digits", () => {
    for (let i = 0; i < 200; i++) expect(generateCode()).toMatch(/^\d{6}$/);
  });

  it("is not a constant", () => {
    const seen = new Set(Array.from({ length: 50 }, generateCode));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("cooldownRemainingMs", () => {
  it("blocks a second send inside the window and reports how long is left", () => {
    expect(cooldownRemainingMs(1_000, 1_000)).toBe(RESEND_COOLDOWN_MS);
    expect(cooldownRemainingMs(1_000, 1_000 + RESEND_COOLDOWN_MS - 1)).toBe(1);
  });

  it("is zero once the window has passed", () => {
    expect(cooldownRemainingMs(1_000, 1_000 + RESEND_COOLDOWN_MS)).toBe(0);
    expect(cooldownRemainingMs(1_000, 9_999_999)).toBe(0);
  });
});

describe("pendingState", () => {
  const fresh = { expiresAtMs: 10_000, attempts: 0 };

  it("is usable before it expires", () => {
    expect(pendingState(fresh, 9_999)).toBe("ok");
  });

  it("expires exactly at the deadline, not after it", () => {
    expect(pendingState(fresh, 10_000)).toBe("expired");
  });

  it("is spent once the attempts are used up", () => {
    expect(pendingState({ expiresAtMs: 10_000, attempts: MAX_ATTEMPTS }, 0)).toBe("spent");
  });

  it("reports expiry ahead of spent-ness when both are true", () => {
    expect(pendingState({ expiresAtMs: 1, attempts: MAX_ATTEMPTS }, 5)).toBe("expired");
  });

  it("has a ten minute lifetime", () => {
    expect(CODE_TTL_MS).toBe(10 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vitest run src/features/profile/phoneRules.test.ts`
Expected: FAIL — cannot resolve `./phoneRules`.

- [ ] **Step 3: Write the implementation**

Create `src/features/profile/phoneRules.ts`:

```ts
/** Phone verification rules, kept PURE so they can be tested without a database, a network or a
 *  clock. Every function that cares about time takes it as an argument. */

import { randomInt } from "node:crypto";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000;

/** E.164 for the carrier. Members type `(718) 555-0142`; Twilio needs `+17185550142`.
 *
 *  Returns null rather than guessing. A wrong guess here means texting a stranger — the exact
 *  failure this feature exists to prevent — so an unconfident conversion becomes a message asking
 *  for the area code. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const explicit = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (explicit) {
    // E.164 allows at most 15 digits including the country code, and no real number is under 8.
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  // No country code given: this company works across New York, so a bare number is +1.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Is this the same number, ignoring how it was typed? Used to decide whether editing the field
 *  costs the member their verification — reformatting should not. */
export function sameNumber(a: string, b: string): boolean {
  const ea = toE164(a);
  const eb = toE164(b);
  if (ea && eb) return ea === eb;
  // Neither converts (or only one does): fall back to comparing what was typed, so two equally
  // unconvertible values are still recognised as unchanged.
  return a.trim() === b.trim();
}

/** Six digits. randomInt is used rather than Math.random because it is free to use here and there
 *  is no reason to reach for the weaker one — not because this code defends anything. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Milliseconds still to wait before another code may be sent. Zero means go ahead. This is what
 *  stops a double-clicked button costing two messages. */
export function cooldownRemainingMs(createdAtMs: number, nowMs: number): number {
  const remaining = createdAtMs + RESEND_COOLDOWN_MS - nowMs;
  return remaining > 0 ? remaining : 0;
}

export type PendingState = "ok" | "expired" | "spent";

/** Expiry is reported ahead of spent-ness: both send the member to "ask for a new code", and the
 *  older reason is the more useful thing to tell them. */
export function pendingState(
  p: { expiresAtMs: number; attempts: number },
  nowMs: number
): PendingState {
  if (nowMs >= p.expiresAtMs) return "expired";
  if (p.attempts >= MAX_ATTEMPTS) return "spent";
  return "ok";
}
```

- [ ] **Step 4: Run the tests**

Run: `./node_modules/.bin/vitest run src/features/profile/phoneRules.test.ts`
Expected: PASS, 16 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/profile/phoneRules.ts src/features/profile/phoneRules.test.ts
git commit -m "Add pure phone verification rules

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The SMS wrapper and the verification repository

**Files:**
- Create: `src/features/profile/sms.ts`
- Modify: `src/features/profile/repository.ts`
- Modify: `.env.local.example`

**Interfaces:**
- Produces:
  ```ts
  // sms.ts
  export function smsConfigured(): boolean;
  export async function sendSms(to: string, body: string): Promise<void>;

  // repository.ts (additions)
  export interface PendingVerification { memberId, phone, code: string; attempts: number; expiresAt, createdAt: string }
  export async function readPendingVerification(db, memberId): Promise<PendingVerification | null>;
  export async function writePendingVerification(db, memberId, phone, code, expiresAtIso): Promise<void>;
  export async function bumpVerificationAttempts(db, memberId, attempts): Promise<void>;
  export async function clearPendingVerification(db, memberId): Promise<void>;
  export async function markPhoneVerified(db, memberId, atIso): Promise<void>;
  export async function clearPhoneVerified(db, memberId): Promise<void>;
  ```
  `MemberProfile` also gains `phoneVerifiedAt: string | null`, and `readProfile` selects it.

- [ ] **Step 1: Write sms.ts**

Create `src/features/profile/sms.ts`:

```ts
import "server-only";

/** The Twilio boundary, deliberately thin so the action tests can fake this whole module.
 *
 *  Credentials come from the environment and MUST NOT be written into any committed file. Until
 *  they exist, smsConfigured() is false and the UI says so rather than failing obscurely — the same
 *  treatment the Google and Microsoft buttons get. */

const SID = () => process.env.TWILIO_ACCOUNT_SID;
const TOKEN = () => process.env.TWILIO_AUTH_TOKEN;
const FROM = () => process.env.TWILIO_FROM_NUMBER;

export function smsConfigured(): boolean {
  return Boolean(SID() && TOKEN() && FROM());
}

export async function sendSms(to: string, body: string): Promise<void> {
  const sid = SID(), token = TOKEN(), from = FROM();
  if (!sid || !token || !from) throw new Error("sendSms: SMS is not configured");

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) {
    // Twilio's body can echo the destination number; keep it out of the message that reaches a
    // browser and log the detail server-side instead.
    console.error("sendSms: Twilio rejected the message", res.status, await res.text());
    throw new Error(`sendSms: provider returned ${res.status}`);
  }
}
```

- [ ] **Step 2: Extend repository.ts**

Add `phoneVerifiedAt: string | null` to `MemberProfile`, add `phone_verified_at` to `readProfile`'s
select and map it, then append:

```ts
export interface PendingVerification {
  memberId: string;
  phone: string;
  code: string;
  attempts: number;
  expiresAt: string;
  createdAt: string;
}

export async function readPendingVerification(
  db: SupabaseClient, memberId: string
): Promise<PendingVerification | null> {
  const { data, error } = await db
    .from("phone_verifications")
    .select("member_id, phone, code, attempts, expires_at, created_at")
    .eq("member_id", memberId)
    .maybeSingle();
  if (error) throw new Error(`readPendingVerification: ${error.message}`);
  if (!data) return null;
  return {
    memberId: String(data.member_id),
    phone: String(data.phone),
    code: String(data.code),
    attempts: Number(data.attempts ?? 0),
    expiresAt: String(data.expires_at),
    createdAt: String(data.created_at),
  };
}

/** Upsert on the primary key: asking for a new code REPLACES any code already in flight, so a
 *  member never has two live codes and a stale one cannot confirm a later number. */
export async function writePendingVerification(
  db: SupabaseClient, memberId: string, phone: string, code: string, expiresAtIso: string
): Promise<void> {
  const { error } = await db.from("phone_verifications").upsert({
    member_id: memberId,
    phone,
    code,
    attempts: 0,
    expires_at: expiresAtIso,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`writePendingVerification: ${error.message}`);
}

export async function bumpVerificationAttempts(
  db: SupabaseClient, memberId: string, attempts: number
): Promise<void> {
  const { error } = await db
    .from("phone_verifications").update({ attempts }).eq("member_id", memberId);
  if (error) throw new Error(`bumpVerificationAttempts: ${error.message}`);
}

export async function clearPendingVerification(db: SupabaseClient, memberId: string): Promise<void> {
  const { error } = await db.from("phone_verifications").delete().eq("member_id", memberId);
  if (error) throw new Error(`clearPendingVerification: ${error.message}`);
}

export async function markPhoneVerified(
  db: SupabaseClient, memberId: string, atIso: string
): Promise<void> {
  const { error } = await db
    .from("members").update({ phone_verified_at: atIso }).eq("id", memberId);
  if (error) throw new Error(`markPhoneVerified: ${error.message}`);
}

/** A number that changed has not been confirmed. */
export async function clearPhoneVerified(db: SupabaseClient, memberId: string): Promise<void> {
  const { error } = await db
    .from("members").update({ phone_verified_at: null }).eq("id", memberId);
  if (error) throw new Error(`clearPhoneVerified: ${error.message}`);
}
```

- [ ] **Step 3: Document the env vars without holding a value**

Append to `.env.local.example`:

```bash
# Twilio, for confirming a member's phone number by text. Create these in the Twilio console and put
# the real values in .env.local, which is gitignored. Leave them unset to run without SMS — the
# Verify button then says text confirmation isn't set up, and nothing else changes.
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=
```

Confirm `.env.local` is still ignored: `git check-ignore -v .env.local` must print a match.

- [ ] **Step 4: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/profile/sms.ts src/features/profile/repository.ts .env.local.example
git commit -m "Add the SMS wrapper and verification storage access

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: The verification actions

**Files:**
- Modify: `src/features/profile/actions.ts`
- Test: `src/features/profile/phoneActions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const sendPhoneCodeAction: () => Promise<{ ok: boolean; error?: string }>;
  export const confirmPhoneCodeAction: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
  ```
- `updateProfileAction` additionally clears `phone_verified_at` when the number changed.

- [ ] **Step 1: Write the failing test**

Create `src/features/profile/phoneActions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const ME = { id: "m1", email: "me@example.com", name: "Me", authUserId: "au1", disabledAt: null, avatarPath: null };

vi.mock("@/features/auth/withMember", () => ({
  withMember: (fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
}));
const serviceClient = {};
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => serviceClient }));
vi.mock("@/lib/supabase/auth", () => ({ createSessionClient: async () => ({ auth: {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("./sms", () => ({ smsConfigured: vi.fn(), sendSms: vi.fn() }));
vi.mock("./repository", () => ({
  readProfile: vi.fn(),
  writeProfile: vi.fn(),
  writeAvatarPath: vi.fn(),
  readPendingVerification: vi.fn(),
  writePendingVerification: vi.fn(),
  bumpVerificationAttempts: vi.fn(),
  clearPendingVerification: vi.fn(),
  markPhoneVerified: vi.fn(),
  clearPhoneVerified: vi.fn(),
}));

import { smsConfigured, sendSms } from "./sms";
import {
  readProfile, readPendingVerification, writePendingVerification,
  bumpVerificationAttempts, clearPendingVerification, markPhoneVerified,
} from "./repository";
import { sendPhoneCodeAction, confirmPhoneCodeAction } from "./actions";
import { MAX_ATTEMPTS } from "./phoneRules";

const PROFILE = {
  id: ME.id, email: ME.email, name: "Me", phone: "(718) 555-0142",
  position: "", address: "", avatarPath: null, phoneVerifiedAt: null,
};

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(smsConfigured).mockReturnValue(true);
  vi.mocked(readProfile).mockResolvedValue(PROFILE);
  vi.mocked(readPendingVerification).mockResolvedValue(null);
});

describe("sendPhoneCodeAction", () => {
  it("says so, and writes nothing, when no provider is configured", async () => {
    vi.mocked(smsConfigured).mockReturnValue(false);
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/isn't set up/i);
    expect(writePendingVerification).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("refuses a number it cannot convert, instead of texting a guess", async () => {
    vi.mocked(readProfile).mockResolvedValue({ ...PROFILE, phone: "555-0142" });
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/area code/i);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("refuses when there is no number at all", async () => {
    vi.mocked(readProfile).mockResolvedValue({ ...PROFILE, phone: "" });
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("texts the E.164 form of the number on the profile", async () => {
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(true);
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = vi.mocked(sendSms).mock.calls[0];
    expect(to).toBe("+17185550142");
    expect(body).toMatch(/\d{6}/);
  });

  it("SENDS NO SECOND MESSAGE inside the cooldown — this one guards the bill", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue({
      memberId: ME.id, phone: "+17185550142", code: "111111", attempts: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(sendSms).not.toHaveBeenCalled();
    expect(writePendingVerification).not.toHaveBeenCalled();
  });

  it("removes the pending row when the provider fails, so a retry is possible immediately", async () => {
    vi.mocked(sendSms).mockRejectedValue(new Error("provider down"));
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(clearPendingVerification).toHaveBeenCalledWith(serviceClient, ME.id);
  });
});

describe("confirmPhoneCodeAction", () => {
  const pending = (over: Partial<{ code: string; attempts: number; expiresAt: string; phone: string }> = {}) => ({
    memberId: ME.id,
    phone: over.phone ?? "+17185550142",
    code: over.code ?? "123456",
    attempts: over.attempts ?? 0,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  });

  it("refuses when nothing is pending", async () => {
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });

  it("verifies on the right code", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue(pending());
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(true);
    expect(markPhoneVerified).toHaveBeenCalledWith(serviceClient, ME.id, expect.any(String));
    expect(clearPendingVerification).toHaveBeenCalledWith(serviceClient, ME.id);
  });

  it("counts a wrong code against the attempts and does not verify", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue(pending({ attempts: 1 }));
    const res = await confirmPhoneCodeAction(form({ code: "000000" }));
    expect(res.ok).toBe(false);
    expect(bumpVerificationAttempts).toHaveBeenCalledWith(serviceClient, ME.id, 2);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });

  it("refuses a spent code even when it is correct", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue(pending({ attempts: MAX_ATTEMPTS }));
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });

  it("refuses an expired code even when it is correct", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue(
      pending({ expiresAt: new Date(Date.now() - 1).toISOString() })
    );
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expired/i);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });

  it("refuses when the profile's number changed after the code was sent", async () => {
    // Otherwise a code texted to one number could mark a DIFFERENT number verified.
    vi.mocked(readPendingVerification).mockResolvedValue(pending({ phone: "+17185550199" }));
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vitest run src/features/profile/phoneActions.test.ts`
Expected: FAIL — `sendPhoneCodeAction` is not exported.

- [ ] **Step 3: Extend actions.ts**

Add these imports:

```ts
import {
  readPendingVerification, writePendingVerification, bumpVerificationAttempts,
  clearPendingVerification, markPhoneVerified, clearPhoneVerified,
} from "./repository";
import { smsConfigured, sendSms } from "./sms";
import {
  toE164, sameNumber, generateCode, cooldownRemainingMs, pendingState, CODE_TTL_MS,
} from "./phoneRules";
```

In `updateProfileAction`, after `writeProfile`, add:

```ts
  // A number that changed has not been confirmed. Compared on the normalised form, so merely
  // reformatting the same number does not cost the member their verification.
  const before = await readProfile(db, member.id);
  if (before && !sameNumber(before.phone, fields.phone)) {
    await clearPhoneVerified(db, member.id);
    await clearPendingVerification(db, member.id);
  }
```
**Read `before` BEFORE calling `writeProfile`**, or it will already hold the new value and the
comparison will always say "unchanged". Move the read above the write.

Then append:

```ts
export const sendPhoneCodeAction = withMember(async (member) => {
  if (!smsConfigured()) {
    return { ok: false, error: "Text confirmation isn't set up yet. Ask an administrator." };
  }
  const db = createServiceClient();
  const profile = await readProfile(db, member.id);
  if (!profile?.phone) return { ok: false, error: "Add a phone number first." };

  const e164 = toE164(profile.phone);
  // Never guess a country code: texting a stranger is the failure this feature exists to prevent.
  if (!e164) return { ok: false, error: "Include the area code so we can text this number." };

  const pending = await readPendingVerification(db, member.id);
  if (pending) {
    const waitMs = cooldownRemainingMs(Date.parse(pending.createdAt), Date.now());
    if (waitMs > 0) {
      const secs = Math.ceil(waitMs / 1000);
      return { ok: false, error: `Wait ${secs} more second${secs === 1 ? "" : "s"} before asking for another code.` };
    }
  }

  const code = generateCode();
  await writePendingVerification(db, member.id, e164, code, new Date(Date.now() + CODE_TTL_MS).toISOString());
  try {
    await sendSms(e164, `Your confirmation code is ${code}`);
  } catch (e) {
    // The row is written first so the code exists before the text can arrive. If the send fails,
    // remove it — otherwise the cooldown would block the retry for a minute over a message that
    // was never delivered.
    console.error("sendPhoneCodeAction: could not send", e);
    await clearPendingVerification(db, member.id);
    return { ok: false, error: "Couldn't send that text. Try again." };
  }
  return { ok: true as const };
});

export const confirmPhoneCodeAction = withMember(async (member, formData: FormData) => {
  const entered = String(formData.get("code") ?? "").trim();
  const db = createServiceClient();

  const pending = await readPendingVerification(db, member.id);
  if (!pending) return { ok: false, error: "Ask for a code first." };

  const state = pendingState(
    { expiresAtMs: Date.parse(pending.expiresAt), attempts: pending.attempts },
    Date.now()
  );
  if (state === "expired") {
    await clearPendingVerification(db, member.id);
    return { ok: false, error: "That code has expired. Ask for a new one." };
  }
  if (state === "spent") {
    return { ok: false, error: "Too many attempts. Ask for a new code." };
  }

  // The code proves control of the number it was SENT to. If the profile now holds a different
  // number, confirming would mark an unrelated number verified.
  const profile = await readProfile(db, member.id);
  if (!profile || !sameNumber(profile.phone, pending.phone)) {
    await clearPendingVerification(db, member.id);
    return { ok: false, error: "That number changed since the code was sent. Ask for a new one." };
  }

  if (entered !== pending.code) {
    await bumpVerificationAttempts(db, member.id, pending.attempts + 1);
    return { ok: false, error: "That code isn't right." };
  }

  await markPhoneVerified(db, member.id, new Date().toISOString());
  await clearPendingVerification(db, member.id);
  revalidatePath("/profile");
  return { ok: true as const };
});
```

- [ ] **Step 4: Run the tests**

```bash
./node_modules/.bin/vitest run src/features/profile/phoneActions.test.ts src/features/profile/actions.test.ts
```
Expected: both files pass. If `actions.test.ts` now fails because `updateProfileAction` calls
`readProfile`, add the mock's return value there rather than removing the check.

- [ ] **Step 5: Confirm every export is still guarded**

```bash
command grep -nE "^export (async function|const) [a-zA-Z]+" src/features/profile/actions.ts
```
Expected: six lines, every one `= withMember`.

- [ ] **Step 6: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/profile/actions.ts src/features/profile/phoneActions.test.ts
git commit -m "Add the phone verification actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: The phone field in the form

**Files:**
- Modify: `src/features/profile/ProfileForm.tsx`
- Modify: `src/app/profile/page.tsx`
- Test: `src/features/profile/ProfileForm.test.tsx`

- [ ] **Step 1: Add the failing tests**

Append to `src/features/profile/ProfileForm.test.tsx` (and add
`phoneVerifiedAt: null` to the existing `PROFILE` fixture, plus the two new actions to the
`./actions` mock — `sendPhoneCodeAction` and `confirmPhoneCodeAction`):

```tsx
describe("phone verification", () => {
  it("offers Verify for a number that is not confirmed", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    expect(screen.getByTestId("verify-phone")).toBeTruthy();
    expect(document.body.textContent).toMatch(/not verified/i);
  });

  it("shows neither badge nor button once the number is confirmed", () => {
    render(
      <ProfileForm
        profile={{ ...PROFILE, phoneVerifiedAt: "2026-08-04T12:00:00Z" }}
        avatarUrl={null}
        hasPassword
      />
    );
    expect(screen.queryByTestId("verify-phone")).toBeNull();
    expect(document.body.textContent).toMatch(/verified/i);
  });

  it("offers nothing to verify when there is no number", () => {
    render(<ProfileForm profile={{ ...PROFILE, phone: "" }} avatarUrl={null} hasPassword />);
    expect(screen.queryByTestId("verify-phone")).toBeNull();
  });

  it("asks for the code once one has been sent", async () => {
    sendPhoneCodeAction.mockResolvedValue({ ok: true });
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    fireEvent.click(screen.getByTestId("verify-phone"));
    await waitFor(() => expect(screen.getByTestId("phone-code")).toBeTruthy());
  });

  it("reports it plainly when SMS is not set up, and asks for no code", async () => {
    sendPhoneCodeAction.mockResolvedValue({ ok: false, error: "Text confirmation isn't set up yet. Ask an administrator." });
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    fireEvent.click(screen.getByTestId("verify-phone"));
    await waitFor(() => expect(screen.getByText(/isn't set up yet/i)).toBeTruthy());
    expect(screen.queryByTestId("phone-code")).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `./node_modules/.bin/vitest run src/features/profile/ProfileForm.test.tsx`
Expected: FAIL — no `verify-phone` element.

- [ ] **Step 3: Implement**

In `src/app/profile/page.tsx` nothing changes structurally — `readProfile` already returns the whole
profile, which now carries `phoneVerifiedAt`.

In `ProfileForm.tsx`, add state and handlers beside the existing ones:

```tsx
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [phoneDone, setPhoneDone] = useState(false);

  async function sendCode() {
    setPhoneErr(null); setPhoneBusy(true);
    const res = await sendPhoneCodeAction();
    setPhoneBusy(false);
    if (!res.ok) { setPhoneErr(res.error ?? "Couldn't send that text."); return; }
    setCodeSent(true);
  }

  async function confirmCode(formData: FormData) {
    setPhoneErr(null); setPhoneBusy(true);
    const res = await confirmPhoneCodeAction(formData);
    setPhoneBusy(false);
    if (!res.ok) { setPhoneErr(res.error ?? "Couldn't confirm that code."); return; }
    setCodeSent(false); setPhoneDone(true);
    router.refresh();
  }
```

Replace the phone field block with the number, a status line, and the code entry. Requirements:
- The badge reads **Verified** (green) when `profile.phoneVerifiedAt` is set, and **Not verified**
  (muted) otherwise. Neither appears when `profile.phone` is empty.
- A **Verify** button (`data-testid="verify-phone"`) appears only when `profile.phone` is non-empty
  AND `phoneVerifiedAt` is null. It calls `sendCode`.
- Once `codeSent`, show a code input (`data-testid="phone-code"`, `name="code"`,
  `inputMode="numeric"`, `autoComplete="one-time-code"`) and a Confirm button submitting
  `confirmCode` — via `onSubmit` + `preventDefault`, NOT `<form action>`, for the same React 19
  reset reason documented on the details form.
- `phoneErr` renders near the field; `phoneDone` shows a confirmation.
- The Verify button must be disabled while `phoneBusy`.

Keep the phone `<input name="phone">` exactly as it is — it is still part of the details form and
still uncontrolled.

- [ ] **Step 4: Run the tests**

```bash
./node_modules/.bin/vitest run src/features/profile/ProfileForm.test.tsx
```
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck, build, full suite, commit**

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/next build
./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'
git add src/features/profile/ProfileForm.tsx src/features/profile/ProfileForm.test.tsx src/app/profile/page.tsx
git commit -m "Show phone verification state and offer Verify

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Live verification

**Files:** none — this task produces evidence. Run by the controller.

Signed-in account: `rsingh@qtsi.us`, password `Qtsi-2026-Rack!`. Dev server: preview
`rack-designer-dev` on port 3100. **No Twilio credentials exist**, so the send path cannot complete.

- [ ] **Step 1: The unconfigured path**

On `/profile`, confirm the number shows **Not verified** with a **Verify** button. Press it. Expect
the "isn't set up yet" message, no code input, and:

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select count(*) from phone_verifications;"
```
Expected: 0. Nothing may be written when no provider exists.

- [ ] **Step 2: Editing the number clears verification**

Mark the number verified directly, reload, and confirm the badge reads **Verified** and the Verify
button is gone:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "update members set phone_verified_at = now() where email='rsingh@qtsi.us';"
```
Then REFORMAT the number in the form (e.g. `(718) 555-0142` → `718-555-0142`) and save. It must stay
**Verified** — same number, differently typed.

Then change it to a genuinely different number and save. `phone_verified_at` must be null and the
badge must read **Not verified**:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select phone, phone_verified_at from members;"
```

- [ ] **Step 3: Confirm the full send path is UNTESTED, and say so**

Record in the ledger that send → receive → confirm was not exercised, because it requires a real
Twilio account. Do not describe it as working.

---
