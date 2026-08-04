"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import type { MemberProfile } from "./repository";
import {
  updateProfileAction, uploadAvatarAction, removeAvatarAction, changePasswordAction,
} from "./actions";
import { useHeaderTitle } from "@/features/shell/headerTitle";

// Same input treatment as the client and site forms, so a field means the same thing everywhere.
const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";
const label = "block text-[11px] font-semibold text-neutral-600";
const card = "space-y-3 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm";
const primary = "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9] disabled:opacity-50";

/** A member's own details. Every write goes to the id withMember resolves from the session, so
 *  nothing here needs to — or does — send an id.
 *
 *  Inputs are UNCONTROLLED with defaultValue: when a save fails, what the user typed is still in
 *  the field. Controlled inputs reset from props on the re-render and silently discard it. */
export function ProfileForm({
  profile, avatarUrl, hasPassword,
}: {
  profile: MemberProfile;
  avatarUrl: string | null;
  hasPassword: boolean;
}) {
  useHeaderTitle("Profile");
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  // One state trio per card: a failure saving details must not blank a password error, and vice
  // versa.
  const [detailsErr, setDetailsErr] = useState<string | null>(null);
  const [detailsDone, setDetailsDone] = useState(false);
  const [detailsBusy, setDetailsBusy] = useState(false);

  const [picErr, setPicErr] = useState<string | null>(null);
  const [picBusy, setPicBusy] = useState(false);

  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const [pwBusy, setPwBusy] = useState(false);
  const pwFormRef = useRef<HTMLFormElement>(null);

  const initial = (profile.name || profile.email).charAt(0).toUpperCase();

  // A plain onSubmit + preventDefault, NOT the <form action={fn}> pattern: React 19 schedules a
  // native form.reset() as part of that pattern's transition, right when the form submits and
  // regardless of what the action resolves to. That would wipe the uncontrolled inputs back to
  // defaultValue on a FAILED save too, defeating the point of leaving them uncontrolled.
  async function saveDetails(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setDetailsErr(null); setDetailsDone(false); setDetailsBusy(true);
    const res = await updateProfileAction(formData);
    setDetailsBusy(false);
    if (!res.ok) { setDetailsErr(res.error ?? "Couldn't save your details."); return; }
    setDetailsDone(true);
    router.refresh();
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    setPicErr(null); setPicBusy(true);
    const formData = new FormData();
    formData.set("file", file);
    const res = await uploadAvatarAction(formData);
    setPicBusy(false);
    // Clear the input either way, so choosing the SAME file again still fires a change event.
    if (fileRef.current) fileRef.current.value = "";
    if (!res.ok) { setPicErr(res.error ?? "Couldn't upload that picture."); return; }
    router.refresh();
  }

  async function removePicture() {
    setPicErr(null); setPicBusy(true);
    const res = await removeAvatarAction(new FormData());
    setPicBusy(false);
    if (!res.ok) { setPicErr(res.error ?? "Couldn't remove that picture."); return; }
    router.refresh();
  }

  async function changePassword(formData: FormData) {
    setPwErr(null); setPwDone(false); setPwBusy(true);
    const res = await changePasswordAction(formData);
    setPwBusy(false);
    if (!res.ok) { setPwErr(res.error ?? "Couldn't change your password."); return; }
    setPwDone(true);
    pwFormRef.current?.reset();
  }

  return (
    <div className="max-w-2xl space-y-4">
      {/* Picture */}
      <div className={card}>
        <h2 className="text-base font-bold text-neutral-900">Picture</h2>
        <div className="flex items-center gap-4">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-neutral-900 text-xl font-semibold text-white">
              {initial}
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="choose-avatar"
              disabled={picBusy}
              onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100 disabled:opacity-50"
            >
              {avatarUrl ? "Change" : "Upload"}
            </button>
            {profile.avatarPath && (
              <button
                type="button"
                data-testid="remove-avatar"
                disabled={picBusy}
                onClick={removePicture}
                className="rounded-lg px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                Remove
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => pickFile(e.target.files?.[0])}
            />
          </div>
        </div>
        <p className="text-xs text-neutral-500">JPG, PNG or GIF, up to 2 MB.</p>
        {picErr && <p className="text-sm text-red-600">{picErr}</p>}
      </div>

      {/* Details */}
      <form onSubmit={saveDetails} className={card}>
        <h2 className="text-base font-bold text-neutral-900">Your details</h2>

        <div>
          <label htmlFor="profile-name" className={label}>Name</label>
          <input id="profile-name" name="name" defaultValue={profile.name} className={input} />
        </div>

        <div>
          <label htmlFor="profile-position" className={label}>Position</label>
          <input
            id="profile-position" name="position" defaultValue={profile.position}
            placeholder="Foreman, Estimator, Help Desk…" className={input}
          />
        </div>

        <div>
          <label htmlFor="profile-phone" className={label}>Phone number</label>
          <input id="profile-phone" name="phone" defaultValue={profile.phone} className={input} />
        </div>

        <div>
          <label htmlFor="profile-address" className={label}>Address</label>
          <textarea
            id="profile-address" name="address" defaultValue={profile.address} rows={3}
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm focus:border-neutral-400 focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="profile-email" className={label}>Email</label>
          {/* Read-only: the membership gate matches a session to a member row by email, so changing
              it here would sign the person out of their own account on the next request. */}
          <input
            id="profile-email" defaultValue={profile.email} readOnly
            className={`${input} bg-neutral-50 text-neutral-500`}
          />
          <p className="mt-1 text-xs text-neutral-500">
            Ask an administrator to change your email address.
          </p>
        </div>

        {detailsErr && <p className="text-sm text-red-600">{detailsErr}</p>}
        <div className="flex items-center gap-3 pt-1">
          <button type="submit" data-testid="save-details" disabled={detailsBusy} className={primary}>
            {detailsBusy ? "Saving…" : "Save changes"}
          </button>
          {detailsDone && (
            <span className="flex items-center gap-1 text-sm text-green-700">
              <Icon icon="tabler:check" width={16} height={16} /> Saved
            </span>
          )}
        </div>
      </form>

      {/* Password — only for members who actually have one. Offering this to a Google or Microsoft
          user would SET a password, creating a second way into an account whose owner believes
          their provider protects it. */}
      {hasPassword && (
        <form ref={pwFormRef} action={changePassword} data-testid="password-section" className={card}>
          <h2 className="text-base font-bold text-neutral-900">Password</h2>

          <div>
            <label htmlFor="pw-current" className={label}>Current password</label>
            <input id="pw-current" name="current" type="password" autoComplete="current-password" className={input} />
          </div>

          <div>
            <label htmlFor="pw-next" className={label}>New password</label>
            <input id="pw-next" name="next" type="password" autoComplete="new-password" className={input} />
          </div>

          <div>
            <label htmlFor="pw-confirm" className={label}>Confirm new password</label>
            <input id="pw-confirm" name="confirm" type="password" autoComplete="new-password" className={input} />
          </div>

          {pwErr && <p className="text-sm text-red-600">{pwErr}</p>}
          <div className="flex items-center gap-3 pt-1">
            <button type="submit" disabled={pwBusy} className={primary}>
              {pwBusy ? "Changing…" : "Change password"}
            </button>
            {pwDone && (
              <span className="flex items-center gap-1 text-sm text-green-700">
                <Icon icon="tabler:check" width={16} height={16} /> Password changed
              </span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
