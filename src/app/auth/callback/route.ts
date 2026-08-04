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
