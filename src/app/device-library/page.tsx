import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTemplates, listDeviceTypes, listBrands } from "@/features/device-library/repository";
import { EditorLauncher } from "@/features/device-library/editor/EditorLauncher";
import { getDeviceWizardSettings } from "@/features/settings/actions";

export const dynamic = "force-dynamic";

export default async function DeviceLibraryPage() {
  const db = createServiceClient();
  const [rows, types, brands, wizard] = await Promise.all([
    listDeviceTemplates(db), listDeviceTypes(db), listBrands(db), getDeviceWizardSettings(),
  ]);
  return <EditorLauncher rows={rows} types={types.filter((t) => t.category === "rack")} brands={brands} wizard={wizard} />;
}
