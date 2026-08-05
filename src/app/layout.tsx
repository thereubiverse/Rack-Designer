import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/features/shell/AppShell";
import { getCurrentMember } from "@/features/auth/members";
import { createServiceClient } from "@/lib/supabase/server";
import { createAvatarSignedUrl } from "@/features/profile/avatarStorage";

export const metadata: Metadata = {
  title: "Network Documentation Platform",
  description: "Rack builder & network documentation",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // getCurrentMember is server-only, so the lookup happens here and the result is handed down as
  // plain props — AppShell and AppSidebar are client components and cannot call it themselves. Null
  // means no session, which only occurs on the auth routes, where AppShell doesn't render the
  // sidebar anyway. A member's `name` column can be empty, so fall back to their email.
  //
  // The email travels separately rather than being folded into the name: two members can share a
  // display name, and the account menu is the only place that says which one you are signed in as.
  // Guarded because this runs at BUILD time too. Next prerenders /_not-found, which renders this
  // layout with no request and no Supabase environment, and createSessionClient throws on missing
  // credentials — so an unguarded call fails `next build` entirely, which is how it was found.
  //
  // Signed-out is the correct answer for a prerender: there is no session. It does not hide a real
  // misconfiguration either — a deployment genuinely missing these variables fails in the
  // middleware, which needs the same two and runs before any page.
  let member: Awaited<ReturnType<typeof getCurrentMember>> = null;
  try {
    member = await getCurrentMember();
  } catch (e) {
    console.error("RootLayout: could not resolve the signed-in member", e);
  }
  const memberName = member ? member.name || member.email : null;
  const memberEmail = member ? member.email : null;
  const memberRole = member ? member.role : null;

  // Only costs a storage round trip for members who have actually uploaded a picture; everyone else
  // keeps the initial-letter circle and this is skipped entirely. The path rides along on
  // getCurrentMember's existing row read, so there is no second query for it.
  //
  // Signing is wrapped because this is the ROOT layout: it renders on every route. Signing a path
  // whose object is missing returns a 400, and an unguarded throw here would 500 the whole app for
  // that member — including /profile, the one page where they could remove the broken picture. The
  // row and the object can disagree after a failed removal, so this is reachable, not theoretical.
  let memberAvatarUrl: string | null = null;
  if (member?.avatarPath) {
    try {
      memberAvatarUrl = await createAvatarSignedUrl(createServiceClient(), member.avatarPath);
    } catch (e) {
      console.error("RootLayout: could not sign the member avatar", e);
    }
  }

  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900">
        <AppShell memberName={memberName} memberEmail={memberEmail} memberAvatarUrl={memberAvatarUrl} memberRole={memberRole}>{children}</AppShell>
      </body>
    </html>
  );
}
