import { createServiceClient } from "@/lib/supabase/server";
import { listRacksWithPath } from "@/features/locations/repository";
import { RacksTable } from "@/features/racks/RacksTable";
import { CreateRackModal } from "@/features/racks/CreateRackModal";

export const dynamic = "force-dynamic";

export default async function RacksPage() {
  const db = createServiceClient();
  const racks = await listRacksWithPath(db);
  const { data: counts } = await db.from("rack_devices").select("rack_id");
  const byRack = new Map<string, number>();
  for (const row of (counts ?? []) as { rack_id: string }[]) {
    byRack.set(row.rack_id, (byRack.get(row.rack_id) ?? 0) + 1);
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Racks</h2>
        <CreateRackModal />
      </div>
      <RacksTable racks={racks.map((r) => ({ ...r, deviceCount: byRack.get(r.id) ?? 0 }))} />
    </div>
  );
}
