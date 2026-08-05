import { NextResponse } from "next/server";
import { createSessionClient } from "@/lib/supabase/auth";
import { getCurrentMember } from "@/features/auth/members";
import { logAuthEvent, type AuthMethod } from "@/features/activity/authLog";

/** Supabase's own record of which provider authenticated this user — read from the exchanged
 *  session, not a query parameter on the redirect URL, so it cannot be attacker-supplied. Anything
 *  outside the known set (or missing) means `method` is simply omitted from the log entry rather
 *  than guessed at. */
function toAuthMethod(provider: unknown): AuthMethod | undefined {
  return provider === "google" || provider === "azure" ? provider : undefined;
}

/** Record a sign-in event without ever letting a logging failure change the redirect that follows
 *  it. logAuthEvent already never throws (see authLog.ts) — this wraps it anyway, defensively,
 *  the same way withMember's own logResult wraps writeEntry a second time. */
async function safeLogAuthEvent(e: Parameters<typeof logAuthEvent>[0]): Promise<void> {
  try {
    await logAuthEvent(e);
  } catch (err) {
    console.error("auth callback: logAuthEvent threw unexpectedly", err);
  }
}

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
  const { data, error } = await auth.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=1`);

  const method = toAuthMethod(data.user?.app_metadata?.provider);
  const email = data.user?.email;

  const member = await getCurrentMember();
  if (!member) {
    await auth.auth.signOut();
    await safeLogAuthEvent({
      action: "auth.signIn",
      outcome: "refused",
      method,
      email,
      reason: "not-a-member",
    });
    return NextResponse.redirect(`${origin}/login?error=1`);
  }

  await safeLogAuthEvent({
    action: "auth.signIn",
    outcome: "ok",
    method,
    email,
    memberId: member.id,
    memberName: member.name,
  });
  return NextResponse.redirect(`${origin}/`);
}
