"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import type { MemberRow } from "./repository";
import { inviteMemberAction, setMemberRoleAction, setMemberActiveAction } from "./actions";
import { ROLES, roleLabel, type Role } from "@/features/auth/roles";
import { IconButton } from "@/features/clients/IconButton";
import { useHeaderTitle } from "@/features/shell/headerTitle";

const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";

type Status = "active" | "pending" | "revoked";

/** Status is DERIVED, never stored. A `disabledAt` always wins — someone invited and then revoked
 *  before ever signing in is Revoked, not Pending. Otherwise a null `authUserId` means the invite
 *  hasn't been claimed yet: a normal, expected state, not an error. */
function statusOf(m: MemberRow): Status {
  if (m.disabledAt !== null) return "revoked";
  if (m.authUserId === null) return "pending";
  return "active";
}

const STATUS_LABEL: Record<Status, string> = {
  active: "Active",
  pending: "Pending",
  revoked: "Revoked",
};

// Pending reads neutral, like Active — it is not a problem to flag red the way Revoked is.
const STATUS_STYLE: Record<Status, string> = {
  active: "bg-green-50 text-green-700",
  pending: "bg-neutral-100 text-neutral-600",
  revoked: "bg-red-50 text-red-700",
};

function formatLastSignIn(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleDateString();
}

/** The /users screen: one row per member. Admin-only access is enforced by the page (this
 *  component trusts its caller and renders unconditionally), matching ClientsTable's card, table
 *  header, IconButton and modal treatment so it reads as part of the same app.
 *
 *  `meId` marks the signed-in member's own row so it can withhold the role select and the revoke
 *  control: both are refused server-side — you cannot change your own role or revoke your own
 *  access — so offering them here is a trap that produces an error for no reason. */
export function UsersTable({ members, meId }: { members: MemberRow[]; meId: string }) {
  useHeaderTitle("Users & Permissions");
  const router = useRouter();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteWarning, setInviteWarning] = useState<string | null>(null);

  const [rowError, setRowError] = useState<Record<string, string | null>>({});

  const [revokeTarget, setRevokeTarget] = useState<MemberRow | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  // onSubmit + preventDefault, NOT the <form action={fn}> pattern — see ProfileForm/ClientsTable.
  // React 19 schedules a native form.reset() as part of that pattern's transition whatever the
  // action resolves to, so a FAILED invite would silently wipe the typed email/name while showing
  // an error about it.
  async function handleInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setInviteError(null);
    const res = await inviteMemberAction(formData);
    if (!res.ok) { setInviteError(res.error ?? "Failed"); return; }
    setInviteOpen(false);
    // The invite succeeded either way — the row grants access. A warning means only the email
    // failed to send, which is worth surfacing but is not a failure.
    if (res.warning) setInviteWarning(res.warning);
    router.refresh();
  }

  async function handleRoleChange(id: string, role: Role) {
    setRowError((prev) => ({ ...prev, [id]: null }));
    const formData = new FormData();
    formData.set("id", id);
    formData.set("role", role);
    const res = await setMemberRoleAction(formData);
    if (!res.ok) { setRowError((prev) => ({ ...prev, [id]: res.error ?? "Failed" })); return; }
    router.refresh();
  }

  async function handleRestore(id: string) {
    setRowError((prev) => ({ ...prev, [id]: null }));
    const formData = new FormData();
    formData.set("id", id);
    formData.set("active", "true");
    const res = await setMemberActiveAction(formData);
    if (!res.ok) { setRowError((prev) => ({ ...prev, [id]: res.error ?? "Failed" })); return; }
    router.refresh();
  }

  async function handleRevoke() {
    if (!revokeTarget) return;
    setRevokeError(null);
    setRevokeBusy(true);
    const formData = new FormData();
    formData.set("id", revokeTarget.id);
    formData.set("active", "false");
    const res = await setMemberActiveAction(formData);
    setRevokeBusy(false);
    if (!res.ok) { setRevokeError(res.error ?? "Failed"); return; }
    setRevokeTarget(null);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {/* No breadcrumb: this page has no parent, so a one-item trail would just be the title a
          second time. The top bar already carries it via useHeaderTitle. */}
      {inviteWarning && (
        <div
          data-testid="invite-warning-banner"
          className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          <Icon icon="tabler:alert-triangle" width={18} height={18} className="mt-0.5 shrink-0" />
          <span>{inviteWarning}</span>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-lg font-bold text-neutral-900">Users &amp; Permissions</h2>
          <button
            type="button"
            data-testid="table-invite"
            onClick={() => { setInviteError(null); setInviteOpen(true); }}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9]"
          >
            + Invite
          </button>
        </div>

        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-neutral-200 bg-neutral-50">
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Name</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Email</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Role</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Status</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Last sign-in</th>
              <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const status = statusOf(m);
              const isMe = m.id === meId;
              return (
                <tr
                  key={m.id}
                  data-testid={`user-row-${m.id}`}
                  className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50"
                >
                  <td className="px-5 py-3 font-medium text-neutral-900">
                    {m.name || m.email}
                    {isMe && <span className="ml-1 font-normal text-neutral-400">(you)</span>}
                  </td>
                  <td className="px-5 py-3 text-neutral-600">{m.email}</td>
                  <td className="px-5 py-3">
                    {isMe ? (
                      // Refused server-side (you can't change your own role) — offering the control
                      // here would just produce an error for no reason.
                      <span className="text-neutral-600">{roleLabel(m.role)}</span>
                    ) : (
                      <select
                        data-testid={`role-select-${m.id}`}
                        aria-label={`Role for ${m.email}`}
                        value={m.role}
                        onChange={(e) => handleRoleChange(m.id, e.target.value as Role)}
                        className="h-8 rounded-lg border border-neutral-200 px-2 text-sm focus:border-neutral-400 focus:outline-none"
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{roleLabel(r)}</option>
                        ))}
                      </select>
                    )}
                    {rowError[m.id] && (
                      <p className="mt-1 text-xs text-red-600">{rowError[m.id]}</p>
                    )}
                  </td>
                  <td className="px-5 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLE[status]}`}>
                      {STATUS_LABEL[status]}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-neutral-600">{formatLastSignIn(m.lastSignInAt)}</td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {/* Refused server-side (you can't revoke your own access) — no control at all
                          for the signed-in member's own row. */}
                      {!isMe && status === "revoked" && (
                        <IconButton
                          data-testid={`restore-user-${m.id}`}
                          icon="tabler:rotate-clockwise"
                          tip="Restore access"
                          onClick={() => handleRestore(m.id)}
                        />
                      )}
                      {!isMe && status !== "revoked" && (
                        <IconButton
                          data-testid={`revoke-user-${m.id}`}
                          icon="tabler:user-x"
                          tip="Revoke access"
                          variant="danger"
                          onClick={() => { setRevokeError(null); setRevokeTarget(m); }}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td colSpan={6} className="px-5 py-14 text-center text-sm text-neutral-400">No members yet</td>
              </tr>
            )}
          </tbody>
        </table>

        {inviteOpen && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Invite member">
            <form onSubmit={handleInvite} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
              <h3 className="text-base font-bold">Invite member</h3>
              <label className="block text-[11px] font-semibold text-neutral-600">
                Email *
                <input name="email" type="email" placeholder="name@company.com" required className={input} />
              </label>
              <label className="block text-[11px] font-semibold text-neutral-600">
                Name
                <input name="name" placeholder="Jane Doe" className={input} />
              </label>
              <label className="block text-[11px] font-semibold text-neutral-600">
                Role
                <select name="role" defaultValue="viewer" className={`${input} bg-white`}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{roleLabel(r)}</option>
                  ))}
                </select>
              </label>
              <p className="text-xs text-neutral-500">
                Foremen and PMs typically get Editor access; help desk and estimators typically get Viewer.
              </p>
              {inviteError && <p data-testid="invite-error-message" className="text-sm text-red-600">{inviteError}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setInviteOpen(false)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Cancel</button>
                <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Invite</button>
              </div>
            </form>
          </div>
        )}

        {revokeTarget && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Revoke access">
            <div data-testid="revoke-dialog" className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
              <h3 className="text-base font-bold">
                Revoke access for &ldquo;{revokeTarget.name || revokeTarget.email}&rdquo;?
              </h3>
              <p className="mt-2 text-sm text-neutral-600">
                They will no longer be able to sign in. This can be undone from this screen at any time.
              </p>
              {revokeError && (
                <p data-testid="revoke-error-message" className="mt-3 text-sm text-red-600">{revokeError}</p>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  data-testid="revoke-cancel"
                  disabled={revokeBusy}
                  onClick={() => { setRevokeError(null); setRevokeTarget(null); }}
                  className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  data-testid="revoke-confirm"
                  disabled={revokeBusy}
                  onClick={handleRevoke}
                  className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
                >
                  Revoke
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
