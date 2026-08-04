"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@iconify/react";
import { signInWithPasswordAction, oauthUrlAction } from "./authActions";
// NOT_A_MEMBER lives in ./messages, not ./members: members.ts carries a `server-only` import that
// throws the instant it is evaluated in a client bundle, and this is a client component.
import { NOT_A_MEMBER } from "./messages";

/** Validates a `?next=` redirect target before it is ever handed to router.replace().
 *
 *  `next` comes straight from the URL — an attacker can put anything there — so it must be a
 *  same-site relative path, never used as-is. Accept only paths that start with "/" and reject
 *  anything starting with "//": "//evil.com" LOOKS relative but a browser (and the WHATWG URL
 *  parser) resolves it as protocol-relative, i.e. an absolute off-site URL. A scheme like
 *  "https://evil.com" is rejected by the same "/" check since it does not start with "/" at all.
 *  Anything that fails either check falls back to "/". Exported and pure so it is unit-testable
 *  without rendering the form. */
export function safeNextPath(next: string | null): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  return next;
}

/** The only page an unauthenticated visitor can reach. Deliberately says as little as possible about
 *  why a sign-in failed — see NOT_A_MEMBER. */
export function LoginForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The callback route cannot pass a message through a redirect, so it sets a flag and the copy
  // lives here — one sentence, the same one every other refusal uses.
  const params = useSearchParams();
  const shown = error ?? (params.get("error") ? NOT_A_MEMBER : null);

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
    router.replace(safeNextPath(params.get("next")));
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

      {shown && (
        <p
          data-testid="login-error"
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {shown}
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
