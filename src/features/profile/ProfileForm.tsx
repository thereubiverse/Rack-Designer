"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import type { MemberProfile } from "./repository";
import {
  updateProfileAction, uploadAvatarAction, removeAvatarAction, changePasswordAction,
  sendPhoneCodeAction, confirmPhoneCodeAction,
} from "./actions";
import { revokeMyDeviceAction } from "@/features/devices/actions";
import { useHeaderTitle } from "@/features/shell/headerTitle";

/** A device as this screen needs it — never the repository's `TrustedDevice`, which carries
 *  `tokenHash`. That value is what a stolen cookie is checked against; there is no reason for it to
 *  ever reach the browser, not even the owning member's own browser. `isCurrent` is computed
 *  server-side (the page compares the request's own cookie hash against each row) so the client
 *  never sees the hash it was computed from. */
export interface DeviceView {
  id: string;
  label: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
  isCurrent: boolean;
}

function formatDeviceDate(value: string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleDateString();
}

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
  profile, avatarUrl, hasPassword, devices = [],
}: {
  profile: MemberProfile;
  avatarUrl: string | null;
  hasPassword: boolean;
  devices?: DeviceView[];
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

  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [phoneDone, setPhoneDone] = useState(false);

  const [revokeDeviceTarget, setRevokeDeviceTarget] = useState<DeviceView | null>(null);
  const [revokeDeviceErr, setRevokeDeviceErr] = useState<string | null>(null);
  const [revokeDeviceBusy, setRevokeDeviceBusy] = useState(false);

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

  async function sendCode() {
    setPhoneErr(null); setPhoneBusy(true);
    const res = await sendPhoneCodeAction();
    setPhoneBusy(false);
    if (!res.ok) { setPhoneErr(res.error ?? "Couldn't send that text."); return; }
    setCodeSent(true);
  }

  // Same onSubmit + preventDefault + manually built FormData as saveDetails, and for the same
  // reason: <form action={fn}> resets uncontrolled inputs to defaultValue when the action
  // completes, INCLUDING on a wrong code, which would clear what the member just typed.
  async function confirmCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setPhoneErr(null); setPhoneBusy(true);
    const res = await confirmPhoneCodeAction(formData);
    setPhoneBusy(false);
    if (!res.ok) { setPhoneErr(res.error ?? "Couldn't confirm that code."); return; }
    setCodeSent(false); setPhoneDone(true);
    router.refresh();
  }

  async function handleRevokeDevice() {
    if (!revokeDeviceTarget) return;
    setRevokeDeviceErr(null);
    setRevokeDeviceBusy(true);
    const formData = new FormData();
    formData.set("id", revokeDeviceTarget.id);
    const res = await revokeMyDeviceAction(formData);
    setRevokeDeviceBusy(false);
    if (!res.ok) { setRevokeDeviceErr(res.error ?? "Couldn't revoke that device."); return; }
    setRevokeDeviceTarget(null);
    router.refresh();
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
          <p className="mt-1 text-xs text-neutral-500">
            US numbers are assumed; include the country code (like +44) for anywhere else.
          </p>
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

      {/* Phone verification. This is its OWN card rather than living inside the details <form>
          above: a <form> nested inside another <form> is invalid HTML — the parser drops the
          inner tag on any real SSR/hydration pass, even though it can look like it works in a
          jsdom-only test render. The status line stays right below the number either way. */}
      {profile.phone && (
        <div className={card}>
          <h2 className="text-base font-bold text-neutral-900">Phone verification</h2>
          <div className="flex items-center gap-3">
            <span className="text-sm text-neutral-700">{profile.phone}</span>
            {profile.phoneVerifiedAt ? (
              <span className="flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-xs font-semibold text-green-700">
                <Icon icon="tabler:check" width={14} height={14} /> Verified
              </span>
            ) : (
              <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-600">
                Not verified
              </span>
            )}
          </div>

          {!profile.phoneVerifiedAt && !codeSent && (
            <button
              type="button"
              data-testid="verify-phone"
              disabled={phoneBusy}
              onClick={sendCode}
              className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100 disabled:opacity-50"
            >
              {phoneBusy ? "Sending…" : "Verify"}
            </button>
          )}

          {codeSent && (
            <form onSubmit={confirmCode} className="flex items-end gap-3">
              <div>
                <label htmlFor="phone-code" className={label}>Enter the code</label>
                <input
                  id="phone-code" name="code" data-testid="phone-code"
                  inputMode="numeric" autoComplete="one-time-code" className={input}
                />
              </div>
              <button type="submit" disabled={phoneBusy} className={primary}>
                {phoneBusy ? "Confirming…" : "Confirm"}
              </button>
            </form>
          )}

          {phoneErr && <p className="text-sm text-red-600">{phoneErr}</p>}
          {phoneDone && (
            <p className="flex items-center gap-1 text-sm text-green-700">
              <Icon icon="tabler:check" width={16} height={16} /> Phone verified
            </p>
          )}
        </div>
      )}

      {/* Devices. This screen is unreachable without an approved device (the middleware sends
          anyone else to /verify-device first), so `devices` always has at least one entry in
          practice — the fallback message below is cheap insurance, not a state this member can
          actually be in. */}
      <div className={card} data-testid="devices-card">
        <h2 className="text-base font-bold text-neutral-900">Devices</h2>
        {devices.length === 0 ? (
          <p className="text-sm text-neutral-400">No devices yet</p>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {devices.map((d) => (
              <li
                key={d.id}
                data-testid={`device-row-${d.id}`}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div>
                  <p className="text-sm font-medium text-neutral-900">
                    {d.label}
                    {d.isCurrent && (
                      <span className="ml-1 font-normal text-neutral-400">(this device)</span>
                    )}
                  </p>
                  <p className="text-xs text-neutral-500">
                    {d.approvedAt ? `Approved ${formatDeviceDate(d.approvedAt)}` : "Pending approval"}
                    {" · "}Last seen {formatDeviceDate(d.lastSeenAt)}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid={`revoke-device-${d.id}`}
                  onClick={() => { setRevokeDeviceErr(null); setRevokeDeviceTarget(d); }}
                  className="rounded-lg px-3 py-2 text-sm font-semibold text-red-600 hover:bg-red-50"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {revokeDeviceTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Revoke device">
          <div data-testid="revoke-device-dialog" className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">
              Revoke &ldquo;{revokeDeviceTarget.label}&rdquo;?
            </h3>
            {/* The current device gets its OWN copy, stated plainly rather than folded into the
                generic sentence below: revoking it ends the session on this device right now — the
                very next request lands on /verify-device — and that must not be a surprise. */}
            <p className="mt-2 text-sm text-neutral-600">
              {revokeDeviceTarget.isCurrent
                ? "This is the device you're using right now. Revoking it will end your session here — you'll be asked to verify this device again before you can continue."
                : "That device will no longer be able to access your account. It can be approved again if it's still yours."}
            </p>
            {revokeDeviceErr && (
              <p data-testid="revoke-device-error-message" className="mt-3 text-sm text-red-600">{revokeDeviceErr}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="revoke-device-cancel"
                disabled={revokeDeviceBusy}
                onClick={() => { setRevokeDeviceErr(null); setRevokeDeviceTarget(null); }}
                className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="revoke-device-confirm"
                disabled={revokeDeviceBusy}
                onClick={handleRevokeDevice}
                className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
              >
                Revoke
              </button>
            </div>
          </div>
        </div>
      )}

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
