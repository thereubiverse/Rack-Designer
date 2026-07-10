"use server";

import { runDetectPorts, runIdentifyDevice, type DetectResult, type IdentifyResult } from "./pipeline";
import { geminiVisionBackend } from "./visionBackend";
import { duckDuckGoSearcher } from "./search";
import { resolveGeminiKey } from "@/features/settings/deviceWizardSettings";
import { dbSettingsStore } from "@/features/settings/store";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // cap uploads / fetched images at 8 MB

export async function detectPortsAction(input: { imageBase64: string; mimeType: string; modelHint?: string }): Promise<DetectResult> {
  if (!input.imageBase64) return { ok: false, error: "No image provided." };
  if (input.imageBase64.length > MAX_IMAGE_BYTES * (4 / 3)) return { ok: false, error: "Image is too large (max 8 MB)." };
  const apiKey = await resolveGeminiKey(dbSettingsStore);
  if (!apiKey) return { ok: false, error: "no-key" };
  return runDetectPorts(geminiVisionBackend, { ...input, apiKey });
}

async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  if (!mimeType.startsWith("image/")) throw new Error("not an image");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new Error("image too large");
  return { base64: buf.toString("base64"), mimeType };
}

export async function identifyDeviceAction(modelName: string): Promise<IdentifyResult> {
  const name = modelName.trim();
  if (!name) return { ok: false, error: "Enter a model name to search." };
  return runIdentifyDevice(duckDuckGoSearcher, fetchImageAsBase64, name);
}
