import { createServiceClient } from "@/lib/supabase/server";
import { listArchived } from "@/features/clients/repository";
import { buildArchiveTree } from "@/features/clients/archiveOps";
import { ArchivePanel } from "@/features/settings/ArchivePanel";
import { SettingsShell } from "@/features/settings/SettingsShell";

// Archive contents change whenever anything is archived or restored; never prerender it.
export const dynamic = "force-dynamic";

export default async function ArchiveSettings() {
  const db = createServiceClient();
  return (
    <SettingsShell active="archive">
      <ArchivePanel tree={buildArchiveTree(await listArchived(db))} />
    </SettingsShell>
  );
}
