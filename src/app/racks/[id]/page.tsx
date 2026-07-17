import { createServiceClient } from "@/lib/supabase/server";
import { getRack, listRackDevices } from "@/features/racks/repository";
import { listConnections } from "@/features/racks/connectionsRepository";
import { listPortEndpoints } from "@/features/racks/endpointsRepository";
import { listSiteScope } from "@/features/racks/siteScope";
import { listDeviceTypes, listTemplatesForType, listBrands } from "@/features/device-library/repository";
import { getDeviceWizardSettings } from "@/features/settings/actions";
import { RackBuilder } from "@/features/racks/RackBuilder";

export const dynamic = "force-dynamic";

export default async function RackBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = createServiceClient();
  const [rack, devices, types, connections, endpoints, siteScope, brands, wizard] = await Promise.all([
    getRack(db, id), listRackDevices(db, id), listDeviceTypes(db), listConnections(db, id),
    listPortEndpoints(db, id), listSiteScope(db, id), listBrands(db), getDeviceWizardSettings(),
  ]);
  const rackTypes = types.filter((t) => t.category === "rack");
  const floorTypes = types.filter((t) => t.category === "floor");
  // All templates for all rack types, keyed by type — one round trip per type is fine at this scale.
  const templatesByType = Object.fromEntries(
    await Promise.all(rackTypes.map(async (t) => [t.id, await listTemplatesForType(db, t.id)])),
  );
  return <RackBuilder rack={rack} initialDevices={devices} initialConnections={connections}
    initialEndpoints={endpoints} siteScope={siteScope} floorTypes={floorTypes}
    types={rackTypes} templatesByType={templatesByType} brands={brands} wizard={wizard} />;
}
