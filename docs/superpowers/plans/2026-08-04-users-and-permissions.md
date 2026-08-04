# Users & Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/users` screen where an admin invites, revokes and re-roles members, and three roles that decide what a member may change.

**Architecture:** One `role` column on `members`, ordered `admin > editor > viewer`. Enforcement lives in two wrappers built on the existing `withMember` seam, so all 54 server actions get a role check by changing which wrapper they use rather than by editing 54 bodies. Pure rules (ordering, the last-admin invariant) are separated so they can be tested without a database.

**Tech Stack:** Next.js 16 (app router, server actions), TypeScript strict, Supabase (local via Docker), Vitest + @testing-library/react, Tailwind, @iconify/react.

**Spec:** `docs/superpowers/specs/2026-08-04-users-and-permissions-design.md`

## Global Constraints

- **NEVER run vitest against a directory, a glob, or an empty file list.** Files named `*.integration.test.ts` WIPE THE LOCAL DATABASE, which holds real data. Run named files only, or: `./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'`
- Typecheck with `./node_modules/.bin/tsc --noEmit`. Bare `npx tsc` is the wrong package. **The branch must be tsc-clean at every commit** — do not leave it red for a later task.
- Use `command grep`, not bare `grep`. Quote globs: `--include='*.ts'`.
- Piping SQL into psql REQUIRES `docker exec -i`. Container: `supabase_db_network-doc-platform`.
- Every migration ends with the three blanket grants from `0001_location_hierarchy.sql`'s tail, byte-identical, **and then re-applies the narrowings** — read `supabase/migrations/0024_claim_phone_verification.sql` and copy its whole tail. The blanket grant would otherwise re-expose `members` PII and the verification table to the anon key. Latest migration is 0024.
- **Postgres grants EXECUTE on new functions to PUBLIC.** Revoking from `anon, authenticated` alone does nothing — revoke from `public` first. (Learned the hard way in 0024.)
- NEVER put a real secret in a git-tracked file. Never write a live password into a plan, a doc or a test.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Every exported function in a `"use server"` module is a remotely invocable endpoint and MUST be wrapped in `withMember`, `withEditor` or `withAdmin`.
- Forms use `onSubmit` + `e.preventDefault()` + `new FormData(e.currentTarget)`, NEVER `<form action={fn}>` — React 19 resets uncontrolled inputs when the action settles, discarding what the user typed on a failed save.

---

### Task 1: Migration — the role column

**Files:**
- Create: `supabase/migrations/0025_member_roles.sql`

- [ ] **Step 1: Read the tail you must copy**

Run `tail -12 supabase/migrations/0024_claim_phone_verification.sql`. Copy its grant-and-narrow tail
verbatim into your migration; it re-applies everything 0020, 0022 and 0023 established.

- [ ] **Step 2: Write the migration**

Create `supabase/migrations/0025_member_roles.sql`:

```sql
-- Roles. admin > editor > viewer; a requirement is a MINIMUM, so an admin satisfies every editor
-- check without being enumerated separately.
alter table members
  add column role text not null default 'viewer'
    check (role in ('admin', 'editor', 'viewer'));

-- Everyone who exists today has had unlimited power since before roles existed. Defaulting them to
-- 'viewer' would silently strip the owner of their own app the moment this runs, and the screen that
-- could fix it is admin-only — so the lockout would need psql to undo. Grandfather them to the
-- access they already have. NEW members still default to 'viewer', which is the safe direction.
update members set role = 'admin';
```

then the tail copied from 0024 in Step 1, unchanged.

- [ ] **Step 3: Apply it**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres < supabase/migrations/0025_member_roles.sql
```

- [ ] **Step 4: Verify — five probes**

```bash
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "select email, role from members;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "insert into members (email, name, role) values ('bad@x.test','Bad','superuser');"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select role from members;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select disabled_at from members;"
docker exec -i supabase_db_network-doc-platform psql -U postgres -d postgres -c "set role anon; select * from phone_verifications;"
```
Expected, in order: the existing member with role `admin`; the insert **FAILS** on the check
constraint; **permission denied**; **succeeds**; **permission denied**. Any deviation means the
tail is wrong — fix before continuing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0025_member_roles.sql
git commit -m "Add member roles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pure role rules

**Files:**
- Create: `src/features/auth/roles.ts`
- Test: `src/features/auth/roles.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Role = "admin" | "editor" | "viewer";
  export const ROLES: readonly Role[];
  export function isRole(value: unknown): value is Role;
  export function satisfies(actual: Role, required: Role): boolean;
  export function roleLabel(role: Role): string;
  export interface AdminCount { role: Role; disabledAt: string | null }
  export function wouldLeaveNoAdmin(members: AdminCount[], change: { from: Role; to: Role | "revoked" }): boolean;
  export const NEEDS_EDITOR: string;
  export const NEEDS_ADMIN: string;
  export const LAST_ADMIN: string;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/features/auth/roles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isRole, satisfies, wouldLeaveNoAdmin, ROLES, type Role } from "./roles";

describe("isRole", () => {
  it("accepts the three real roles and nothing else", () => {
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    for (const junk of ["superuser", "", "Admin", null, undefined, 7]) {
      expect(isRole(junk)).toBe(false);
    }
  });
});

describe("satisfies", () => {
  it("treats a requirement as a MINIMUM, so an admin passes an editor check", () => {
    expect(satisfies("admin", "editor")).toBe(true);
    expect(satisfies("admin", "viewer")).toBe(true);
    expect(satisfies("editor", "viewer")).toBe(true);
  });

  it("lets each role satisfy its own requirement", () => {
    for (const r of ROLES) expect(satisfies(r, r)).toBe(true);
  });

  it("refuses to promote anyone upward", () => {
    expect(satisfies("viewer", "editor")).toBe(false);
    expect(satisfies("viewer", "admin")).toBe(false);
    expect(satisfies("editor", "admin")).toBe(false);
  });
});

describe("wouldLeaveNoAdmin", () => {
  const active = (role: Role) => ({ role, disabledAt: null });
  const revoked = (role: Role) => ({ role, disabledAt: "2026-01-01T00:00:00Z" });

  it("blocks demoting the only admin", () => {
    expect(wouldLeaveNoAdmin([active("admin"), active("editor")], { from: "admin", to: "editor" })).toBe(true);
  });

  it("blocks revoking the only admin", () => {
    expect(wouldLeaveNoAdmin([active("admin")], { from: "admin", to: "revoked" })).toBe(true);
  });

  it("allows it when a second ACTIVE admin remains", () => {
    expect(wouldLeaveNoAdmin([active("admin"), active("admin")], { from: "admin", to: "editor" })).toBe(false);
  });

  it("does not count a REVOKED admin as cover — they cannot sign in to fix anything", () => {
    expect(wouldLeaveNoAdmin([active("admin"), revoked("admin")], { from: "admin", to: "viewer" })).toBe(true);
  });

  it("does not care when the person changing is not an admin", () => {
    expect(wouldLeaveNoAdmin([active("admin"), active("editor")], { from: "editor", to: "viewer" })).toBe(false);
    expect(wouldLeaveNoAdmin([active("admin"), active("viewer")], { from: "viewer", to: "revoked" })).toBe(false);
  });

  it("allows promoting someone TO admin, which can never reduce the count", () => {
    expect(wouldLeaveNoAdmin([active("admin"), active("editor")], { from: "editor", to: "admin" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `./node_modules/.bin/vitest run src/features/auth/roles.test.ts`
Expected: FAIL — cannot resolve `./roles`.

- [ ] **Step 3: Write the implementation**

Create `src/features/auth/roles.ts`:

```ts
/** Roles, kept PURE — no database, no session. The ordering and the last-admin invariant are the
 *  only real logic in this slice, and they are the two things that must not be wrong. */

export type Role = "admin" | "editor" | "viewer";

/** Most-privileged first. The index IS the rank. */
export const ROLES = ["admin", "editor", "viewer"] as const satisfies readonly Role[];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** A requirement is a MINIMUM: an admin satisfies an editor check. Lower index = more power. */
export function satisfies(actual: Role, required: Role): boolean {
  return ROLES.indexOf(actual) <= ROLES.indexOf(required);
}

export function roleLabel(role: Role): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export interface AdminCount {
  role: Role;
  disabledAt: string | null;
}

/** Would this change leave the company with nobody who can administer it?
 *
 *  Only ACTIVE admins count. A revoked admin cannot sign in, so they cannot restore anyone — leaving
 *  one of those as the sole "admin" is the same as leaving none, and the only way out would be psql.
 *
 *  `members` must be the full current list read at write time, not what a screen was showing: two
 *  admins demoting each other from two browsers both believe there are two. */
export function wouldLeaveNoAdmin(
  members: AdminCount[],
  change: { from: Role; to: Role | "revoked" }
): boolean {
  // Changing a non-admin cannot reduce the admin count, and neither can promoting someone to admin.
  if (change.from !== "admin") return false;
  if (change.to === "admin") return false;
  const activeAdmins = members.filter((m) => m.role === "admin" && m.disabledAt === null).length;
  return activeAdmins <= 1;
}

/** Specific on purpose. The generic NOT_A_MEMBER copy exists so an outsider cannot learn which
 *  addresses are real; someone already signed in and looking at their own team's app learns nothing
 *  from being told why they were refused, and a vaguer message just generates a support ticket. */
export const NEEDS_EDITOR = "You need editor access to change this.";
export const NEEDS_ADMIN = "You need admin access to do that.";
export const LAST_ADMIN = "There has to be at least one active admin.";
```

- [ ] **Step 4: Run the tests**

Run: `./node_modules/.bin/vitest run src/features/auth/roles.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
./node_modules/.bin/tsc --noEmit
git add src/features/auth/roles.ts src/features/auth/roles.test.ts
git commit -m "Add pure role rules and the last-admin invariant

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The role guards

**Files:**
- Modify: `src/features/auth/members.ts` (carry `role` on `Member`)
- Modify: `src/features/auth/withMember.ts` (add `withEditor`, `withAdmin`)
- Test: `src/features/auth/withRole.test.ts`
- Modify: `src/features/auth/members.test.ts`, `withMember.test.ts`, `authActions.test.ts` (fixtures gain `role`)

**Interfaces:**
- Produces:
  ```ts
  export function withEditor<A extends unknown[], R>(action: (member: Member, ...args: A) => Promise<R>): (...args: A) => Promise<R | { ok: false; error: string }>;
  export function withAdmin<A extends unknown[], R>(action: (member: Member, ...args: A) => Promise<R>): (...args: A) => Promise<R | { ok: false; error: string }>;
  ```
  `Member` gains `role: Role`.

- [ ] **Step 1: Carry the role on Member**

In `src/features/auth/members.ts`: add `role: Role` to the `Member` interface (importing the type
from `./roles`), add `role` to `getCurrentMember`'s `.select(...)`, and map it:

```ts
        role: isRole(data.role) ? data.role : "viewer",
```

Fall back to `viewer`, not `admin`: an unrecognised value in that column means something is wrong,
and the safe direction when you do not know someone's access is *less*.

- [ ] **Step 2: Write the failing guard test**

Create `src/features/auth/withRole.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "./roles";

vi.mock("./members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./members")>();
  return { ...actual, getCurrentMember: vi.fn() };
});

import { getCurrentMember, type Member } from "./members";
import { withEditor, withAdmin } from "./withMember";
import { NEEDS_EDITOR, NEEDS_ADMIN } from "./roles";

const member = (role: Role): Member => ({
  id: "m1", email: "bob@example.com", name: "Bob",
  authUserId: "au1", disabledAt: null, avatarPath: null, role,
});

beforeEach(() => { vi.clearAllMocks(); });

describe("withEditor", () => {
  it("NEVER calls the action for a viewer — refusing after the write would be no guard at all", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("viewer"));
    const inner = vi.fn(async () => ({ ok: true as const }));
    const res = await withEditor(inner)();
    expect(inner).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: NEEDS_EDITOR });
  });

  it("runs for an editor, and hands them to the action", async () => {
    const m = member("editor");
    vi.mocked(getCurrentMember).mockResolvedValue(m);
    const inner = vi.fn(async (who: Member) => ({ ok: true as const, who }));
    const res = await withEditor(inner)();
    expect(inner).toHaveBeenCalledWith(m);
    expect(res).toEqual({ ok: true, who: m });
  });

  it("runs for an admin, because a requirement is a minimum", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("admin"));
    const inner = vi.fn(async () => ({ ok: true as const }));
    await withEditor(inner)();
    expect(inner).toHaveBeenCalled();
  });
});

describe("withAdmin", () => {
  it("NEVER calls the action for an editor", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("editor"));
    const inner = vi.fn(async () => ({ ok: true as const }));
    const res = await withAdmin(inner)();
    expect(inner).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: NEEDS_ADMIN });
  });

  it("runs for an admin", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("admin"));
    const inner = vi.fn(async () => ({ ok: true as const }));
    await withAdmin(inner)();
    expect(inner).toHaveBeenCalled();
  });
});

describe("both guards", () => {
  it("still refuse when there is no member at all, before any role is considered", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(null);
    const inner = vi.fn(async () => ({ ok: true as const }));
    expect((await withEditor(inner)()).ok).toBe(false);
    expect((await withAdmin(inner)()).ok).toBe(false);
    expect(inner).not.toHaveBeenCalled();
  });

  it("passes the original arguments through untouched", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("admin"));
    const inner = vi.fn(async (_m: Member, a: string, b: number) => ({ ok: true as const, a, b }));
    const res = await withAdmin(inner)("x", 2);
    expect(res).toEqual({ ok: true, a: "x", b: 2 });
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `./node_modules/.bin/vitest run src/features/auth/withRole.test.ts`
Expected: FAIL — `withEditor` is not exported.

- [ ] **Step 4: Implement the guards**

Append to `src/features/auth/withMember.ts`:

```ts
import { satisfies, NEEDS_EDITOR, NEEDS_ADMIN, type Role } from "./roles";

/** The same guard as withMember, plus a minimum role. Built on withMember rather than beside it, so
 *  there is still exactly ONE place that resolves the acting member — a second lookup is a second
 *  thing to get wrong. */
function withRole<A extends unknown[], R>(
  required: Role,
  refusal: string,
  action: (member: Member, ...args: A) => Promise<R>
): (...args: A) => Promise<R | { ok: false; error: string }> {
  return withMember(async (member, ...args: A) => {
    // Checked BEFORE the action runs, never after: a guard that refuses once the write has already
    // happened is not a guard.
    if (!satisfies(member.role, required)) return { ok: false as const, error: refusal };
    return action(member, ...args);
  });
}

export function withEditor<A extends unknown[], R>(
  action: (member: Member, ...args: A) => Promise<R>
) {
  return withRole<A, R>("editor", NEEDS_EDITOR, action);
}

export function withAdmin<A extends unknown[], R>(
  action: (member: Member, ...args: A) => Promise<R>
) {
  return withRole<A, R>("admin", NEEDS_ADMIN, action);
}
```

- [ ] **Step 5: Fix the fixtures**

`Member` now requires `role`. Add `role: "admin"` to the member fixtures in
`src/features/auth/members.test.ts`, `withMember.test.ts`, `authActions.test.ts` and
`src/features/profile/phoneActions.test.ts` / `actions.test.ts` — anywhere `tsc` reports a missing
property. Use `admin` so existing tests keep exercising the same paths they always did.

- [ ] **Step 6: Run everything affected**

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run src/features/auth/withRole.test.ts src/features/auth/withMember.test.ts src/features/auth/members.test.ts src/features/auth/roles.test.ts src/features/auth/authActions.test.ts
```
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/auth src/features/profile
git commit -m "Add withEditor and withAdmin guards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Apply the guards to all 54 actions

**Files:**
- Modify: `src/features/clients/actions.ts`, `discoverActions.ts`, `planExtractActions.ts`, `symbolActions.ts`
- Modify: `src/features/locations/actions.ts`, `src/features/racks/actions.ts`
- Modify: `src/features/device-library/actions.ts`, `ai/actions.ts`, `typeActions.ts`
- Modify: `src/features/settings/actions.ts`, `src/features/profile/actions.ts`

**THE TRIAGE, exactly. Anything not named here is `withEditor`.**

Stay `withMember` (any active member, genuinely free reads):
- `listTemplatesForTypeAction`, `getDeviceTemplateAction` (device-library/actions.ts)
- every action in `src/features/profile/actions.ts` — a Viewer must still edit their OWN profile and change their OWN password

Become `withAdmin`:
- `updateDeviceWizardSettings` (settings/actions.ts) — it holds the Gemini key

Become `withEditor` — everything else, including all six AI actions
(`discoverRoomsAction`, `discoverDevicesAction`, `discoverSymbolsAction`, `extractPlanGeometryAction`,
`detectPortsAction`, `identifyDeviceAction`). They write nothing, but each call spends Gemini quota
the company pays for, and a role that can run up a bill is not read-only.

- [ ] **Step 1: Convert, file by file**

Replace `withMember(` with `withEditor(` (or `withAdmin(`) per the triage, and add the import. The
wrapped function bodies do not change at all — same signature, same arguments, same returns.

- [ ] **Step 2: Prove completeness**

```bash
for f in $(command grep -rl '"use server"' src --include='*.ts' --include='*.tsx'); do
  echo "--- $f"; command grep -nE "^export (async function|const) [a-zA-Z]+" "$f"
done
```
Paste the whole output. Every exported function must be `withMember`, `withEditor` or `withAdmin`,
except the three deliberate exceptions in `src/features/auth/authActions.ts`
(`signInWithPasswordAction`, `signOutAction`, `oauthUrlAction`) — signing in and out must work for
someone who is not yet, or no longer, a member.

Then confirm the counts:
```bash
command grep -rc "= withEditor(" src --include='*.ts' | command grep -v ":0"
command grep -rc "= withAdmin(" src --include='*.ts' | command grep -v ":0"
command grep -rc "= withMember(" src --include='*.ts' | command grep -v ":0"
```

- [ ] **Step 3: Run every affected test file, then the full suite**

The action tests mock `withMember` transparently; they will need `withEditor`/`withAdmin` mocked the
same way. Find every test file that mocks the wrapper and extend it:
```bash
command grep -rln "withMember" src --include='*.test.ts' --include='*.test.tsx'
```

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --exclude '**/node_modules/**' --exclude 'e2e/**' --exclude '**/*.integration.test.ts'
```

- [ ] **Step 4: Commit**

```bash
git add src/features
git commit -m "Gate every action behind a role

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: The members repository and admin actions

**Files:**
- Create: `src/features/users/repository.ts`
- Create: `src/features/users/actions.ts`
- Test: `src/features/users/actions.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // repository.ts
  export interface MemberRow { id, email, name: string; role: Role; disabledAt: string | null; authUserId: string | null; invitedAt: string; lastSignInAt: string | null }
  export async function listMembers(db): Promise<MemberRow[]>;
  export async function listRolesForInvariant(db): Promise<{ role: Role; disabledAt: string | null }[]>;
  export async function insertMember(db, email: string, name: string, role: Role): Promise<void>;
  export async function updateMemberRole(db, id: string, role: Role): Promise<void>;
  export async function setMemberDisabled(db, id: string, disabled: boolean): Promise<void>;
  export async function findMemberById(db, id: string): Promise<MemberRow | null>;

  // actions.ts
  export const inviteMemberAction:  (formData: FormData) => Promise<{ ok: boolean; error?: string; warning?: string }>;
  export const setMemberRoleAction: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
  export const setMemberActiveAction: (formData: FormData) => Promise<{ ok: boolean; error?: string }>;
  ```
  `lastSignInAt` comes from `auth.users.last_sign_in_at`, joined on `auth_user_id`.

- [ ] **Step 1: Write the failing test**

Create `src/features/users/actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const ME = {
  id: "me", email: "me@example.com", name: "Me",
  authUserId: "au-me", disabledAt: null, avatarPath: null, role: "admin" as const,
};

// withAdmin is replaced by a transparent wrapper injecting OUR member. The guard itself is tested in
// withRole.test.ts; here we test what the actions DO with the member they are handed.
vi.mock("@/features/auth/withMember", () => ({
  withMember: (fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
  withAdmin: (fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
  withEditor: (fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
}));
const db = {};
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const inviteUserByEmail = vi.fn();
vi.mock("@/features/users/invite", () => ({ inviteUserByEmail: (...a: unknown[]) => inviteUserByEmail(...a) }));

vi.mock("./repository", () => ({
  listMembers: vi.fn(),
  listRolesForInvariant: vi.fn(),
  insertMember: vi.fn(),
  updateMemberRole: vi.fn(),
  setMemberDisabled: vi.fn(),
  findMemberById: vi.fn(),
}));

import {
  listRolesForInvariant, insertMember, updateMemberRole, setMemberDisabled, findMemberById,
} from "./repository";
import { inviteMemberAction, setMemberRoleAction, setMemberActiveAction } from "./actions";
import { LAST_ADMIN } from "@/features/auth/roles";

function form(e: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(e)) fd.set(k, v);
  return fd;
}

const other = {
  id: "other", email: "other@example.com", name: "Other", role: "editor" as const,
  disabledAt: null, authUserId: "au-o", invitedAt: "2026-01-01", lastSignInAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findMemberById).mockResolvedValue(other);
  vi.mocked(listRolesForInvariant).mockResolvedValue([
    { role: "admin", disabledAt: null }, { role: "editor", disabledAt: null },
  ]);
  inviteUserByEmail.mockResolvedValue({ sent: true });
});

describe("inviteMemberAction", () => {
  it("stores the email normalised, so a capitalised invite still matches at sign-in", async () => {
    const res = await inviteMemberAction(form({ email: "  New.Person@Example.COM ", name: "New", role: "editor" }));
    expect(res.ok).toBe(true);
    expect(insertMember).toHaveBeenCalledWith(db, "new.person@example.com", "New", "editor");
  });

  it("refuses a role that is not one of the three", async () => {
    const res = await inviteMemberAction(form({ email: "a@b.co", name: "A", role: "superuser" }));
    expect(res.ok).toBe(false);
    expect(insertMember).not.toHaveBeenCalled();
  });

  it("refuses a blank email", async () => {
    const res = await inviteMemberAction(form({ email: "  ", name: "A", role: "viewer" }));
    expect(res.ok).toBe(false);
    expect(insertMember).not.toHaveBeenCalled();
  });

  it("still counts as invited when the email cannot be sent, and says so", async () => {
    // The row is what grants access; the email is only a convenience. Failing the whole invite
    // because SMTP is unconfigured would make the screen useless until it is.
    inviteUserByEmail.mockResolvedValue({ sent: false, reason: "SMTP not configured" });
    const res = await inviteMemberAction(form({ email: "a@b.co", name: "A", role: "viewer" }));
    expect(res.ok).toBe(true);
    expect(insertMember).toHaveBeenCalled();
    expect(res.warning).toMatch(/email/i);
  });
});

describe("setMemberRoleAction", () => {
  it("changes someone else's role", async () => {
    const res = await setMemberRoleAction(form({ id: "other", role: "admin" }));
    expect(res.ok).toBe(true);
    expect(updateMemberRole).toHaveBeenCalledWith(db, "other", "admin");
  });

  it("refuses to change YOUR OWN role", async () => {
    const res = await setMemberRoleAction(form({ id: ME.id, role: "viewer" }));
    expect(res.ok).toBe(false);
    expect(updateMemberRole).not.toHaveBeenCalled();
  });

  it("refuses to demote the last active admin", async () => {
    vi.mocked(findMemberById).mockResolvedValue({ ...other, role: "admin" });
    vi.mocked(listRolesForInvariant).mockResolvedValue([
      { role: "admin", disabledAt: null }, { role: "editor", disabledAt: null },
    ]);
    const res = await setMemberRoleAction(form({ id: "other", role: "editor" }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(LAST_ADMIN);
    expect(updateMemberRole).not.toHaveBeenCalled();
  });

  it("checks the invariant against the DATABASE, not against what the screen showed", async () => {
    await setMemberRoleAction(form({ id: "other", role: "viewer" }));
    expect(listRolesForInvariant).toHaveBeenCalled();
  });
});

describe("setMemberActiveAction", () => {
  it("revokes someone else", async () => {
    const res = await setMemberActiveAction(form({ id: "other", active: "false" }));
    expect(res.ok).toBe(true);
    expect(setMemberDisabled).toHaveBeenCalledWith(db, "other", true);
  });

  it("refuses to revoke YOURSELF — the next request would sign you out of an app you cannot re-enter", async () => {
    const res = await setMemberActiveAction(form({ id: ME.id, active: "false" }));
    expect(res.ok).toBe(false);
    expect(setMemberDisabled).not.toHaveBeenCalled();
  });

  it("refuses to revoke the last active admin", async () => {
    vi.mocked(findMemberById).mockResolvedValue({ ...other, role: "admin" });
    const res = await setMemberActiveAction(form({ id: "other", active: "false" }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(LAST_ADMIN);
    expect(setMemberDisabled).not.toHaveBeenCalled();
  });

  it("restoring is never blocked by the invariant — it can only ADD an admin", async () => {
    vi.mocked(findMemberById).mockResolvedValue({ ...other, role: "admin", disabledAt: "2026-01-01" });
    const res = await setMemberActiveAction(form({ id: "other", active: "true" }));
    expect(res.ok).toBe(true);
    expect(setMemberDisabled).toHaveBeenCalledWith(db, "other", false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `./node_modules/.bin/vitest run src/features/users/actions.test.ts`
Expected: FAIL — cannot resolve `./actions`.

- [ ] **Step 3: Write `src/features/users/invite.ts`**

```ts
import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Supabase's admin invite, behind one thin wrapper so the action tests can fake it.
 *
 *  Locally the message lands in Inbucket, which this stack already runs. In production it needs SMTP,
 *  which is not configured — so this NEVER throws: it reports whether it sent, and the caller treats
 *  a failure as a warning rather than a failed invite. The members row is what grants access; the
 *  email is only a convenience for setting a password. */
export async function inviteUserByEmail(email: string): Promise<{ sent: boolean; reason?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { sent: false, reason: "Supabase admin credentials are not configured" };
  try {
    const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await admin.auth.admin.inviteUserByEmail(email);
    if (error) return { sent: false, reason: error.message };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : "unknown" };
  }
}
```

- [ ] **Step 4: Write `src/features/users/repository.ts`**

`import "server-only"`, house error style (`functionName: message`). `listMembers` selects
`id, email, name, role, disabled_at, auth_user_id, invited_at` from `members`; join
`auth.users.last_sign_in_at` via a second query keyed on the collected `auth_user_id`s rather than a
PostgREST join, because `auth.users` is not exposed through the REST schema. Map to `MemberRow`,
falling back to `"viewer"` for an unrecognised role. Sort by name, then email.

- [ ] **Step 5: Write `src/features/users/actions.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/server";
import { withAdmin } from "@/features/auth/withMember";
import { normaliseEmail } from "@/features/auth/members";
import { isRole, wouldLeaveNoAdmin, LAST_ADMIN, type Role } from "@/features/auth/roles";
import {
  listRolesForInvariant, insertMember, updateMemberRole, setMemberDisabled, findMemberById,
} from "./repository";
import { inviteUserByEmail } from "./invite";

export const inviteMemberAction = withAdmin(async (_admin, formData: FormData) => {
  const email = normaliseEmail(String(formData.get("email") ?? ""));
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  if (!email) return { ok: false, error: "Enter an email address." };
  if (!isRole(role)) return { ok: false, error: "Choose a role." };

  const db = createServiceClient();
  try {
    await insertMember(db, email, name, role);
  } catch {
    // The unique constraint on email is the real check; racing two invites for the same address
    // lands here rather than creating a duplicate.
    return { ok: false, error: "Someone with that email has already been invited." };
  }

  const sent = await inviteUserByEmail(email);
  revalidatePath("/users");
  // Invited either way: the row grants access, the email only helps them set a password.
  return sent.sent
    ? { ok: true as const }
    : { ok: true as const, warning: "Invited, but the email could not be sent. They can still sign in with Google or Microsoft." };
});

export const setMemberRoleAction = withAdmin(async (admin, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  const role = String(formData.get("role") ?? "");
  if (!isRole(role)) return { ok: false, error: "Choose a role." };
  // Not because self-demotion is always unsafe, but because the safe cases are rare and the unsafe
  // one — the last admin demoting themselves — is unrecoverable without psql.
  if (id === admin.id) return { ok: false, error: "You can't change your own role." };

  const db = createServiceClient();
  const target = await findMemberById(db, id);
  if (!target) return { ok: false, error: "That person is no longer in the list." };

  // Read at write time. Two admins demoting each other from two browsers both saw "2 admins".
  const all = await listRolesForInvariant(db);
  if (wouldLeaveNoAdmin(all, { from: target.role, to: role })) {
    return { ok: false, error: LAST_ADMIN };
  }

  await updateMemberRole(db, id, role);
  revalidatePath("/users");
  return { ok: true as const };
});

export const setMemberActiveAction = withAdmin(async (admin, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  const active = String(formData.get("active") ?? "") === "true";
  if (id === admin.id) return { ok: false, error: "You can't revoke your own access." };

  const db = createServiceClient();
  const target = await findMemberById(db, id);
  if (!target) return { ok: false, error: "That person is no longer in the list." };

  // Restoring can only ADD an active admin, so it can never trip the invariant.
  if (!active) {
    const all = await listRolesForInvariant(db);
    if (wouldLeaveNoAdmin(all, { from: target.role, to: "revoked" })) {
      return { ok: false, error: LAST_ADMIN };
    }
  }

  await setMemberDisabled(db, id, !active);
  revalidatePath("/users");
  return { ok: true as const };
});
```

- [ ] **Step 6: Run the tests, typecheck, commit**

```bash
./node_modules/.bin/vitest run src/features/users/actions.test.ts
./node_modules/.bin/tsc --noEmit
git add src/features/users
git commit -m "Add the member admin actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: The /users screen

**Files:**
- Create: `src/app/users/page.tsx`
- Create: `src/features/users/UsersTable.tsx`
- Test: `src/features/users/UsersTable.test.tsx`
- Modify: `src/features/shell/AppSidebar.tsx` (the nav item becomes a link)

- [ ] **Step 1: The page**

`src/app/users/page.tsx`, `export const dynamic = "force-dynamic"`. Resolve the member with
`getCurrentMember()`; `redirect("/login")` when null; **`redirect("/")` when `member.role !== "admin"`**
— a list of everyone's address and access level is not for the whole company. Then `listMembers` and
render `<UsersTable members={members} meId={member.id} />`.

- [ ] **Step 2: Write the failing test**

Create `src/features/users/UsersTable.test.tsx` asserting:
- a row per member showing name, email and role label;
- status is **Active** when `authUserId` is set and `disabledAt` null; **Pending** when `authUserId`
  is null; **Revoked** when `disabledAt` is set — pending is a normal state, not an error;
- the signed-in member's own row offers NO role control and NO revoke control (`meId`), because both
  are refused server-side and offering them is a trap;
- inviting with a duplicate email surfaces the error AND leaves the typed values in the fields (the
  React 19 reset regression — use `onSubmit`, never `<form action>`);
- a warning returned alongside `ok: true` is shown as a warning, not as a failure.

- [ ] **Step 3: Build `UsersTable.tsx`**

A client component in the house style — same card, table, `IconButton` and modal treatment as
`ClientsTable.tsx`; read it first and match it. Columns: Name, Email, Role, Status, Last sign-in,
Actions. Role is a `<select>` that submits on change; Actions carry revoke/restore. **Invite** opens
a modal with email, name and a role `<select>` defaulting to Viewer, plus one line of help text
mapping job titles onto roles (foremen and PMs → Editor; help desk and estimators → Viewer).

Every form uses `onSubmit` + `e.preventDefault()` + `new FormData(e.currentTarget)`.

- [ ] **Step 4: Wire the nav item**

In `AppSidebar.tsx`, `Users & Permissions` becomes
`<NavItem icon="tabler:users" label="Users & Permissions" href="/users" active={pathname.startsWith("/users")} />`.

- [ ] **Step 5: Typecheck, test, build, commit**

```bash
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run src/features/users/UsersTable.test.tsx src/features/shell/AppSidebar.test.tsx
./node_modules/.bin/next build
git add src/app/users src/features/users src/features/shell
git commit -m "Add the users and permissions screen

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Hide what a viewer cannot use

**Files:**
- Modify: `src/app/layout.tsx`, `src/features/shell/AppShell.tsx` (thread the role down)
- Create: `src/features/shell/roleContext.tsx`
- Modify: `ClientsTable.tsx`, `ClientDetail.tsx`, `SiteDetail.tsx`, `FloorDevicesPanel.tsx`

**The server is the control. This task is presentation only** — every one of these actions already
refuses a viewer after Task 4, and no test here may stand in for that.

- [ ] **Step 1: A context for the role**

Create `src/features/shell/roleContext.tsx` exporting a `RoleContext` and
`export function useCanEdit(): boolean`, returning `satisfies(role, "editor")`. `layout.tsx` already
resolves the member — pass `member.role` into `AppShell`, which provides the context, exactly as
`memberName`/`memberEmail`/`memberAvatarUrl` are already threaded.

- [ ] **Step 2: Hide the controls**

In each of the four components, wrap the create button and the per-row edit/delete `IconButton`
cluster in `useCanEdit() && …`. Specifically: `+ Add client`, `+ Add site`, `+ Add rack`,
`+ Add floor`, `+ Add room`, `+ Add device`, and each row's pencil/trash pair.

- [ ] **Step 3: Test one component, not all four**

Add to `ClientsTable.test.tsx`: with the context set to `viewer`, `table-create` and
`edit-client-ACME` are absent; with `editor`, both are present. The pattern is identical in the other
three, and asserting it four times tests the framework rather than the app.

- [ ] **Step 4: Typecheck, full suite, build, commit**

---

### Task 8: Live verification

**Files:** none — this task produces evidence. Run by the controller.

- [ ] **Step 1: Admin sees the screen**

Sign in, open **Users & Permissions**, confirm the existing member is listed as **Admin / Active**.

- [ ] **Step 2: The lockouts are refused**

Try to change your own role — the control must not be offered, and the action must refuse if invoked
directly. Try to revoke yourself — same. Confirm via SQL that nothing changed.

- [ ] **Step 3: A second member, demoted**

Invite a throwaway address as Editor; confirm it appears **Pending** and check Inbucket
(`http://127.0.0.1:54324`) for the invite mail. Set it to Viewer. Then, with SQL, temporarily point
your own member row at `viewer`, reload, and confirm: the `+ Add client` control is gone AND a
create still fails server-side if invoked. Restore yourself to `admin` afterwards and confirm the
screen returns.

- [ ] **Step 4: The last-admin invariant, for real**

With exactly one active admin (you), have the throwaway member promoted to admin and then demoted
again to prove the check permits it when a second admin exists, and refuses when it does not.

- [ ] **Step 5: Clean up**

Remove the throwaway member and its auth user. Confirm `select email, role, disabled_at from members;`
matches the state before this task, plus nothing else.

---
