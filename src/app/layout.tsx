import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/features/shell/AppShell";
import { getCurrentMember } from "@/features/auth/members";
import { createServiceClient } from "@/lib/supabase/server";
import { readProfile } from "@/features/profile/repository";
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
  const member = await getCurrentMember();
  const memberName = member ? member.name || member.email : null;
  const memberEmail = member ? member.email : null;

  // Only costs a storage round trip for members who have actually uploaded a picture; everyone
  // else keeps the initial-letter circle and this is skipped entirely.
  let memberAvatarUrl: string | null = null;
  if (member) {
    const db = createServiceClient();
    const profile = await readProfile(db, member.id);
    if (profile?.avatarPath) memberAvatarUrl = await createAvatarSignedUrl(db, profile.avatarPath);
  }

  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900">
        <AppShell memberName={memberName} memberEmail={memberEmail} memberAvatarUrl={memberAvatarUrl}>{children}</AppShell>
      </body>
    </html>
  );
}
