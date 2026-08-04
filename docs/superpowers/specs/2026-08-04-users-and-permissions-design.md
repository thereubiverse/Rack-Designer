# Users & Permissions (Slice H3) — Design

Completes the three-project sequence that began with [authentication](./2026-08-04-authentication-design.md):
authenticate, then attribute, then authorise. This is the third.

## 1. What exists today, and what is missing

Every active member has identical, unlimited power. A brand-new invitee can rename a client, delete
a floor plan, or archive a site the moment they first sign in — there is no notion of a role, and
nothing distinguishes the owner of the company from a subcontractor added this morning.

There is also no way to add anyone. Membership is a row in `members`, and the only tool that writes
one is `psql`. The nav item that should solve both is inert.

This slice makes the nav item real: a screen for managing who is in, and a role that decides what
they can change.

## 2. Two decisions that bound the whole design

**Read is global.** Every member can see every client. Roles gate what you can *change*, not what
you can see. PatchDocs works this way too, and it keeps the enforcement point in one place —
`withMember`, which already wraps all 54 server actions — rather than requiring every page, every
dashboard tile and every map query to filter by grant.

This is a deliberate trade, and it has a name: it is wrong for subcontractors and wrong for
client-staff logins, which is exactly what `docs/reference/patchdocs-notes.md` calls the MSP angle.
Per-client scoping is a real future requirement, not a rejected one. Section 8 says what it would
cost so nobody re-derives it.

**Three roles, not six job titles.** `admin`, `editor`, `viewer`. The team is installers, foremen,
project managers, estimators, technicians and help desk — but a job title is not a permission. Titles
change often and permissions rarely, and six roles is six sets of rules to keep straight. The
`position` field on a profile already records what someone *is*; the role records what they may
*do*.

Mapping, for the invite screen's help text: foremen and project managers are Editors; help desk and
estimators are Viewers; technicians and installers are Editors if they update documentation on site
and Viewers if they only consult it.

## 3. The roles

| | Viewer | Editor | Admin |
|---|---|---|---|
| See every client, site, floor, rack, device | ✓ | ✓ | ✓ |
| Create, rename, move, archive anything | | ✓ | ✓ |
| Upload and delete floor plans | | ✓ | ✓ |
| Run AI discovery and the Device Wizard | | ✓ | ✓ |
| Restore or permanently remove from the archive | | ✓ | ✓ |
| Invite, revoke and re-invite members | | | ✓ |
| Change anyone's role | | | ✓ |
| Change the Gemini key and app settings | | | ✓ |

Roles are ordered: `admin` outranks `editor` outranks `viewer`. A requirement is a *minimum*, so an
admin passes every editor check without being enumerated separately.

**The AI actions belong to Editor even though they only read.** `discoverRoomsAction`,
`discoverDevicesAction`, `discoverSymbolsAction`, `extractPlanGeometryAction`, `detectPortsAction`
and `identifyDeviceAction` write nothing — but every call spends Gemini quota against a key the
company pays for. A "read-only" role that can run up a bill is not read-only. Only
`listTemplatesForTypeAction` and `getDeviceTemplateAction` are genuinely free reads and stay open to
Viewers.

## 4. Where it is enforced

`withMember` already resolves the acting member for all 54 actions, so the role check goes there
rather than into 54 separate function bodies. Two companions, built on it:

```ts
export function withEditor<A extends unknown[], R>(action: (member: Member, ...args: A) => Promise<R>): …
export function withAdmin<A extends unknown[], R>(action: (member: Member, ...args: A) => Promise<R>): …
```

Converting is then mechanical: an action that changes documentation becomes `withEditor`, one that
manages members or settings becomes `withAdmin`, and the two free reads stay `withMember`.

**The server is the control; the UI is a courtesy.** Buttons a Viewer cannot use are hidden, because
showing someone a control that always fails is bad design — but hiding is not enforcement. Every
test that matters asserts the *action* refuses, not that the button is absent.

**Refusal copy is specific here.** "You need editor access to change this." The generic
`NOT_A_MEMBER` sentence exists so outsiders cannot learn which email addresses are real; a person who
is already signed in and looking at their own team's app learns nothing from being told why they were
refused, and telling them anything vaguer just generates a support ticket.

## 5. Data

### `0025_member_roles.sql`

```sql
alter table members
  add column role text not null default 'viewer'
    check (role in ('admin', 'editor', 'viewer'));

-- Everyone who exists today has had unlimited power since before roles existed. Defaulting them to
-- 'viewer' would silently strip the owner of their own app on migration; defaulting them to 'admin'
-- grandfathers exactly the access they already have. NEW members default to 'viewer', which is the
-- safe direction for anyone added from here on.
update members set role = 'admin';
```

Plus the grant-then-narrow tail that `0024` established, unchanged — `role` must not become readable
or writable by the anon key, and the existing column-level grant already limits anon to
`(email, disabled_at)`.

`disabled_at` already exists and already means revoked; this slice gives it a UI rather than
changing its meaning. Revoking is still not a delete, because every activity-log entry that person
ever creates must keep resolving to a name.

## 6. The screen

`/users`, reachable from the existing nav item, and **admin-only** — a Viewer following the link is
sent to the dashboard, because a list of everyone's email addresses and access levels is not
something the whole company needs.

One table: name, email, role, status, and when they last signed in. Status is derived, not stored —
**Active** (`auth_user_id` set, not disabled), **Pending** (invited, never signed in), **Revoked**
(`disabled_at` set). A pending member is a normal state, not an error: it just means the invite has
not been accepted yet.

Row actions: change role, revoke, restore. Plus **Invite**, which takes an email, a name and a role.

**Inviting sends a Supabase invite email.** Locally that lands in Inbucket, which the stack already
runs; in production it needs SMTP, which is not configured. So the row is written first and the email
is attempted second: if sending fails, the invite still exists and the person can get in via Google
or Microsoft, and the screen says the email could not be sent rather than pretending it was. Same
degradation as the OAuth buttons and the Verify button.

## 7. Three ways an admin can lock the company out, and what stops each

This is the part of the slice most likely to cause a real incident, and none of the three is exotic.

1. **Demoting yourself.** You are the only admin, you set yourself to Editor, and now nobody can
   invite, revoke or promote anyone ever again — the screen that would fix it is admin-only.
2. **Revoking yourself.** Same outcome, faster: your next request fails the middleware's membership
   check and you are signed out of an app you can no longer be let back into.
3. **Revoking the last other admin** while intending to keep access yourself, having already been
   demoted by someone else.

All three reduce to one invariant: **there must always be at least one active admin.** It is enforced
in the pure rule layer and tested there, and additionally you cannot change your own role or revoke
yourself at all — not because those are always unsafe, but because the safe cases are rare and the
unsafe ones are unrecoverable without database access.

The last-admin check must run against the database at the moment of the write, not against what the
screen was showing. Two admins demoting each other from two browsers, both seeing "2 admins", is
exactly the race the invariant exists to survive.

## 8. What per-client scoping would cost, if you want it later

Recorded so this is a decision rather than a rediscovery. It needs a `member_client_grants` table, a
role of `admin`/`editor`/`viewer` *per grant* rather than per member, and a filter on every read path
— `/clients`, the dashboard tiles, the sites map, every site and floor page, and the archive. The
enforcement point stops being `withMember`, because reads do not go through it; it becomes either
row-level security or a repository layer that no query may bypass.

Nothing in this slice blocks that. `members.role` becomes the default when no grant applies.

## 9. Testing

- **Pure** (`roles.test.ts`): the ordering (`admin` satisfies an editor requirement, `viewer` does
  not); `wouldLeaveNoAdmin` returns true for demoting the only admin, for revoking the only admin,
  and false when a second active admin exists — including that a *revoked* admin does not count.
- **Guards** (`withRole.test.ts`), DB-free: a viewer calling an editor-guarded action gets a refusal
  and **the wrapped action is never invoked** — the same load-bearing negative as `withMember`; an
  editor passes; an admin passes an editor guard.
- **Actions**: inviting refuses a duplicate email; changing your own role is refused; revoking
  yourself is refused; demoting the last admin is refused; role changes and revocations are refused
  outright for a non-admin caller.
- **Screen**: status is derived correctly for active, pending and revoked rows; a non-admin never
  reaches the page.
- **Completeness**: a repo-wide check that every export in a `"use server"` module is wrapped in
  `withMember`, `withEditor` or `withAdmin` — none bare. This is the check that caught two unguarded
  actions in the auth slice, and it only works when it scans every `"use server"` FILE rather than
  matching function names.
- **Live**: sign in as an admin, demote yourself → refused; revoke yourself → refused; invite
  someone, see them Pending; set a second member to Viewer and confirm a write is refused server-side
  with the edit controls hidden.
- Tests run by EXPLICIT FILENAME or with the three `--exclude` flags — the integration files wipe the
  local database.

## 10. Out of scope

Per-client grants (section 8). Client-staff logins. Billing, which the nav item pairs with settings
but which has no product behind it. Custom or user-defined roles. Per-resource grants at floor, room
or device level — PatchDocs offers them; nothing in this codebase needs them yet, and they are a
different data model rather than an extension of this one. The activity log, still, though this slice
is the last thing standing between it and attribution that means something.
