import { MEDIA, CONNECTORS, MAX_BODY_WIDTH_IN, type Media, type CountingDirection } from "@/domain/faceplate";

export interface BBox { x: number; y: number; w: number; h: number }
export interface DetectedGroup {
  media: Media;
  connector: string;
  count: number;
  rows: number;
  order: CountingDirection;
  labelPrefix?: string;
  bbox: BBox;
  rowOrientations?: ("up" | "down")[]; // one per row: which way that row's connector tabs face
}
export interface DetectedLabel { text: string; bbox: BBox }
export interface DetectedFace {
  groups: DetectedGroup[];
  modelText?: string;
  brand?: string;
  rackUnits?: number;
  widthIn?: number;
  labels?: DetectedLabel[];
  confidence: "high" | "medium" | "low";
  notes?: string;
}
export interface DeviceMatch {
  name: string;
  brand: string;
  widthIn: number;
  rackUnits: number;
  imageUrl: string;
  source: string;
}

const ORDERS: CountingDirection[] = ["ltr", "rtl", "ttb", "btt"];
const CONFIDENCES = ["high", "medium", "low"] as const;
// Common words the model may return for a media; map to our canonical set.
const MEDIA_SYNONYMS: Record<string, Media> = { ethernet: "copper", rj45: "copper", sfpplus: "sfp", displayport: "dp" };

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function coerceMedia(v: unknown): Media | null {
  if (typeof v !== "string") return null;
  const direct = v.trim().toLowerCase();
  if ((MEDIA as string[]).includes(direct)) return direct as Media;
  // Fuzzy fallback for synonyms like "sfp+" / "display port".
  const stripped = direct.replace(/[^a-z]/g, "");
  if ((MEDIA as string[]).includes(stripped)) return stripped as Media;
  return MEDIA_SYNONYMS[stripped] ?? null;
}

function coerceBBox(v: unknown): BBox {
  const b = (v ?? {}) as Record<string, unknown>;
  return {
    x: clamp(num(b.x, 0), 0, 1),
    y: clamp(num(b.y, 0), 0, 1),
    w: clamp(num(b.w, 0), 0, 1),
    h: clamp(num(b.h, 0), 0, 1),
  };
}

function coerceGroup(raw: unknown): DetectedGroup | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const media = coerceMedia(r.media);
  if (!media) return null;
  const allowed = CONNECTORS[media];
  const connector = typeof r.connector === "string" && allowed.includes(r.connector) ? r.connector : allowed[0];
  const order = ORDERS.includes(r.order as CountingDirection) ? (r.order as CountingDirection) : "ltr";
  const rows = clamp(Math.round(num(r.rows, 1)), 1, 4);
  const rowOrientations = Array.isArray(r.rowOrientations)
    ? r.rowOrientations.slice(0, rows).map((v) => (v === "up" ? "up" : "down") as "up" | "down")
    : undefined;
  return {
    media,
    connector,
    count: clamp(Math.round(num(r.count, 1)), 1, 96),
    rows,
    order,
    labelPrefix: str(r.labelPrefix),
    bbox: coerceBBox(r.bbox),
    rowOrientations,
  };
}

export function validateDetectedFace(raw: unknown): DetectedFace {
  if (typeof raw !== "object" || raw === null) throw new Error("unreadable");
  const r = raw as Record<string, unknown>;
  const groups = Array.isArray(r.groups)
    ? (r.groups.map(coerceGroup).filter((g): g is DetectedGroup => g !== null))
    : [];
  const labels = Array.isArray(r.labels)
    ? r.labels
        .map((l) => {
          const t = str((l as Record<string, unknown>)?.text);
          return t ? { text: t, bbox: coerceBBox((l as Record<string, unknown>).bbox) } : null;
        })
        .filter((l): l is DetectedLabel => l !== null)
    : undefined;
  const confidence = CONFIDENCES.includes(r.confidence as (typeof CONFIDENCES)[number]) ? (r.confidence as DetectedFace["confidence"]) : "low";
  const out: DetectedFace = { groups, confidence };
  const brand = str(r.brand); if (brand) out.brand = brand;
  const modelText = str(r.modelText); if (modelText) out.modelText = modelText;
  const notes = str(r.notes); if (notes) out.notes = notes;
  if (labels && labels.length) out.labels = labels;
  if (r.rackUnits !== undefined) out.rackUnits = clamp(Math.round(num(r.rackUnits, 1)), 1, 4);
  if (r.widthIn !== undefined) out.widthIn = clamp(num(r.widthIn, MAX_BODY_WIDTH_IN), 0.5, MAX_BODY_WIDTH_IN);
  return out;
}
