import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/features/shell/AppShell";

export const metadata: Metadata = {
  title: "Network Documentation Platform",
  description: "Rack builder & network documentation",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-neutral-50 text-neutral-900">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
