import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { getClientByCode, getSiteByCode, listRacksForSite } from "@/features/clients/repository";
import { listFloorsForSite, listRoomsForSite, listFloorDevicesForSite } from "@/features/locations/repository";
import { listDeviceTypes } from "@/features/device-library/repository";
import { SiteDetail } from "@/features/clients/SiteDetail";

export const dynamic = "force-dynamic";

export default async function SitePage({ params }: { params: Promise<{ clientCode: string; siteCode: string }> }) {
  const { clientCode, siteCode } = await params;
  const db = createServiceClient();
  const client = await getClientByCode(db, clientCode);
  if (!client) notFound();
  const site = await getSiteByCode(db, client.id, siteCode);
  if (!site) notFound();

  const [racks, floors, rooms, devices, deviceTypes] = await Promise.all([
    listRacksForSite(db, site.id),
    listFloorsForSite(db, site.id),
    listRoomsForSite(db, site.id),
    listFloorDevicesForSite(db, site.id),
    listDeviceTypes(db),
  ]);

  return (
    <SiteDetail
      client={client}
      site={site}
      racks={racks}
      floors={floors}
      rooms={rooms}
      devices={devices}
      deviceTypes={deviceTypes.filter((t) => t.category === "floor")}
    />
  );
}
