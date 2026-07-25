import type { NormPoint } from "./floorPlanOps";
import { ROOM_TYPES, type RoomType } from "@/domain/hierarchy";

export type Confidence = "high" | "medium" | "low";

export interface RoomProposal {
  id: string;
  name: string;
  roomType: RoomType;
  polygon: NormPoint[];
  confidence: Confidence;
}
export interface DeviceProposal {
  id: string;
  label: string;
  typeCode: string;
  point: NormPoint;
  confidence: Confidence;
}

// The seeded category='floor' device type codes (see device_types). The AI may only ever produce
// one of these; anything else becomes TO.
export const FLOOR_TYPE_CODES = ["CAM", "AP", "TO", "RK", "ACP", "PH", "PR", "SCR", "DP", "LP", "3DP", "ISP"];
const CONFIDENCES: Confidence[] = ["high", "medium", "low"];
const MAX_PROPOSALS = 40;

const SYNONYMS: Record<string, string> = {
  accesspoint: "AP", wap: "AP", wifi: "AP",
  camera: "CAM", cctv: "CAM",
  outlet: "TO", telecomoutlet: "TO", jack: "TO", faceplate: "TO",
  rack: "RK", cabinet: "RK",
  screen: "SCR", display: "SCR", tv: "SCR", monitor: "SCR",
  printer: "PR", phone: "PH", desktop: "DP", laptop: "LP",
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function coerceTypeCode(v: unknown): string {
  if (typeof v !== "string") return "TO";
  const up = v.trim().toUpperCase();
  if (FLOOR_TYPE_CODES.includes(up)) return up;
  const key = v.trim().toLowerCase().replace(/[^a-z]/g, "");
  return SYNONYMS[key] ?? "TO";
}

/** Case-INSENSITIVE, like coerceTypeCode: a model that answers "mdf" means MDF, and silently
 *  degrading that to "other" would mis-type the room. Always returns a canonical member. */
function coerceRoomType(v: unknown): RoomType {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return ROOM_TYPES.find((t) => t.toLowerCase() === s) ?? "other";
}

function coerceConfidence(v: unknown): Confidence {
  return typeof v === "string" && (CONFIDENCES as string[]).includes(v.toLowerCase())
    ? (v.toLowerCase() as Confidence)
    : "low";
}

function coercePoint(v: unknown): NormPoint | null {
  if (!Array.isArray(v) || v.length !== 2 || !isFiniteNum(v[0]) || !isFiniteNum(v[1])) return null;
  return [clamp01(v[0]), clamp01(v[1])];
}

function coercePolygon(v: unknown): NormPoint[] | null {
  if (!Array.isArray(v)) return null;
  const pts = v.map(coercePoint).filter((p): p is NormPoint => p !== null);
  return pts.length >= 3 ? pts : null;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export function validateDeviceDiscovery(raw: unknown): DeviceProposal[] {
  const list = Array.isArray((raw as { devices?: unknown })?.devices)
    ? ((raw as { devices: unknown[] }).devices)
    : [];
  const out: DeviceProposal[] = [];
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    const point = coercePoint([r.x, r.y]);
    if (!point) continue;
    out.push({
      id: `dev-${out.length}`,
      label: str(r.label),
      typeCode: coerceTypeCode(r.typeCode),
      point,
      confidence: coerceConfidence(r.confidence),
    });
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out;
}

export function validateRoomDiscovery(raw: unknown): RoomProposal[] {
  const list = Array.isArray((raw as { rooms?: unknown })?.rooms)
    ? ((raw as { rooms: unknown[] }).rooms)
    : [];
  const out: RoomProposal[] = [];
  for (const item of list) {
    const r = (item ?? {}) as Record<string, unknown>;
    const polygon = coercePolygon(r.polygon);
    if (!polygon) continue;
    out.push({
      id: `room-${out.length}`,
      name: str(r.name),
      roomType: coerceRoomType(r.roomType),
      polygon,
      confidence: coerceConfidence(r.confidence),
    });
    if (out.length >= MAX_PROPOSALS) break;
  }
  return out;
}
