import { redirect } from "next/navigation";
import { createTenantClient } from "@/lib/supabase/tenant";
import { getCurrentMember } from "@/features/auth/members";
import { listDeviceTemplates, listDeviceTypes, listBrands } from "@/features/device-library/repository";
import { EditorLauncher } from "@/features/device-library/editor/EditorLauncher";
import { getDeviceWizardSettings } from "@/features/settings/getDeviceWizardSettings";

export const dynamic = "force-dynamic";

export default async function DeviceLibraryPage() {
  const member = await getCurrentMember();
  if (!member) redirect("/login");

  const db = createTenantClient(member);
  const [rows, types, brands, wizard] = await Promise.all([
    listDeviceTemplates(db), listDeviceTypes(db), listBrands(db), getDeviceWizardSettings(member.orgId),
  ]);
  return <EditorLauncher rows={rows} types={types.filter((t) => t.category === "rack")} brands={brands} wizard={wizard} />;
}
