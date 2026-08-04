# Profile (Slice H2) — Design

## 1. What this is

A page where a signed-in member maintains their own details: name, profile picture, phone number,
position and address — plus a password change for those who have a password at all.

It is the first screen in the app that belongs to the *person* rather than to the client data. That
distinction decides most of what follows.

## 2. Why there is no Account screen

The original ask was two screens: Profile for personal details, Account for email and password.

Account lost its reason to exist. **Changing your own email is not available**, because the
membership gate matches a session to a member row by email — `getCurrentMember` does
`.eq("email", …)` and `src/middleware.ts` repeats that lookup on every request. A member who
verified a new address would, on the very next request, match no member row and be signed out of
their own account. Making self-service email work means either rewriting the invite list from the
inside or re-keying the gate onto `auth_user_id`; both are decisions for the roles-and-permissions
project, not for a settings page.

So email is **read-only**, shown with a line telling the user to ask an administrator. Changing one
is a SQL update today, and a screen in the roles project later.

That leaves password as Account's only live control, and a screen holding one control beside a
sentence saying "ask someone else" is worse than no screen. Password moves into Profile, and the
account menu drops to **Profile** and **Log out**.

## 3. Not everyone has a password

A member who signs in with Google or Microsoft has no password, and Supabase's `updateUser` would
happily *set* one — quietly creating a second way into an account whose owner believes it is
protected by their Google account and its MFA.

So the password section renders only when the user actually has a password identity. Supabase
records this on the auth user: `identities` carries one entry per provider, and a password account
has one with `provider === "email"`. Absent that, the section is not rendered — not disabled, not
explained. There is nothing for that person to change.

## 4. Changing a password requires the current one

`supabase.auth.updateUser({ password })` does **not** ask for the existing password. Without that
check, anyone who reaches an unlocked laptop — or replays a stolen session cookie — can set a new
password and lock the real owner out of their own account permanently.

The current password is verified by re-authenticating: `signInWithPassword` with the member's email
and the supplied current password. Success means they know it; only then does `updateUser` run. A
failure returns a wrong-password message and nothing is written.

This is one of the few places in the app where a *specific* error is correct. The generic
`NOT_A_MEMBER` copy exists so an outsider cannot learn which addresses exist; here the person is
already authenticated and looking at their own settings, so "That password isn't right" tells an
attacker nothing they could not learn by trying, and telling the real user anything vaguer is
merely unhelpful.

## 5. Data

### `0021_member_profile.sql`

```sql
alter table members
  add column phone       text not null default '',
  add column position    text not null default '',
  add column address     text not null default '',
  add column avatar_path text;
```

Text columns default to `''` and are `not null`, matching `name` — the app already treats empty as
"not set" and this avoids every read having to consider null. `avatar_path` is nullable because
null genuinely means "no picture", which is different from an empty path.

Nothing here is validated as a format. Phone numbers and addresses in a company operating across
multiple client sites do not fit a pattern worth enforcing, and a regex that rejects a legitimate
number is a worse outcome than a free-text field.

### The `avatars` bucket

A new **private** bucket, created exactly the way `0012` created `floor-plans`, read through signed
URLs. Private is not obviously required for a headshot, but it is the pattern this repo already
uses for stored objects, and an employee photo is still personal data belonging to someone who did
not choose to publish it.

Objects are stored at `<member-id>/avatar`, one per member, `upsert: true` — so replacing a picture
overwrites rather than accumulating. Removing one deletes the object *and* nulls `avatar_path`, in
that order, so a failure leaves a row pointing at a file that still exists rather than a row
pointing at nothing.

Uploads are capped at **2 MB** and must have an `image/*` content type. The cap is enforced
server-side, in the action, because a client-side check is a courtesy rather than a control.

## 6. Components

| Piece | File | Responsibility |
|---|---|---|
| Migration | `supabase/migrations/0021_member_profile.sql` | Columns above + the bucket |
| Avatar storage | `src/features/profile/avatarStorage.ts` | Upload / signed URL / remove, mirroring `planStorage.ts` |
| Pure rules | `src/features/profile/profileRules.ts` | Field trimming, the 2 MB / image-type check, password-change validation |
| Actions | `src/features/profile/actions.ts` | `updateProfileAction`, `uploadAvatarAction`, `removeAvatarAction`, `changePasswordAction` |
| Page | `src/app/profile/page.tsx` | Server component: resolves the member and their signed avatar URL |
| Form | `src/features/profile/ProfileForm.tsx` | Details, picture, and the conditional password section |
| Sidebar | `src/features/shell/AppSidebar.tsx` | "Profile" links to `/profile`; "Account" removed; avatar replaces the initial |

Every action is wrapped in `withMember`, including the password change — a person with no session
has no password here to change.

**Each action edits only the caller's own row.** The member id comes from `withMember`, never from
the form, so there is no request shape that lets one member write to another's profile. This is the
single most important property in the slice: a profile form that accepted an id from the client
would be an account-takeover endpoint.

## 7. What will bite

**The sidebar avatar costs a round trip.** The root layout already calls `getCurrentMember` on
every render; showing a picture there means a signed-URL call as well. It is skipped entirely when
`avatar_path` is null, so it costs nothing until a member uploads one, and the initial-letter
circle stays as the fallback.

**Re-authenticating rewrites the session cookie.** `signInWithPassword` issues fresh tokens for the
same user, so the check is safe — but it must run on the server action's Supabase client, and the
new cookies have to be allowed to land, or the user is signed out by the act of proving who they
are.

**`position` is a reserved-ish word in some SQL contexts.** It is a legal column name in Postgres
and the Supabase client quotes identifiers, so it is fine here; it is called out only so nobody
"fixes" it later by renaming the column and breaking the reads.

**Deleting a member does not delete their avatar.** Nothing in the app deletes members yet, so
there is no orphan today; when the roles project adds member removal, the object must go with it —
the same trap `floor-plans` had before the archive purge slice enumerated its paths.

## 8. Testing

- **Pure** (`profileRules.test.ts`): trimming; a 2 MB + 1 byte upload is rejected; a `text/plain`
  upload is rejected; a password change with a blank or too-short new password is rejected before
  any network call.
- **Actions**, DB-free with fakes: `updateProfileAction` writes to the id from `withMember` and
  **ignores any id present in the form** — the load-bearing test of section 6; `removeAvatarAction`
  deletes the object *before* nulling the column; `changePasswordAction` calls `updateUser` **only**
  after a successful re-authentication, and not at all when the current password is wrong.
- **Form** (`ProfileForm.test.tsx`): the password section is absent for a member with no password
  identity and present for one with it; a failed save leaves the entered values in place.
- **Live**: upload a picture and see it in the sidebar; remove it and see the initial return; change
  the password, sign out, and sign in with the new one; confirm the old one is refused.
- Tests run by EXPLICIT FILENAME or with the three `--exclude` flags — the integration files wipe
  the local database.

## 9. Out of scope

Email change of any kind. Image resizing or cropping — a 2 MB cap and `object-cover` are enough
until they are not. Any notion of one member viewing another's profile; this is self-service only,
and a team directory belongs to the roles project. Two-factor authentication. Deleting your own
account. Notification or display preferences.
