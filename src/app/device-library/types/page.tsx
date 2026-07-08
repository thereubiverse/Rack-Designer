import { createServiceClient } from "@/lib/supabase/server";
import { listDeviceTypes } from "@/features/device-library/repository";
import { DeviceTypesManager } from "@/features/device-library/DeviceTypesManager";

export const dynamic = "force-dynamic";

export default async function DeviceTypesPage() {
  const db = createServiceClient();
  const types = await listDeviceTypes(db);
  return (
    <DeviceTypesManager
      floor={types.filter((t) => t.category === "floor")}
      rack={types.filter((t) => t.category === "rack")}
    />
  );
}
