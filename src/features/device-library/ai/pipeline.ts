import { validateDetectedFace, type DetectedFace, type DeviceMatch } from "./aiDetect";
import { parseDeviceMatch, type Searcher } from "./search";
import type { VisionBackend, VisionInput } from "./visionBackend";

export type DetectResult = { ok: true; face: DetectedFace } | { ok: false; error: string };

export async function runDetectPorts(backend: VisionBackend, input: VisionInput): Promise<DetectResult> {
  let raw: unknown;
  try {
    raw = await backend.detect(input);
  } catch {
    return { ok: false, error: "The vision service could not be reached. Try again or upload a clearer photo." };
  }
  try {
    return { ok: true, face: validateDetectedFace(raw) };
  } catch {
    return { ok: false, error: "Couldn't read a device from this image." };
  }
}

export type IdentifyResult =
  | { ok: true; match: DeviceMatch; imageBase64: string; mimeType: string }
  | { ok: false; error: string };

export async function runIdentifyDevice(
  searcher: Searcher,
  fetchImage: (url: string) => Promise<{ base64: string; mimeType: string }>,
  modelName: string,
): Promise<IdentifyResult> {
  let hit;
  try {
    hit = await searcher.find(modelName);
  } catch {
    return { ok: false, error: "Search is unavailable — upload a photo instead." };
  }
  if (!hit) return { ok: false, error: "No matching device image found — upload a photo instead." };
  try {
    const img = await fetchImage(hit.imageUrl);
    return { ok: true, match: parseDeviceMatch(hit, modelName), imageBase64: img.base64, mimeType: img.mimeType };
  } catch {
    return { ok: false, error: "Found a match but couldn't load its image — upload a photo instead." };
  }
}
