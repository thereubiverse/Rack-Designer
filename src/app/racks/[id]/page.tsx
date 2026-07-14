import { createServiceClient } from "@/lib/supabase/server";
import { getRack, listRackDevices } from "@/features/racks/repository";
import { listConnections } from "@/features/racks/connectionsRepository";
import { listDeviceTypes, listTemplatesForType } from "@/features/device-library/repository";
import { RackBuilder } from "@/features/racks/RackBuilder";

export const dynamic = "force-dynamic";

export default async function RackBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceClient();
  const [rack, devices, types, connections] = await Promise.all([
    getRack(db, id), listRackDevices(db, id), listDeviceTypes(db), listConnections(db, id),
  ]);
  const rackTypes = types.filter((t) => t.category === "rack");
  // All templates for all rack types, keyed by type — one round trip per type is fine at this scale.
  const templatesByType = Object.fromEntries(
    await Promise.all(rackTypes.map(async (t) => [t.id, await listTemplatesForType(db, t.id)])),
  );
  return <RackBuilder rack={rack} initialDevices={devices} initialConnections={connections}
    types={rackTypes} templatesByType={templatesByType} />;
}
