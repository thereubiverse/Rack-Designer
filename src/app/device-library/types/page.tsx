import { redirect } from "next/navigation";
import { createTenantClient } from "@/lib/supabase/tenant";
import { getCurrentMember } from "@/features/auth/members";
import { listDeviceTypes } from "@/features/device-library/repository";
import { DeviceTypesManager } from "@/features/device-library/DeviceTypesManager";

export const dynamic = "force-dynamic";

export default async function DeviceTypesPage() {
  const member = await getCurrentMember();
  // Middleware already redirects an unauthenticated visitor; this covers the gap where a session
  // exists but membership was revoked between the middleware check and this render.
  if (!member) redirect("/login");

  const db = createTenantClient(member);
  const types = await listDeviceTypes(db);
  return (
    <DeviceTypesManager
      floor={types.filter((t) => t.category === "floor")}
      rack={types.filter((t) => t.category === "rack")}
    />
  );
}
