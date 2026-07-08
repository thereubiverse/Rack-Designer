import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTemplates, listDeviceTypes, listBrands } from "@/features/device-library/repository";
import { EditorLauncher } from "@/features/device-library/editor/EditorLauncher";

export const dynamic = "force-dynamic";

export default async function DeviceLibraryPage() {
  const db = createServiceClient();
  const [rows, types, brands] = await Promise.all([
    listDeviceTemplates(db), listDeviceTypes(db), listBrands(db),
  ]);
  return <EditorLauncher rows={rows} types={types.filter((t) => t.category === "rack")} brands={brands} />;
}
