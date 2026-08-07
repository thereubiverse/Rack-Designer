import { redirect } from "next/navigation";
import { createTenantClient } from "@/lib/supabase/tenant";
import { getCurrentMember } from "@/features/auth/members";
import { listArchived } from "@/features/clients/repository";
import { buildArchiveTree } from "@/features/clients/archiveOps";
import { ArchivePanel } from "@/features/settings/ArchivePanel";
import { SettingsShell } from "@/features/settings/SettingsShell";

// Archive contents change whenever anything is archived or restored; never prerender it.
export const dynamic = "force-dynamic";

export default async function ArchiveSettings() {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  const db = createTenantClient(member);
  return (
    <SettingsShell active="archive">
      <ArchivePanel tree={buildArchiveTree(await listArchived(db))} />
    </SettingsShell>
  );
}
