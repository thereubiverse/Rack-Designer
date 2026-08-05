# Sign-in and Sign-out in the Activity Log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The activity log records sign-in (succeeded and refused), and sign-out — the four outcomes `withMember` structurally cannot capture.

**Architecture:** Four explicit calls to one helper, because these paths run before there is a member, or end in a redirect the wrapper would swallow. A pure `safeActorEmail` stands between a mistyped sign-in and a password stored in a table every member reads.

**Tech Stack:** Next.js 16, TypeScript strict, Supabase, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-auth-activity-design.md`

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** `*.integration.test.ts` files WIPE THE LOCAL DATABASE, which holds real data. Named files only, or: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package. Clean at every commit.
- Use `command grep`, not bare `grep`. Quote globs.
- Piping SQL into psql REQUIRES `docker exec -i`. Container: `supabase_db_network-doc-platform`.
- **NEW MIGRATIONS GRANT NOTHING to `anon` or `authenticated`** — see `supabase/migrations/README.md`. This slice needs no migration at all.
- NEVER put a real secret in a git-tracked file, a test fixture, or a log entry.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

---

### Task 1: The helper, the keys and the copy

**Files:**
- Create: `src/features/activity/authLog.ts`
- Test: `src/features/activity/authLog.test.ts`
- Modify: `src/features/activity/redact.ts`, `src/features/activity/summarise.ts`

**Interfaces:**
```ts
export const NOT_AN_EMAIL: string;          // "(not an email address)"
export const MAX_EMAIL_LENGTH: number;      // 254
export type AuthMethod = "password" | "google" | "azure";
export function safeActorEmail(raw: unknown): string;
export async function logAuthEvent(e: {
  action: "auth.signIn" | "auth.signOut";
  outcome: "ok" | "refused";
  method: AuthMethod;
  email: unknown;
  memberId?: string | null;
  memberName?: string;
  reason?: string;
}): Promise<void>;
```

- [ ] **Step 1: Write the failing test**

Create `src/features/activity/authLog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { safeActorEmail, NOT_AN_EMAIL, MAX_EMAIL_LENGTH } from "./authLog";

describe("safeActorEmail", () => {
  it("keeps a normal address, normalised", () => {
    expect(safeActorEmail("Bob@Example.COM")).toBe("bob@example.com");
    expect(safeActorEmail("  bob@example.com  ")).toBe("bob@example.com");
  });

  it("refuses anything that is not shaped like an address", () => {
    // activity_log.actor_email is NOT NULL and the feed renders it whenever there is no member
    // name — which is exactly the unknown-address case. People type passwords into email boxes.
    for (const junk of ["hunter2", "", "   ", "no-at-sign", "@nolocal.com", "no@domain", "a b@c.com"]) {
      expect(safeActorEmail(junk)).toBe(NOT_AN_EMAIL);
    }
  });

  it("refuses a value that is not a string at all", () => {
    for (const junk of [null, undefined, 7, {}, []]) {
      expect(safeActorEmail(junk)).toBe(NOT_AN_EMAIL);
    }
  });

  it("refuses an absurdly long value rather than storing it", () => {
    expect(safeActorEmail("a".repeat(MAX_EMAIL_LENGTH) + "@example.com")).toBe(NOT_AN_EMAIL);
  });

  it("accepts an address right at the limit, so the boundary is not off by one", () => {
    const local = "a".repeat(MAX_EMAIL_LENGTH - "@example.com".length);
    expect(safeActorEmail(`${local}@example.com`)).toBe(`${local}@example.com`);
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** `./node_modules/.bin/vitest run src/features/activity/authLog.test.ts`

- [ ] **Step 3: Implement `authLog.ts`**

```ts
import { createServiceClient } from "@/lib/supabase/server";
import { writeEntry } from "./repository";
import { redact } from "./redact";

/** Sign-in and sign-out entries. These four outcomes cannot be captured in withMember: sign-in runs
 *  for somebody who is not a member yet, sign-out ends in a redirect that Next implements by
 *  throwing (the wrapper's catch would swallow it), and the OAuth callback is a route handler that
 *  never passes through the wrapper at all. See the design doc, section 1. */

export const NOT_AN_EMAIL = "(not an email address)";
/** RFC 5321's limit on a whole address. Anything longer is not a typo, it is paste. */
export const MAX_EMAIL_LENGTH = 254;

export type AuthMethod = "password" | "google" | "azure";

/** `activity_log.actor_email` is NOT NULL, and the feed renders it for any entry with no member name
 *  — which is exactly the refused-sign-in-from-an-unknown-address case this slice adds. People type
 *  passwords into email boxes, so recording the submitted value verbatim would eventually write a
 *  live credential into a table every member of the company reads.
 *
 *  So the value is recorded only if it is shaped like an address. Anything else becomes a fixed
 *  placeholder: the entry still says a refused sign-in happened and when, which is the part worth
 *  keeping.
 *
 *  KNOWN RESIDUAL, stated rather than papered over: a password that happens to look like an address
 *  (`P@ssw0rd.1`) passes this check. A shape test cannot tell those apart. It catches the ordinary
 *  cases — no `@`, no dot, whitespace, a bare word — and the alternative of storing arbitrary
 *  submitted text is strictly worse. */
export function safeActorEmail(raw: unknown): string {
  if (typeof raw !== "string") return NOT_AN_EMAIL;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > MAX_EMAIL_LENGTH) return NOT_AN_EMAIL;
  // One @, something either side, a dot in the domain, no whitespace anywhere.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return NOT_AN_EMAIL;
  return value;
}

/** Never throws and never rejects. A failure to record a sign-in must not stop somebody signing in,
 *  and — for sign-out — must not stop the redirect that follows it. Same fail-open reasoning as the
 *  main log's writer. */
export async function logAuthEvent(e: {
  action: "auth.signIn" | "auth.signOut";
  outcome: "ok" | "refused";
  method: AuthMethod;
  email: unknown;
  memberId?: string | null;
  memberName?: string;
  reason?: string;
}): Promise<void> {
  try {
    await writeEntry(createServiceClient(), {
      memberId: e.memberId ?? null,
      actorEmail: safeActorEmail(e.email),
      actorName: e.memberName ?? "",
      action: e.action,
      outcome: e.outcome,
      // Through redact like every other entry, so the allowlist is the single gate on what a log
      // entry may contain — even for a call site that builds its own details.
      details: redact(e.action, { method: e.method }),
      error: e.reason ?? null,
    });
  } catch (err) {
    console.error("logAuthEvent: could not record", e.action, err);
  }
}
```

- [ ] **Step 4: Add the keys and the copy**

In `src/features/activity/redact.ts`, add to `LOGGED_FIELDS`:
```ts
  // Which door somebody came through is the useful part. The address is in actor_email (shape-
  // checked — see authLog.ts), and there is nothing else about a sign-in worth keeping.
  "auth.signIn": ["method"],
  "auth.signOut": ["method"],
```

In `src/features/activity/summarise.ts`, make these two read well in **all three** outcomes. The
existing verb/noun composition produces awkward text for them ("Not allowed to signed in"), so
special-case them. Required strings, pinned by the tests in Step 5:

| key | outcome | reads |
|---|---|---|
| `auth.signIn` | `ok` | `Signed in with a password` / `with Google` / `with Microsoft` |
| `auth.signIn` | `refused` | `Sign-in refused (password)` / `(Google)` / `(Microsoft)` |
| `auth.signIn` | `failed` | `Sign-in failed (password)` |
| `auth.signOut` | `ok` | `Signed out` |

Map `method` to its label: `password` → "a password", `google` → "Google", `azure` → "Microsoft" —
Supabase calls the Microsoft provider `azure`, and the log should not.

- [ ] **Step 5: Extend `summarise.test.ts`** with one case per row of that table, plus: an
  `auth.signIn` entry with NO `method` in details still renders something sensible rather than
  `undefined`.

- [ ] **Step 6: Run both test files, typecheck, commit**

```bash
./node_modules/.bin/vitest run src/features/activity/authLog.test.ts src/features/activity/summarise.test.ts src/features/activity/redact.test.ts
./node_modules/.bin/tsc --noEmit
```
Note `redact.test.ts` has a drift guard asserting every `LOGGED_FIELDS` key has a `VERBS` entry — the
two new keys must satisfy it.

---

### Task 2: The four call sites

**Files:**
- Modify: `src/features/auth/authActions.ts`
- Modify: `src/app/auth/callback/route.ts`
- Test: `src/features/auth/authActions.test.ts` (extend)

- [ ] **Step 1: `signInWithPasswordAction`**

It already resolves both facts it needs: `error` from `signInWithPassword`, and `member` from
`getCurrentMember()`. Add, on the refusal branch — **before** the existing return:

```ts
    await logAuthEvent({
      action: "auth.signIn",
      outcome: "refused",
      method: "password",
      email,
      // The user is told one uniform sentence for both, so an outsider cannot learn which addresses
      // exist. The LOG records which it actually was: "forgot their password" and "was never
      // invited" need completely different responses from whoever is investigating, and only people
      // already inside can read this. See the design doc, section 4.
      reason: error ? "bad-credentials" : "not-a-member",
    });
```

and on the success branch, after `linkAuthUser`:

```ts
    await logAuthEvent({
      action: "auth.signIn", outcome: "ok", method: "password",
      email: member.email, memberId: member.id, memberName: member.name,
    });
```

Do **not** change what the function returns, and do not move the `signOut` call — the timing fix
from an earlier review (only signing out a session this call created) must survive.

- [ ] **Step 2: `signOutAction`**

Log **before** `redirect()`. `redirect` throws, so anything after it never runs:

```ts
export async function signOutAction(): Promise<{ ok: boolean; error?: string }> {
  const member = await getCurrentMember();
  const auth = await createSessionClient();
  await auth.auth.signOut();
  // BEFORE the redirect: Next implements redirect() by throwing, so a log call after it never runs.
  if (member) {
    await logAuthEvent({
      action: "auth.signOut", outcome: "ok", method: "password",
      email: member.email, memberId: member.id, memberName: member.name,
    });
  }
  redirect("/login");
}
```
Resolve the member BEFORE `signOut()`, or there is no longer a session to resolve them from.

`method` is not really known for a sign-out; `password` is a placeholder the summary ignores
(`Signed out` carries no method). If that reads badly, prefer widening `AuthMethod` over inventing a
second shape.

- [ ] **Step 3: The OAuth callback**

In `src/app/auth/callback/route.ts`, the provider is not currently known inside the handler. Read
`url.searchParams`; if the provider is not recoverable, pass `"google"` only when it genuinely is,
otherwise prefer adding the provider to the redirect URL in `oauthUrlAction` and reading it back
here. State in your report which you did — do not guess a provider into the log.

Log `refused` on the non-member branch (before its redirect, after `signOut()`), and `ok` on the
success branch. Use the member's email on success and the session user's email on refusal.

- [ ] **Step 4: Tests**

Extend `src/features/auth/authActions.test.ts` (mock `@/features/activity/authLog`):
- a successful sign-in records one `ok` entry with the member;
- a wrong password records one `refused` entry whose `reason` is `bad-credentials`;
- a correct password for a non-member records `refused` with reason `not-a-member`;
- **a throwing `logAuthEvent` does not prevent sign-in from succeeding** — the load-bearing one;
- sign-out records its entry and still calls `redirect`.

- [ ] **Step 5: Typecheck, run the affected files, full suite, `next build`, commit**

---

### Task 3: Live verification

**Files:** none — evidence. Run by the controller.

- [ ] **Step 1: The three sign-in outcomes and a sign-out.** Sign out. Sign in with a deliberately
  wrong password. Sign in with an address that is not a member at all. Then sign in properly.

- [ ] **Step 2: Confirm the entries**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select action, outcome, actor_email, actor_name, details, error from activity_log where action like 'auth.%' order by created_at desc limit 10;"
```
Expect: `auth.signOut ok`; `auth.signIn refused` with `bad-credentials`; `auth.signIn refused` with
`not-a-member` and the attempted address; `auth.signIn ok` with the member.

- [ ] **Step 3: THE CHECK THAT MATTERS — type a password into the email box.** Attempt a sign-in
  with a password-shaped string as the email, then:

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select actor_email from activity_log where action = 'auth.signIn' order by created_at desc limit 3;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select count(*) from activity_log where actor_email !~ '^[^@]+@[^@]+$' and actor_email <> '(not an email address)';"
```
The first must show the placeholder, not the string typed. The second must be **0**.

- [ ] **Step 4: The feed reads sensibly.** Open `/activity` and confirm the auth entries render as
  English, with refusals muted like every other refusal.

- [ ] **Step 5: Record the outcome in the ledger.**

---
