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
  plan_polygon: [number, number][] | null;
}

export interface FloorDeviceRow {
  id: string;
  site_id: string;
  floor_id: string;
  room_id: string | null;
  device_type_id: string;
  code: string;
  name: string;
  status: "planned" | "installed";
  created_at: string;
  updated_at: string;
  x: number | null;
  y: number | null;
}

export interface FloorPlanRow {
  id: string;
  floor_id: string;
  storage_path: string;
  width_px: number;
  height_px: number;
  original_filename: string;
  source: "image" | "pdf";
  created_at: string;
  updated_at: string;
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
