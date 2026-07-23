import type { FloorDeviceRow, RoomRow } from "@/lib/supabase/types";

/** Next free label for a type at this site: lowest gap, 2-digit padded (CAM01), growing naturally
 *  past 99 (CAM100). The suffix must be the ENTIRE remainder after the type code, so TOX01 never
 *  counts as a TO code. */
export function suggestDeviceCode(typeCode: string, existingCodes: string[]): string {
  const taken = new Set<number>();
  const re = new RegExp(`^${typeCode}(\\d+)$`);
  for (const code of existingCodes) {
    const m = re.exec(code);
    if (m) taken.add(Number(m[1]));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `${typeCode}${String(n).padStart(2, "0")}`;
}

/** Room sections (sorted by room code, devices sorted by code inside) plus a floor-level bucket.
 *  A device whose room_id matches no known room lands in floorLevel — a device must NEVER
 *  silently vanish from the page, whatever the data says. */
export function groupDevicesByRoom(
  rooms: RoomRow[],
  devices: FloorDeviceRow[]
): { sections: { room: RoomRow; devices: FloorDeviceRow[] }[]; floorLevel: FloorDeviceRow[] } {
  const byCode = (a: { code: string }, b: { code: string }) => a.code.localeCompare(b.code);
  const sections = [...rooms].sort(byCode).map((room) => ({
    room,
    devices: devices.filter((d) => d.room_id === room.id).sort(byCode),
  }));
  const known = new Set(rooms.map((r) => r.id));
  const floorLevel = devices.filter((d) => d.room_id === null || !known.has(d.room_id)).sort(byCode);
  return { sections, floorLevel };
}
