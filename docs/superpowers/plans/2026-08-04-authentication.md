# Authentication (Slice H1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Invite-only sign-in — email/password, Google or Microsoft — so every request carries an identity and every server action knows who is acting.

**Architecture:** Supabase Auth issues the session; a `members` table owns who is *allowed in*, checked after every sign-in of every kind. Route protection is Next middleware; server actions run inside one `withMember` wrapper rather than 54 hand-written checks. Database access stays on the service role — this slice gates the door, it does not add row-level security.

**Tech Stack:** Next.js 16.2.9 (app router, server actions, middleware), TypeScript strict, Supabase Auth via `@supabase/ssr` (new dependency), Vitest + @testing-library/react.

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** `*.integration.test.ts` files WIPE the local database, which holds the user's real data. Run named files, or the whole safe suite with exactly:
  `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package.
- Use `command grep`, not bare `grep`.
- When piping SQL into psql use `docker exec -i`; without `-i` psql silently receives nothing.
- Every migration ends with these three statements, byte-identical, copied from `0001`'s tail:
  ```sql
  grant usage on schema public to anon, authenticated, service_role;
  grant all privileges on all tables in schema public to service_role;
  grant select, insert, update, delete on all tables in schema public to anon, authenticated;
  ```
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **NEVER put a real secret in a file that git tracks.** Google and Azure client IDs/secrets are read from environment variables only. Do not write them into `config.toml`, do not commit `.env.local`, and do not ask the user to paste them into a conversation.
- **THE BUILD ORDER IS NOT NEGOTIABLE.** Middleware is Task 7 and comes only after login works and a real member row exists (Task 6). Landing middleware earlier locks the user out of their own running app.
- The refusal message for a non-member is one sentence, identical whether the account was never invited, was revoked, or does not exist. Anything finer tells an outsider which addresses are real.
- Existing behaviour to preserve: the app currently has no login at all. Until Task 7, everything must keep working exactly as it does today for an unauthenticated visitor.

---

### Task 1: Members table

**Files:**
- Create: `supabase/migrations/0017_members.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: table `members` with columns `id`, `email`, `name`, `auth_user_id`, `invited_at`, `disabled_at`, `created_at`.

- [ ] **Step 1: Write the migration**

```sql
-- Who is allowed to use this app. Deliberately separate from auth.users: anyone on earth can
-- complete a Google sign-in, which proves an identity and nothing more. This table is the gate.
create table members (
  id           uuid primary key default gen_random_uuid(),
  -- The invite is addressed to an email, and it is how a sign-in of ANY kind is matched back to a
  -- member. Always stored lowercase and trimmed — see normaliseEmail.
  email        text not null unique,
  name         text not null default '',
  -- Filled on first successful sign-in. Null means invited but never signed in, which is a normal
  -- state rather than an error.
  auth_user_id uuid unique,
  invited_at   timestamptz not null default now(),
  -- Revocation, NOT deletion. Every activity-log entry this person creates must still resolve to a
  -- name after they leave; deleting the row would orphan the history the log exists to produce.
  disabled_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index members_auth_user_idx on members (auth_user_id) where auth_user_id is not null;

grant usage on schema public to anon, authenticated, service_role;
grant all privileges on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
```

- [ ] **Step 2: Apply it and verify**

Run:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0017_members.sql
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -t -A -c "select column_name from information_schema.columns where table_name='members' order by ordinal_position;"
```
Expected, exactly these seven lines:
```
id
email
name
auth_user_id
invited_at
disabled_at
created_at
```

- [ ] **Step 3: Verify no existing table was touched**

Run:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -t -A -F'|' -c "select (select count(*) from clients), (select count(*) from sites), (select count(*) from rooms), (select count(*) from floor_devices);"
```
Expected: `3|31|11|19` — three client ROWS, one of which (`TEST`) the user archived while trying
out the archive feature, so the app shows two. The number that matters is that it is unchanged by
this migration.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0017_members.sql
git commit -m "$(cat <<'MSG'
Add the members table

Who is allowed to use this app, kept deliberately separate from auth.users:
completing a Google sign-in proves an identity and nothing more, so membership
is an app-owned fact and this table is the gate.

Revocation is disabled_at rather than a delete, because every activity-log entry
a person creates must still resolve to a name after they leave.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 2: The membership decision, as pure logic

**Files:**
- Create: `src/features/auth/members.ts`
- Test: `src/features/auth/members.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface Member {
    id: string;
    email: string;
    name: string;
    authUserId: string | null;
    disabledAt: string | null;
  }
  export type MemberDecision = { allowed: true; member: Member } | { allowed: false };
  export function normaliseEmail(raw: string): string;
  export function memberDecision(row: Member | null | undefined): MemberDecision;
  export const NOT_A_MEMBER: string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/auth/members.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normaliseEmail, memberDecision, NOT_A_MEMBER, type Member } from "./members";

const member = (over: Partial<Member> = {}): Member => ({
  id: "m1",
  email: "bob@example.com",
  name: "Bob",
  authUserId: "au1",
  disabledAt: null,
  ...over,
});

describe("normaliseEmail", () => {
  it("lowercases and trims, so a sign-in matches the invite however it was typed", () => {
    expect(normaliseEmail("  Bob@Example.COM ")).toBe("bob@example.com");
  });

  it("leaves an already-normal address alone", () => {
    expect(normaliseEmail("bob@example.com")).toBe("bob@example.com");
  });
});

describe("memberDecision", () => {
  it("allows an active member and hands the row back", () => {
    const d = memberDecision(member());
    expect(d.allowed).toBe(true);
    if (!d.allowed) throw new Error("unreachable");
    expect(d.member.email).toBe("bob@example.com");
  });

  it("REFUSES someone who was never invited", () => {
    // The whole point: authenticating with Google does not make you a member.
    expect(memberDecision(null).allowed).toBe(false);
    expect(memberDecision(undefined).allowed).toBe(false);
  });

  it("REFUSES a revoked member", () => {
    expect(memberDecision(member({ disabledAt: "2026-08-01T00:00:00Z" })).allowed).toBe(false);
  });

  it("allows a member who has never signed in before", () => {
    // Invited but no auth_user_id yet — the normal state on someone's first sign-in.
    expect(memberDecision(member({ authUserId: null })).allowed).toBe(true);
  });
});

describe("NOT_A_MEMBER", () => {
  it("is one message that does not distinguish the three refusal reasons", () => {
    // Saying "revoked" vs "never invited" vs "no such account" tells an outsider which addresses
    // are real. All three refusals use this exact string.
    expect(NOT_A_MEMBER).toBe("That account doesn't have access to this app. Ask an administrator to invite you.");
    expect(NOT_A_MEMBER).not.toMatch(/revoked|disabled|unknown|not found|never/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/features/auth/members.test.ts`
Expected: FAIL — `Failed to resolve import "./members"`

- [ ] **Step 3: Write the implementation**

Create `src/features/auth/members.ts`:

```ts
/** Membership: who is allowed to use this app, as opposed to who has proved an identity.
 *
 *  PURE — no database, no Supabase. The lookup lives in getCurrentMember; this file only decides,
 *  because deciding is the part that must not be wrong. */

export interface Member {
  id: string;
  email: string;
  name: string;
  authUserId: string | null;
  disabledAt: string | null;
}

export type MemberDecision = { allowed: true; member: Member } | { allowed: false };

/** ONE refusal message for every reason. Distinguishing "revoked" from "never invited" from "no such
 *  account" would tell someone outside the company which addresses are real. */
export const NOT_A_MEMBER =
  "That account doesn't have access to this app. Ask an administrator to invite you.";

/** Emails arrive from three different providers with three different ideas about capitalisation, and
 *  the invite was typed by a human. Normalise both sides or a real member gets refused. */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** No row means never invited; a `disabledAt` means revoked. Both refuse, identically.
 *  A null `authUserId` is NOT a refusal — that is simply someone's first sign-in. */
export function memberDecision(row: Member | null | undefined): MemberDecision {
  if (!row) return { allowed: false };
  if (row.disabledAt !== null) return { allowed: false };
  return { allowed: true, member: row };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/vitest run src/features/auth/members.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/features/auth/members.ts src/features/auth/members.test.ts
git commit -m "$(cat <<'MSG'
Add the membership decision as pure logic

Deciding who is allowed in is the one piece of this slice that must not be
wrong, so it is pure and separately tested: unknown refused, revoked refused,
never-signed-in allowed, and emails normalised on both sides because three
providers have three ideas about capitalisation.

One refusal message covers all three reasons. Distinguishing them would tell an
outsider which addresses are real.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 3: Session client and `getCurrentMember`

**Files:**
- Modify: `package.json` (add `@supabase/ssr`)
- Create: `src/lib/supabase/auth.ts`
- Modify: `src/features/auth/members.ts` (append `getCurrentMember`)

**Interfaces:**
- Consumes: Task 2's `Member`, `normaliseEmail`, `memberDecision`.
- Produces:
  ```ts
  // src/lib/supabase/auth.ts
  export function createSessionClient(): Promise<SupabaseClient>;   // cookie-backed, for auth only
  export async function getSessionEmail(): Promise<string | null>;
  export async function getSessionUserId(): Promise<string | null>;
  // src/features/auth/members.ts
  export async function getCurrentMember(): Promise<Member | null>;
  ```

- [ ] **Step 1: Add the dependency**

Run: `npm install @supabase/ssr`
Expected: `@supabase/ssr` appears in `package.json` dependencies.

- [ ] **Step 2: Write the session client**

Create `src/lib/supabase/auth.ts`:

```ts
import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The ANON-key client, backed by the request's cookies. Used ONLY to read and manage the session.
 *
 *  Every data query in this app still goes through createServiceClient — this slice gates the door,
 *  it does not move the database behind row-level security. Mixing the two up would silently change
 *  what 54 server actions can read. */
export async function createSessionClient(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        // Server COMPONENTS cannot set cookies; only actions and route handlers can. Supabase calls
        // this on token refresh from both, so a throw here would crash otherwise-fine page renders.
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          /* read-only context — the middleware refreshes the session instead */
        }
      },
    },
  });
}

export async function getSessionEmail(): Promise<string | null> {
  const db = await createSessionClient();
  const { data } = await db.auth.getUser();
  return data.user?.email ?? null;
}

export async function getSessionUserId(): Promise<string | null> {
  const db = await createSessionClient();
  const { data } = await db.auth.getUser();
  return data.user?.id ?? null;
}
```

- [ ] **Step 3: Append `getCurrentMember` to `src/features/auth/members.ts`**

```ts
import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { getSessionEmail } from "@/lib/supabase/auth";

/** The signed-in person, if they are an active member. Null covers every refusal case: no session,
 *  a session for someone never invited, and a session for someone revoked.
 *
 *  The lookup is by EMAIL, not auth user id, because a member is invited before they have an auth
 *  user at all — and because someone signing in with Google after a password (or vice versa) can
 *  arrive with a different auth user id for the same person. */
export async function getCurrentMember(): Promise<Member | null> {
  const email = await getSessionEmail();
  if (!email) return null;
  const db = createServiceClient();
  const { data } = await db
    .from("members")
    .select("id, email, name, auth_user_id, disabled_at")
    .eq("email", normaliseEmail(email))
    .maybeSingle();
  const row = data
    ? {
        id: String(data.id),
        email: String(data.email),
        name: String(data.name ?? ""),
        authUserId: data.auth_user_id === null ? null : String(data.auth_user_id),
        disabledAt: data.disabled_at === null ? null : String(data.disabled_at),
      }
    : null;
  const decision = memberDecision(row);
  return decision.allowed ? decision.member : null;
}
```

Note the file now needs `"server-only"` at the very top, above the existing pure exports. That is
correct: `getCurrentMember` must never reach the browser bundle.

- [ ] **Step 4: Verify the pure tests still pass**

The pure tests import from the same module, which now imports `server-only`. If that breaks them,
split the pure half into `src/features/auth/memberRules.ts` and re-export it from `members.ts`,
keeping the test pointed at the pure file.

Run: `./node_modules/.bin/vitest run src/features/auth/members.test.ts`
Expected: PASS, 7 tests. If it fails on `server-only`, do the split described above and re-run.

- [ ] **Step 5: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/supabase/auth.ts src/features/auth/members.ts src/features/auth/members.test.ts
git commit -m "$(cat <<'MSG'
Add the cookie session client and getCurrentMember

The anon-key cookie client reads and manages the session ONLY. Every data query
still goes through createServiceClient - this slice gates the door rather than
moving the database behind row-level security, and confusing the two would
silently change what 54 actions can read.

getCurrentMember looks a member up by email rather than auth user id, because
someone is invited before they have an auth user at all, and because signing in
with Google after a password can produce a different auth user id for the same
person.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 4: `withMember`, the action guard

**Files:**
- Create: `src/features/auth/withMember.ts`
- Test: `src/features/auth/withMember.test.ts`

**Interfaces:**
- Consumes: Task 3's `getCurrentMember`, Task 2's `NOT_A_MEMBER` and `Member`.
- Produces:
  ```ts
  export function withMember<A extends unknown[], R>(
    action: (member: Member, ...args: A) => Promise<R>
  ): (...args: A) => Promise<R | { ok: false; error: string }>;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/auth/withMember.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./members")>();
  return { ...actual, getCurrentMember: vi.fn() };
});

import { getCurrentMember } from "./members";
import { withMember } from "./withMember";
import { NOT_A_MEMBER, type Member } from "./members";

const member: Member = {
  id: "m1",
  email: "bob@example.com",
  name: "Bob",
  authUserId: "au1",
  disabledAt: null,
};

beforeEach(() => vi.clearAllMocks());

describe("withMember", () => {
  it("NEVER calls the action when there is no member", async () => {
    // The load-bearing assertion of the whole slice: a guarded action must not run at all, not
    // merely have its result discarded.
    vi.mocked(getCurrentMember).mockResolvedValue(null);
    const inner = vi.fn(async () => ({ ok: true as const }));
    const guarded = withMember(inner);

    const res = await guarded();

    expect(inner).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: NOT_A_MEMBER });
  });

  it("runs the action and hands it the member", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    const inner = vi.fn(async (m: Member) => ({ ok: true as const, who: m.email }));
    const guarded = withMember(inner);

    expect(await guarded()).toEqual({ ok: true, who: "bob@example.com" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0][0]).toEqual(member);
  });

  it("passes the original arguments through untouched", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    const fd = new FormData();
    fd.set("id", "abc");
    const inner = vi.fn(async (_m: Member, form: FormData) => ({ ok: true as const, id: form.get("id") }));
    const guarded = withMember(inner);

    expect(await guarded(fd)).toEqual({ ok: true, id: "abc" });
  });

  it("resolves rather than rejecting when the action throws", async () => {
    // Server actions in this codebase always RESOLVE {ok:false}; a rejection surfaces as an
    // unhandled error in the client component instead of an error message.
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    const guarded = withMember(async () => {
      throw new Error("boom");
    });

    const res = await guarded();
    expect(res).toEqual(expect.objectContaining({ ok: false }));
  });

  it("resolves {ok:false} when the membership lookup itself throws", async () => {
    // A database hiccup during the check must refuse, never fall open.
    vi.mocked(getCurrentMember).mockRejectedValue(new Error("db down"));
    const inner = vi.fn(async () => ({ ok: true as const }));

    const res = await withMember(inner)();

    expect(inner).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ ok: false }));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/features/auth/withMember.test.ts`
Expected: FAIL — `Failed to resolve import "./withMember"`

- [ ] **Step 3: Write the implementation**

Create `src/features/auth/withMember.ts`:

```ts
import "server-only";
import { getCurrentMember, NOT_A_MEMBER, type Member } from "./members";

/**
 * Wrap a server action so it only runs for an active member, and receives them.
 *
 * ONE wrapper rather than 54 hand-written checks. With the database on the service role, an action
 * that forgets its check is an open door with nothing behind it to catch the mistake — and the 55th
 * action is the one that forgets.
 *
 * It also FAILS CLOSED: if the membership lookup itself throws, the action does not run. A database
 * hiccup must refuse, not admit.
 *
 * This is the seam the activity log will hook into: it already knows the actor, the action, its
 * arguments and its outcome, which is the whole content of a log entry.
 */
export function withMember<A extends unknown[], R>(
  action: (member: Member, ...args: A) => Promise<R>
): (...args: A) => Promise<R | { ok: false; error: string }> {
  return async (...args: A) => {
    let member: Member | null;
    try {
      member = await getCurrentMember();
    } catch {
      return { ok: false, error: NOT_A_MEMBER };
    }
    if (!member) return { ok: false, error: NOT_A_MEMBER };
    try {
      return await action(member, ...args);
    } catch (e) {
      // Every action in this codebase resolves {ok:false} rather than rejecting; a rejection
      // surfaces as an unhandled error in the calling component instead of a message.
      return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
    }
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/vitest run src/features/auth/withMember.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Typecheck**

Run: `./node_modules/.bin/tsc --noEmit`
Expected: no output

- [ ] **Step 6: Commit**

```bash
git add src/features/auth/withMember.ts src/features/auth/withMember.test.ts
git commit -m "$(cat <<'MSG'
Add withMember, the single action guard

One wrapper rather than 54 hand-written checks: with the database on the service
role, the action that forgets its check is an open door with nothing behind it,
and the 55th action is the one that forgets.

It fails closed - if the membership lookup itself throws, the action does not
run. The load-bearing test asserts the guarded action is NEVER CALLED without a
member, not merely that its result was discarded.

No action is wrapped yet; conversion comes after login exists.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 5: Login page and password sign-in

**Files:**
- Create: `src/app/login/page.tsx`
- Create: `src/features/auth/LoginForm.tsx`
- Create: `src/features/auth/authActions.ts`
- Create: `src/features/auth/LoginForm.test.tsx`
- Modify: `src/features/shell/AppShell.tsx`

**Interfaces:**
- Consumes: Task 2's `NOT_A_MEMBER`, `normaliseEmail`; Task 3's `createSessionClient`, `getCurrentMember`.
- Produces:
  ```ts
  // src/features/auth/authActions.ts
  export async function signInWithPasswordAction(formData: FormData): Promise<{ ok: boolean; error?: string }>;
  export async function signOutAction(): Promise<{ ok: boolean; error?: string }>;
  export async function oauthUrlAction(formData: FormData): Promise<{ ok: boolean; url?: string; error?: string }>;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/auth/LoginForm.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { LoginForm } from "./LoginForm";

vi.mock("./authActions", () => ({
  signInWithPasswordAction: vi.fn(async () => ({ ok: true })),
  oauthUrlAction: vi.fn(async () => ({ ok: true, url: "https://accounts.google.com/x" })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));

import { signInWithPasswordAction, oauthUrlAction } from "./authActions";

beforeEach(() => vi.clearAllMocks());

describe("LoginForm", () => {
  it("offers all three ways in", () => {
    render(<LoginForm />);
    expect(screen.getByTestId("login-email")).toBeInTheDocument();
    expect(screen.getByTestId("login-password")).toBeInTheDocument();
    expect(screen.getByTestId("login-google")).toBeInTheDocument();
    expect(screen.getByTestId("login-microsoft")).toBeInTheDocument();
  });

  it("submits the typed credentials", async () => {
    render(<LoginForm />);
    fireEvent.change(screen.getByTestId("login-email"), { target: { value: "bob@example.com" } });
    fireEvent.change(screen.getByTestId("login-password"), { target: { value: "hunter2" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    const sent = vi.mocked(signInWithPasswordAction).mock.calls[0][0] as FormData;
    expect(sent.get("email")).toBe("bob@example.com");
    expect(sent.get("password")).toBe("hunter2");
  });

  it("shows the refusal instead of failing silently", async () => {
    vi.mocked(signInWithPasswordAction).mockResolvedValueOnce({ ok: false, error: "nope" });
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    expect(screen.getByTestId("login-error").textContent).toContain("nope");
  });

  it("announces the error to assistive tech", async () => {
    vi.mocked(signInWithPasswordAction).mockResolvedValueOnce({ ok: false, error: "nope" });
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    expect(screen.getByTestId("login-error")).toHaveAttribute("role", "alert");
  });

  it("asks the server for the provider URL rather than hard-coding one", async () => {
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-google"));
    });
    const sent = vi.mocked(oauthUrlAction).mock.calls[0][0] as FormData;
    expect(sent.get("provider")).toBe("google");
  });

  it("tells the user when a provider is not configured yet", async () => {
    // Google and Microsoft credentials are the user's to create; until they exist the button must
    // explain itself rather than dead-ending.
    vi.mocked(oauthUrlAction).mockResolvedValueOnce({ ok: false, error: "Google sign-in isn't configured yet." });
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-microsoft"));
    });
    expect(screen.getByTestId("login-error").textContent).toContain("isn't configured");
  });

  it("disables the submit while a sign-in is in flight", async () => {
    let release: (v: { ok: boolean }) => void = () => {};
    vi.mocked(signInWithPasswordAction).mockReturnValueOnce(
      new Promise((r) => {
        release = r;
      }) as Promise<{ ok: boolean }>
    );
    render(<LoginForm />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("login-submit"));
    });
    expect(screen.getByTestId("login-submit")).toBeDisabled();
    await act(async () => {
      release({ ok: true });
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/features/auth/LoginForm.test.tsx`
Expected: FAIL — `Failed to resolve import "./LoginForm"`

- [ ] **Step 3: Write the auth actions**

Create `src/features/auth/authActions.ts`:

```ts
"use server";

import { redirect } from "next/navigation";
import { createSessionClient } from "@/lib/supabase/auth";
import { createServiceClient } from "@/lib/supabase/server";
import { getCurrentMember, normaliseEmail, NOT_A_MEMBER } from "./members";

/** Providers this app offers. Supabase names the Microsoft provider "azure". */
const PROVIDERS = { google: "google", microsoft: "azure" } as const;
type ProviderKey = keyof typeof PROVIDERS;

const PROVIDER_LABEL: Record<ProviderKey, string> = { google: "Google", microsoft: "Microsoft" };

/** Credentials live in the environment and nowhere else — never in config.toml, never committed. */
function providerConfigured(key: ProviderKey): boolean {
  return key === "google"
    ? Boolean(process.env.SUPABASE_AUTH_GOOGLE_CLIENT_ID)
    : Boolean(process.env.SUPABASE_AUTH_AZURE_CLIENT_ID);
}

/** Sign in, then apply the membership gate. Authenticating is not membership: a valid password for
 *  an auth user who is not an active member must NOT leave a usable session behind. */
export async function signInWithPasswordAction(
  formData: FormData
): Promise<{ ok: boolean; error?: string }> {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { ok: false, error: "Enter your email and password." };

  const auth = await createSessionClient();
  const { error } = await auth.auth.signInWithPassword({ email, password });
  // Deliberately the same message as a non-member: a distinct "wrong password" reveals that the
  // address exists.
  if (error) return { ok: false, error: NOT_A_MEMBER };

  const member = await getCurrentMember();
  if (!member) {
    await auth.auth.signOut();
    return { ok: false, error: NOT_A_MEMBER };
  }
  await linkAuthUser(member.id, email);
  return { ok: true };
}

/** Record which auth user this member signed in as, the first time we see one. Purely informational
 *  — the gate matches on email — but it is what the admin screen shows as "has signed in". */
async function linkAuthUser(memberId: string, email: string): Promise<void> {
  const auth = await createSessionClient();
  const { data } = await auth.auth.getUser();
  if (!data.user) return;
  const db = createServiceClient();
  await db
    .from("members")
    .update({ auth_user_id: data.user.id })
    .eq("id", memberId)
    .is("auth_user_id", null);
  void email;
}

export async function signOutAction(): Promise<{ ok: boolean; error?: string }> {
  const auth = await createSessionClient();
  await auth.auth.signOut();
  redirect("/login");
}

/** Hand the browser a provider URL rather than building one client-side, so the redirect target is
 *  decided by the server and the client never needs to know provider names or keys. */
export async function oauthUrlAction(
  formData: FormData
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const key = String(formData.get("provider") ?? "") as ProviderKey;
  if (!(key in PROVIDERS)) return { ok: false, error: "Unknown sign-in provider." };
  if (!providerConfigured(key)) {
    return { ok: false, error: `${PROVIDER_LABEL[key]} sign-in isn't configured yet.` };
  }
  const auth = await createSessionClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3100";
  const { data, error } = await auth.auth.signInWithOAuth({
    provider: PROVIDERS[key],
    options: { redirectTo: `${origin}/auth/callback` },
  });
  if (error || !data.url) return { ok: false, error: `Couldn't start ${PROVIDER_LABEL[key]} sign-in.` };
  return { ok: true, url: data.url };
}
```

- [ ] **Step 4: Write the form**

Create `src/features/auth/LoginForm.tsx`:

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import { signInWithPasswordAction, oauthUrlAction } from "./authActions";

/** The only page an unauthenticated visitor can reach. Deliberately says as little as possible about
 *  why a sign-in failed — see NOT_A_MEMBER. */
export function LoginForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await signInWithPasswordAction(new FormData(e.currentTarget));
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Sign-in failed.");
      return;
    }
    router.replace("/");
    router.refresh();
  }

  async function oauth(provider: "google" | "microsoft") {
    setBusy(true);
    setError(null);
    const fd = new FormData();
    fd.set("provider", provider);
    const res = await oauthUrlAction(fd);
    setBusy(false);
    if (!res.ok || !res.url) {
      setError(res.error ?? "Sign-in failed.");
      return;
    }
    window.location.href = res.url;
  }

  const field =
    "h-10 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 px-4">
      <div>
        <h1 className="text-xl font-bold text-neutral-900">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-500">Network Documentation Platform</p>
      </div>

      {error && (
        <p
          data-testid="login-error"
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      <form onSubmit={submit} className="space-y-3">
        <label className="block text-[11px] font-semibold text-neutral-600">
          Email
          <input data-testid="login-email" name="email" type="email" autoComplete="email" className={field} />
        </label>
        <label className="block text-[11px] font-semibold text-neutral-600">
          Password
          <input
            data-testid="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            className={field}
          />
        </label>
        <button
          type="submit"
          data-testid="login-submit"
          disabled={busy}
          className="h-10 w-full rounded-lg bg-blue-600 text-sm font-semibold text-white hover:bg-[#376ad9] disabled:opacity-50"
        >
          Sign in
        </button>
      </form>

      <div className="flex items-center gap-3 text-xs text-neutral-400">
        <span className="h-px flex-1 bg-neutral-200" />
        or
        <span className="h-px flex-1 bg-neutral-200" />
      </div>

      <div className="space-y-2">
        <button
          type="button"
          data-testid="login-google"
          disabled={busy}
          onClick={() => void oauth("google")}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          <Icon icon="tabler:brand-google" width={16} height={16} />
          Continue with Google
        </button>
        <button
          type="button"
          data-testid="login-microsoft"
          disabled={busy}
          onClick={() => void oauth("microsoft")}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-neutral-200 text-sm font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          <Icon icon="tabler:brand-windows" width={16} height={16} />
          Continue with Microsoft
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add the route**

Create `src/app/login/page.tsx`:

```tsx
import { LoginForm } from "@/features/auth/LoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return <LoginForm />;
}
```

- [ ] **Step 6: Keep the app shell off the login page**

In `src/features/shell/AppShell.tsx`, immediately after `const pathname = usePathname();`, add:

```tsx
  // The auth routes render bare: a sidebar full of links you cannot use, above a sign-in form, is
  // both confusing and a hint about what exists inside. AppShell already knows the pathname, so this
  // is cheaper than splitting every page into a route group.
  const bare = pathname === "/login" || pathname.startsWith("/auth/");
```

and immediately before the component's existing `return (`, add:

```tsx
  if (bare) return <>{children}</>;
```

- [ ] **Step 7: Run the tests**

Run: `./node_modules/.bin/vitest run src/features/auth/LoginForm.test.tsx`
Expected: PASS, 7 tests

- [ ] **Step 8: Typecheck and check nothing else broke**

Run:
```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'
```
Expected: no tsc output; every test file passes.

- [ ] **Step 9: Commit**

```bash
git add src/app/login src/features/auth/LoginForm.tsx src/features/auth/LoginForm.test.tsx src/features/auth/authActions.ts src/features/shell/AppShell.tsx
git commit -m "$(cat <<'MSG'
Add the login page and password sign-in

Signing in ends at the membership gate: a valid password for someone who is not
an active member signs the session straight back out rather than leaving a
usable one behind.

A wrong password returns the same sentence as a non-member, because a distinct
"wrong password" confirms the address exists.

Provider URLs come from the server, so the browser never needs provider names or
keys, and an unconfigured provider explains itself instead of dead-ending -
Google and Microsoft credentials are the user's to create and live only in the
environment.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 6: The OAuth callback, a seeded member, and end-to-end sign-in

**Files:**
- Create: `src/app/auth/callback/route.ts`
- Modify: `supabase/config.toml`
- Modify: `.env.local.example` (create if absent)

**Interfaces:**
- Consumes: Task 3's `createSessionClient`, Task 3's `getCurrentMember`, Task 2's `NOT_A_MEMBER`.
- Produces: the route `/auth/callback`, and a real member row for the user so Task 7 cannot lock them out.

- [ ] **Step 1: Write the callback route**

Create `src/app/auth/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { createSessionClient } from "@/lib/supabase/auth";
import { getCurrentMember } from "@/features/auth/members";

/** Where every OAuth sign-in lands. Exchanging the code proves an identity; the membership check
 *  immediately afterwards is what decides whether that identity may use this app.
 *
 *  A non-member is signed straight back out. Leaving the session in place would mean anyone with a
 *  Google account had a valid session for an app they were never invited to. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const origin = url.origin;

  if (!code) return NextResponse.redirect(`${origin}/login?error=1`);

  const auth = await createSessionClient();
  const { error } = await auth.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=1`);

  const member = await getCurrentMember();
  if (!member) {
    await auth.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=1`);
  }
  return NextResponse.redirect(`${origin}/`);
}
```

- [ ] **Step 2: Surface `?error=1` on the login page**

In `src/features/auth/LoginForm.tsx`, add to the imports:

```tsx
import { useSearchParams } from "next/navigation";
```

and inside the component, after `const [error, setError] = useState<string | null>(null);`:

```tsx
  // The callback route cannot pass a message through a redirect, so it sets a flag and the copy
  // lives here — one sentence, the same one every other refusal uses.
  const params = useSearchParams();
  const shown = error ?? (params.get("error") ? NOT_A_MEMBER : null);
```

Change the error block's condition from `error &&` to `shown &&` and its body from `{error}` to
`{shown}`. Add `NOT_A_MEMBER` to the existing import from `./members`.

Because `useSearchParams` requires a Suspense boundary during static rendering, change
`src/app/login/page.tsx` to:

```tsx
import { Suspense } from "react";
import { LoginForm } from "@/features/auth/LoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
```

- [ ] **Step 3: Turn off self-service sign-up**

In `supabase/config.toml`, change line 176 from `enable_signup = true` to `enable_signup = false`.

Leave the other two `enable_signup` occurrences alone — they belong to other config blocks.

Add, at the end of the file:

```toml
# Google and Microsoft. Supabase calls the Microsoft provider "azure".
# Secrets are read from the environment and MUST NOT be written here — this file is committed.
# Until these env vars exist the buttons explain themselves; see oauthUrlAction.
[auth.external.google]
enabled = true
client_id = "env(SUPABASE_AUTH_GOOGLE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_GOOGLE_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"

[auth.external.azure]
enabled = true
client_id = "env(SUPABASE_AUTH_AZURE_CLIENT_ID)"
secret = "env(SUPABASE_AUTH_AZURE_SECRET)"
redirect_uri = "http://127.0.0.1:54321/auth/v1/callback"
```

- [ ] **Step 4: Document the env vars without ever holding a value**

Create or append to `.env.local.example`:

```bash
# OAuth providers. Create these in Google Cloud Console and Azure app registrations, then put the
# real values in .env.local, which is gitignored. Leave them unset to run with password sign-in only
# — the Google and Microsoft buttons will say they are not configured.
SUPABASE_AUTH_GOOGLE_CLIENT_ID=
SUPABASE_AUTH_GOOGLE_SECRET=
SUPABASE_AUTH_AZURE_CLIENT_ID=
SUPABASE_AUTH_AZURE_SECRET=
```

Verify `.env.local` is gitignored:
```bash
git check-ignore -v .env.local
```
Expected: `.gitignore:3:.env*	.env.local` — already true in this repo, so this is a confirmation
rather than a change. If it ever prints nothing, stop and fix `.gitignore` before continuing.

- [ ] **Step 5: Create the user's auth user and member row**

This is the step that stops Task 7 locking them out. Run, substituting a password you then tell the
user:

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres <<'SQL'
insert into members (email, name) values ('reubenjsingh@gmail.com', 'Reuben Singh')
on conflict (email) do nothing;
SQL
```

Then create the matching auth user through the Auth API (the service role key is in the environment
Supabase printed at `supabase start`; read it from `.env.local` rather than pasting it anywhere):

```bash
curl -s -X POST "http://127.0.0.1:54321/auth/v1/admin/users" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"reubenjsingh@gmail.com","password":"REPLACE_ME","email_confirm":true}' | head -c 200
```

Expected: JSON containing an `"id"`. Tell the user the password you set; do not commit it anywhere.

- [ ] **Step 6: Verify sign-in end to end, BEFORE middleware exists**

With the dev server running on port 3100, open `http://localhost:3100/login`, sign in with that
email and password, and confirm you land on the dashboard.

Then confirm the gate works by proving the negative:

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "update members set disabled_at = now() where email='reubenjsingh@gmail.com';"
```
Sign out, try again: the sign-in must be refused with the standard message. Then re-enable:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "update members set disabled_at = null where email='reubenjsingh@gmail.com';"
```
and confirm sign-in works again.

- [ ] **Step 7: Typecheck and full safe suite**

Run:
```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'
```
Expected: no tsc output; every file passes.

- [ ] **Step 8: Commit**

```bash
git add src/app/auth src/app/login/page.tsx src/features/auth/LoginForm.tsx supabase/config.toml .env.local.example .gitignore
git commit -m "$(cat <<'MSG'
Add the OAuth callback and turn off self-service sign-up

Exchanging the code proves an identity; the membership check immediately
afterwards decides whether that identity may use this app. A non-member is
signed straight back out, because leaving the session would mean anyone with a
Google account held a valid session for an app they were never invited to.

enable_signup = false stops email self-registration but does NOT close the OAuth
door - completing a Google sign-in still mints an auth user. The gate is the
control; the flag is defence in depth.

Provider secrets are read from the environment and never written to config.toml,
which is committed.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 7: Middleware — close the door

**Files:**
- Create: `src/middleware.ts`
- Test: `src/middleware.test.ts`

**Interfaces:**
- Consumes: `@supabase/ssr`.
- Produces: every route protected except `/login`, `/auth/*` and static assets.

**Do not start this task until Task 6 step 6 has actually been performed and sign-in works.**

- [ ] **Step 1: Write the failing test**

Create `src/middleware.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isPublicPath } from "./middleware";

describe("isPublicPath", () => {
  it("lets an unauthenticated visitor reach the login page and the OAuth callback", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
  });

  it("protects everything else", () => {
    for (const p of ["/", "/clients", "/clients/URI/HQ", "/settings", "/settings/archive", "/device-library"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });

  it("does not let a lookalike path through", () => {
    // "/loginish" and "/auth-ish" must NOT be treated as the login routes.
    expect(isPublicPath("/loginish")).toBe(false);
    expect(isPublicPath("/authx/callback")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `./node_modules/.bin/vitest run src/middleware.test.ts`
Expected: FAIL — `Failed to resolve import "./middleware"`

- [ ] **Step 3: Write the middleware**

Create `src/middleware.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Routes an unauthenticated visitor may reach. Exact matches and one prefix, NOT startsWith on
 *  "/login" — that would also admit "/loginish". */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/auth/callback" || pathname.startsWith("/auth/");
}

/** Closes the app. Every route except the sign-in routes requires a session, and the intended
 *  destination is preserved so a redirected visitor lands where they were going.
 *
 *  This checks the SESSION only, not membership: the session cannot exist without having passed the
 *  membership gate at sign-in, and hitting the database on every request for every asset would be a
 *  poor trade. Server actions re-check membership properly via withMember. */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          // Refreshed tokens have to be written onto a NEW response or they are dropped.
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    }
  );

  const { data } = await supabase.auth.getUser();
  if (!data.user) {
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    to.searchParams.set("next", pathname);
    return NextResponse.redirect(to);
  }
  return response;
}

export const config = {
  // Everything except Next's own assets and the favicon. Images and fonts do not need a session
  // check on every request, and running one would make every page load slower for no gain.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `./node_modules/.bin/vitest run src/middleware.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Verify in the browser — this is the moment the app closes**

With the dev server running:
1. Open a private window and go to `http://localhost:3100/clients`. Expect a redirect to
   `/login?next=%2Fclients`.
2. Sign in. Expect to land on the app.
3. In the normal window, confirm you are still signed in and can use the app.

If step 1 does not redirect, stop and fix before committing — a middleware that silently admits
everyone is worse than none, because it looks like protection.

- [ ] **Step 6: Typecheck and full safe suite**

Run:
```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'
```
Expected: no tsc output; every file passes.

- [ ] **Step 7: Commit**

```bash
git add src/middleware.ts src/middleware.test.ts
git commit -m "$(cat <<'MSG'
Protect every route behind a session

The app was entirely public until now. Everything except the sign-in routes
requires a session, and the intended destination is preserved so a redirected
visitor lands where they were going.

isPublicPath matches exactly rather than by prefix, so "/loginish" is not
admitted as the login page.

The middleware checks the session only, not membership: a session cannot exist
without having passed the membership gate at sign-in, and hitting the database
for every request would be a poor trade. Server actions re-check properly via
withMember.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 8: Guard the client and location actions

**Files:**
- Modify: `src/features/clients/actions.ts` (31 actions)
- Modify: `src/features/locations/actions.ts` (1 action)
- Modify: `src/features/clients/actions.test.ts`, `src/features/clients/archiveActions.test.ts`, `src/features/clients/floorActions.test.ts`, `src/features/clients/planActions.test.ts`, `src/features/clients/placementActions.test.ts`

**Interfaces:**
- Consumes: Task 4's `withMember`.
- Produces: every exported action in those two files wrapped, with identical external signatures.

- [ ] **Step 1: Wrap one action and prove the shape works**

In `src/features/clients/actions.ts`, add the import:

```ts
import { withMember } from "@/features/auth/withMember";
```

Convert `createClientAction` from:

```ts
export async function createClientAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
```

to:

```ts
export const createClientAction = withMember(async (_member, formData: FormData): Promise<{ ok: boolean; error?: string }> => {
```

closing the function with `});` instead of `}`. The exported name, its argument list and its return
type are unchanged, so no caller changes.

Name the parameter `_member` where the action does not use it — every action gets the member whether
it needs one or not, and the underscore records that this one does not.

- [ ] **Step 2: Make the existing tests pass again**

The action tests mock `@/lib/supabase/server` but not the membership lookup, so every wrapped action
will now refuse. Add to each affected test file, alongside the existing `vi.mock` calls:

```ts
vi.mock("@/features/auth/withMember", () => ({
  // The guard is tested on its own in withMember.test.ts. Here it must be transparent, or every
  // action test would be re-testing the guard instead of the action.
  withMember: (fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
}));
```

Run: `./node_modules/.bin/vitest run src/features/clients/actions.test.ts`
Expected: PASS with the same count as before the change.

- [ ] **Step 3: Convert the remaining 30 actions in `clients/actions.ts`**

Apply the same transformation to every other `export async function …Action(` in the file. After
converting, verify none were missed:

```bash
command grep -c "^export async function .*Action" src/features/clients/actions.ts
```
Expected: `0`

```bash
command grep -c "^export const .*Action = withMember" src/features/clients/actions.ts
```
Expected: `31`

- [ ] **Step 4: Convert `locations/actions.ts`**

Same transformation for its single action. Verify:

```bash
command grep -c "^export const .*Action = withMember" src/features/locations/actions.ts
```
Expected: `1`

- [ ] **Step 5: Run every affected test file**

Run:
```bash
./node_modules/.bin/vitest run src/features/clients/actions.test.ts src/features/clients/archiveActions.test.ts src/features/clients/floorActions.test.ts src/features/clients/planActions.test.ts src/features/clients/placementActions.test.ts
```
Expected: all pass, with the same test counts as before this task.

- [ ] **Step 6: Typecheck and full safe suite**

Run:
```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'
```
Expected: no tsc output; every file passes.

- [ ] **Step 7: Commit**

```bash
git add src/features/clients src/features/locations
git commit -m "$(cat <<'MSG'
Guard the client and location actions with withMember

32 actions, same exported names, same arguments, same return types - the guard
wraps rather than changes them, so no caller moves.

The action tests mock the guard transparently: it has its own tests, and leaving
it live here would mean every action test re-tested the guard instead of the
action.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 9: Guard the remaining actions

**Files:**
- Modify: `src/features/clients/discoverActions.ts` (2), `src/features/clients/planExtractActions.ts` (1), `src/features/clients/symbolActions.ts` (2), `src/features/device-library/actions.ts` (8), `src/features/device-library/ai/actions.ts` (2), `src/features/device-library/typeActions.ts` (3), `src/features/racks/actions.ts` (4)
- Modify: their existing test files

**Interfaces:**
- Consumes: Task 4's `withMember`.
- Produces: all 22 remaining actions guarded.

- [ ] **Step 1: Convert each file**

Apply the transformation from Task 8 step 1 to every exported action in the seven files listed
above. Several of these do **not** return `{ ok, error }` — `discoverRoomsAction`,
`discoverDevicesAction`, `detectPortsAction`, `saveRackLayoutAction`, `saveEndpointsAction`,
`updateRackAction`, `saveNewDeviceTemplateAction`, `duplicateDeviceTemplateAction`. `withMember` is
generic over the return type, so they wrap unchanged; their callers must already handle the
`{ ok: false, error }` refusal shape, so check each caller and add that branch where it is missing.

- [ ] **Step 2: Add the transparent guard mock to each affected test file**

The same block as Task 8 step 2:

```ts
vi.mock("@/features/auth/withMember", () => ({
  withMember: (fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
}));
```

- [ ] **Step 3: Verify no action anywhere is left unguarded**

Run:
```bash
command grep -rn "^export async function .*Action" src/features --include=*.ts | command grep -v "authActions.ts"
```
Expected: no output. `authActions.ts` is the deliberate exception — sign-in cannot require being
signed in.

- [ ] **Step 4: Full safe suite and typecheck**

Run:
```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'
```
Expected: no tsc output; every file passes.

- [ ] **Step 5: Commit**

```bash
git add src/features
git commit -m "$(cat <<'MSG'
Guard the remaining 22 actions

Device library, racks, discovery, symbol search and plan extraction. Several do
not return the {ok,error} shape; withMember is generic over the return type, so
they wrap unchanged, and their callers gained the refusal branch where it was
missing.

authActions is the one deliberate exception: signing in cannot require being
signed in.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

### Task 10: Sign out, and live verification

**Files:**
- Modify: `src/features/shell/AppSidebar.tsx`

**Interfaces:**
- Consumes: Task 5's `signOutAction`, Task 3's `getCurrentMember`.
- Produces: a sign-out control, and evidence the slice works.

- [ ] **Step 1: Show who is signed in, and let them out**

`src/features/shell/AppSidebar.tsx:11` reads `const USER = { name: "Reuben Singh" };` and the block
at the bottom renders it. Replace that constant with the signed-in member's name and add a sign-out control
beside it, calling `signOutAction`.

Because `AppSidebar` is a client component and `getCurrentMember` is server-only, pass the member's
name down: read it in `src/app/layout.tsx` (a server component) and hand it to `AppShell` as a prop,
which passes it to `AppSidebar`. A null name means no session, which only happens on the auth routes
where the shell is not rendered anyway.

- [ ] **Step 2: Verify the whole slice in the browser**

1. Private window → `http://localhost:3100/` redirects to `/login`.
2. Sign in with the seeded password → lands on the dashboard, sidebar shows the member's name.
3. Navigate to `/clients`, open a client, confirm the app works exactly as before.
4. Perform one mutation (rename a site) and confirm it succeeds — this proves `withMember` passes
   real actions through rather than refusing them.
5. Sign out → back to `/login`, and `/clients` redirects again.
6. Disable the member in SQL, sign in again, confirm the refusal message, then re-enable.

- [ ] **Step 3: Confirm the user's data is untouched**

Run:
```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -t -A -F'|' -c "select (select count(*) from clients), (select count(*) from sites), (select count(*) from rooms), (select count(plan_polygon) from rooms), (select count(*) from floor_devices), (select count(*) from floor_plans);"
```
Expected: `3|31|11|9|19|2` — three client rows (one archived), 31 sites, 11 rooms of which 9 are
outlined, 19 floor devices, 2 floor plans.

- [ ] **Step 4: Record the outcome in the ledger**

Append to `.superpowers/sdd/progress.md` (gitignored) what was verified, including the refusal test.

- [ ] **Step 5: Commit**

```bash
git add src/features/shell src/app/layout.tsx
git commit -m "$(cat <<'MSG'
Show the signed-in member and add sign out

The sidebar's user block showed a hardcoded name; it now shows whoever is signed
in, with a way out beside it. The name is read in the server layout and passed
down, because getCurrentMember is server-only and the sidebar is a client
component.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
)"
```

---

## Self-Review

**Spec coverage.** §3 members table → Task 1; the membership gate → Tasks 2, 5, 6. §4 components: migration T1, auth config T6, session client T3, membership T2/T3, middleware T7, login T5, callback T6, `withMember` T4. §5 the wrapper and its 54 conversions → T4 (the wrapper), T8 and T9 (the conversions). §6 build order → enforced by task order, with T7 carrying an explicit do-not-start-early instruction. §7 testing: pure T2, wrapper T4, middleware T7, live T6 step 6 and T10 step 2.

**One spec item made concrete here rather than left implicit:** the spec says provider credentials are the user's to create. The plan pins that down as `env()` references in `config.toml` plus a `.env.local.example`, with a check that `.env.local` is gitignored, so no secret can reach a tracked file.

**Placeholders:** none. Task 8 step 3 and Task 9 step 1 describe a mechanical transformation across many functions rather than pasting 53 near-identical diffs; both give the exact before/after shape and a grep that proves completeness, which is verifiable in a way a wall of repeated code would not be.

**Type consistency:** `Member` is defined in Task 2 and used unchanged in Tasks 3, 4, 8, 9. `withMember`'s signature in Task 4 matches its use in Tasks 8 and 9, including the `_member` first parameter. `getCurrentMember` returns `Member | null` in Task 3 and is consumed as such in Tasks 4, 5, 6 and 10. `NOT_A_MEMBER` is one exported constant used by Tasks 4, 5 and 6, so the refusal wording cannot drift.

**Known risk the plan does not remove:** Task 8 and Task 9 convert 53 actions mechanically. The grep counts prove every action is wrapped, but they cannot prove each conversion kept its body intact. The full safe suite is the real check, which is why both tasks run it before committing.
