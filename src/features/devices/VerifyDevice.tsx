"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { startDeviceApprovalAction, confirmDeviceAction, resendDeviceCodeAction } from "./actions";

// Same input/card/button treatment as ProfileForm, so this screen — reached only because
// something is WRONG (an unrecognised device) — still reads as part of the same app rather than
// some separate, alarming interstitial.
const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";
const label = "block text-[11px] font-semibold text-neutral-600";
const card = "space-y-3 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm";
const primary = "rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9] disabled:opacity-50";

/** `/verify-device`'s content. The page around this component has already done the two checks
 *  that decide whether this should render at all (is there a member, is their device already
 *  approved) — this component trusts its caller and only handles what happens once someone is
 *  actually here: send a code, then confirm it.
 *
 *  The six-digit input is not shown until a code has genuinely been sent (`sent`). Showing it up
 *  front — before `startDeviceApprovalAction` has run — would invite someone to type a code that
 *  was never issued, which is worse than the plain "this device isn't recognised" message: it
 *  implies there is something to enter when there is nothing yet. */
export function VerifyDevice() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function sendCode() {
    setError(null);
    setBusy(true);
    const res = await startDeviceApprovalAction();
    setBusy(false);
    if (!res.ok) { setError(res.error ?? "Couldn't send that code."); return; }
    setSent(true);
  }

  async function resend() {
    setError(null);
    setBusy(true);
    const res = await resendDeviceCodeAction();
    setBusy(false);
    // A refusal here is most often the resend cooldown ("Wait N more seconds…") — that message is
    // returned as-is, which is what "surfaces the cooldown" means: no separate client-side timer
    // duplicating a rule the server already enforces.
    if (!res.ok) { setError(res.error ?? "Couldn't send another code."); return; }
  }

  // onSubmit + preventDefault + manually built FormData, NOT <form action={fn}> — same reasoning
  // as ProfileForm/UsersTable: React 19's action-transition resets the form to defaultValue when
  // the action settles, WRONG CODE included, which would blank what was just typed right when the
  // member needs to see it was wrong and try again.
  async function confirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setError(null);
    setBusy(true);
    const res = await confirmDeviceAction(formData);
    setBusy(false);
    if (!res.ok) { setError(res.error ?? "That code isn't right."); return; }
    // Approved: the middleware's device gate now passes for this browser. Send the member on to
    // the app rather than leaving them on a page whose whole point was just satisfied.
    router.push("/");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4">
      <div className={`${card} w-full max-w-sm`}>
        <h1 className="text-base font-bold text-neutral-900">Verify this device</h1>
        <p className="text-sm text-neutral-600">
          We don&rsquo;t recognise this device. Confirm it&rsquo;s you by email before you can continue.
        </p>

        {!sent && (
          <button
            type="button"
            data-testid="send-code"
            disabled={busy}
            onClick={sendCode}
            className={primary}
          >
            {busy ? "Sending…" : "Send code"}
          </button>
        )}

        {sent && (
          <form onSubmit={confirm} className="space-y-3">
            <div>
              <label htmlFor="verify-device-code" className={label}>Enter the code</label>
              <input
                id="verify-device-code" name="code" data-testid="verify-device-code"
                inputMode="numeric" autoComplete="one-time-code" className={input}
              />
            </div>
            <div className="flex items-center gap-3">
              <button type="submit" disabled={busy} className={primary}>
                {busy ? "Confirming…" : "Confirm"}
              </button>
              <button
                type="button"
                data-testid="resend-code"
                disabled={busy}
                onClick={resend}
                className="text-sm font-semibold text-blue-600 hover:underline disabled:opacity-50"
              >
                Resend code
              </button>
            </div>
          </form>
        )}

        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
