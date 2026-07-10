import { validateDetectedFace, type DetectedFace } from "./aiDetect";
import type { VisionBackend, VisionInput } from "./visionBackend";

export type DetectResult = { ok: true; face: DetectedFace } | { ok: false; error: string };

const busyMsg = (detail: string) =>
  /\b(503|429|500|overloaded|high demand|Service Unavailable)\b/i.test(detail);

export async function runDetectPorts(backend: VisionBackend, input: VisionInput): Promise<DetectResult> {
  let raw: unknown;
  try {
    raw = await backend.detect(input);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[detectPorts] vision backend error:", detail);
    return {
      ok: false,
      error: busyMsg(detail)
        ? "The vision model is busy right now — please try again in a moment."
        : "Couldn't reach the vision model. Try again or upload a clearer photo.",
    };
  }
  try {
    return { ok: true, face: validateDetectedFace(raw) };
  } catch {
    return { ok: false, error: "Couldn't read a device from this image." };
  }
}

// Model-name lookup: generate a DetectedFace from the model's knowledge (no image).
export async function runLookupByName(
  lookup: (modelName: string) => Promise<unknown>,
  modelName: string,
): Promise<DetectResult> {
  let raw: unknown;
  try {
    raw = await lookup(modelName);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("[nameLookup] error:", detail);
    return {
      ok: false,
      error: busyMsg(detail)
        ? "The model is busy right now — please try again in a moment."
        : "Couldn't look up that model. Try again or upload a photo.",
    };
  }
  try {
    return { ok: true, face: validateDetectedFace(raw) };
  } catch {
    return { ok: false, error: "Couldn't identify this model — try a different name or upload a photo." };
  }
}
