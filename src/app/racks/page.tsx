import { createServiceClient } from "@/lib/supabase/server";
import { buildLabel } from "@/domain/naming";
import type { RoomType } from "@/domain/hierarchy";
import { RacksTable, type RackWithPath } from "@/features/racks/RacksTable";
import { CreateRackModal } from "@/features/racks/CreateRackModal";

export const dynamic = "force-dynamic";

interface RackJoinRow {
  id: string;
  code: string;
  height_u: number;
  rooms: {
    code: string;
    type: RoomType;
    floors: {
      code: string;
      sites: { code: string };
    };
  };
}

async function listRacksWithPath(db: ReturnType<typeof createServiceClient>): Promise<RackWithPath[]> {
  const { data, error } = await db
    .from("racks")
    .select("id, code, height_u, rooms!inner(code, type, floors!inner(code, sites!inner(code)))")
    .order("code", { ascending: true });
  if (error) throw new Error(`listRacksWithPath: ${error.message}`);

  const rows = (data ?? []) as unknown as RackJoinRow[];
  return rows.map((r) => {
    const siteCode = r.rooms.floors.sites.code;
    const floorCode = r.rooms.floors.code;
    const roomCode = r.rooms.code;
    return {
      id: r.id,
      label: buildLabel({ site: siteCode, floor: floorCode, room: roomCode, rack: r.code }),
      siteCode,
      floorCode,
      roomCode,
      roomType: r.rooms.type,
      rackCode: r.code,
      heightU: r.height_u,
    };
  });
}

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
