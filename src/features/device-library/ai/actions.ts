"use server";

import { runDetectPorts, runLookupByName, type DetectResult } from "./pipeline";
import { geminiVisionBackend, geminiNameLookup } from "./visionBackend";
import { resolveGeminiKey } from "@/features/settings/deviceWizardSettings";
import { dbSettingsStore } from "@/features/settings/store";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // cap uploads at 8 MB

export async function detectPortsAction(input: { imageBase64: string; mimeType: string; modelHint?: string }): Promise<DetectResult> {
  if (!input.imageBase64) return { ok: false, error: "No image provided." };
  if (input.imageBase64.length > MAX_IMAGE_BYTES * (4 / 3)) return { ok: false, error: "Image is too large (max 8 MB)." };
  const apiKey = await resolveGeminiKey(dbSettingsStore);
  if (!apiKey) return { ok: false, error: "no-key" };
  return runDetectPorts(geminiVisionBackend, { ...input, apiKey });
}

// Model-name search: generate the layout from Gemini's knowledge (no image, no grounding).
export async function identifyDeviceAction(modelName: string): Promise<DetectResult> {
  const name = modelName.trim();
  if (!name) return { ok: false, error: "Enter a model name to search." };
  const apiKey = await resolveGeminiKey(dbSettingsStore);
  if (!apiKey) return { ok: false, error: "no-key" };
  return runLookupByName((n) => geminiNameLookup(n, apiKey), name);
}
