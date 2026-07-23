import { notFound } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { getClientByCode, getSiteByCode, listRacksForSite } from "@/features/clients/repository";
import {
  listFloorsForSite,
  listRoomsForSite,
  listFloorDevicesForSite,
  listFloorPlansForSite,
} from "@/features/locations/repository";
import { listDeviceTypes } from "@/features/device-library/repository";
import { createPlanSignedUrl } from "@/features/clients/planStorage";
import { SiteDetail } from "@/features/clients/SiteDetail";

export const dynamic = "force-dynamic";

export default async function SitePage({ params }: { params: Promise<{ clientCode: string; siteCode: string }> }) {
  const { clientCode, siteCode } = await params;
  const db = createServiceClient();
  const client = await getClientByCode(db, clientCode);
  if (!client) notFound();
  const site = await getSiteByCode(db, client.id, siteCode);
  if (!site) notFound();

  const [racks, floors, rooms, devices, deviceTypes, plans] = await Promise.all([
    listRacksForSite(db, site.id),
    listFloorsForSite(db, site.id),
    listRoomsForSite(db, site.id),
    listFloorDevicesForSite(db, site.id),
    listDeviceTypes(db),
    listFloorPlansForSite(db, site.id),
  ]);

  // Signed URLs are generated here, not passed through as bare storage paths — the floor tab
  // never sees anything but a short-lived, ready-to-render URL. Keyed by floor_id (not plan id)
  // since that's how SiteDetail looks a plan up for the active floor.
  const planUrls: Record<string, string> = {};
  await Promise.all(
    plans.map(async (plan) => {
      const url = await createPlanSignedUrl(db, plan.storage_path);
      if (url) planUrls[plan.floor_id] = url;
    })
  );

  return (
    <SiteDetail
      client={client}
      site={site}
      racks={racks}
      floors={floors}
      rooms={rooms}
      devices={devices}
      deviceTypes={deviceTypes.filter((t) => t.category === "floor")}
      plans={plans}
      planUrls={planUrls}
    />
  );
}
