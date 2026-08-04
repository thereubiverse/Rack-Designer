import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/features/shell/AppShell";
import { getCurrentMember } from "@/features/auth/members";

export const metadata: Metadata = {
  title: "Network Documentation Platform",
  description: "Rack builder & network documentation",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // getCurrentMember is server-only, so the lookup happens here and the result is handed down as a
  // plain prop — AppShell and AppSidebar are client components and cannot call it themselves. A null
  // name means no session, which only occurs on the auth routes, where AppShell doesn't render the
  // sidebar anyway. A member's `name` column can be empty, so fall back to their email.
  const member = await getCurrentMember();
  const memberName = member ? member.name || member.email : null;

  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900">
        <AppShell memberName={memberName}>{children}</AppShell>
      </body>
    </html>
  );
}
