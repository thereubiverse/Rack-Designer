import type { RoomType } from "@/domain/hierarchy";

export interface ClientRow {
  id: string;
  code: string;
  name: string;
  created_at: string;
}

export interface SiteRow {
  id: string;
  client_id: string;
  code: string;
  name: string;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  geocode_status: "pending" | "ok" | "not_found" | "failed";
  geocoded_at: string | null;
  created_at: string;
}

export interface FloorRow {
  id: string;
  site_id: string;
  code: string;
  name: string | null;
  sort_order: number;
  created_at: string;
}

export interface RoomRow {
  id: string;
  floor_id: string;
  code: string;
  name: string | null;
  type: RoomType;
  created_at: string;
}

export interface RackRow {
  id: string;
  room_id: string;
  code: string;
  name: string | null;
  height_u: number;
  created_at: string;
  updated_at: string;
}
