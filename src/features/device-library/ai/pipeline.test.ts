import { describe, it, expect, vi } from "vitest";
import { runDetectPorts, runLookupByName } from "./pipeline";
import type { VisionBackend } from "./visionBackend";

const okRaw = { groups: [{ media: "copper", connector: "RJ45", count: 24, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "high" };

describe("runDetectPorts", () => {
  it("validates the backend's raw output into a DetectedFace", async () => {
    const backend: VisionBackend = { detect: vi.fn().mockResolvedValue(okRaw) };
    const r = await runDetectPorts(backend, { imageBase64: "x", mimeType: "image/png", apiKey: "test-key" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.face.groups).toHaveLength(1);
  });

  it("returns a typed error when the model output is unreadable", async () => {
    const backend: VisionBackend = { detect: vi.fn().mockResolvedValue("garbage") };
    const r = await runDetectPorts(backend, { imageBase64: "x", mimeType: "image/png", apiKey: "test-key" });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("read") });
  });

  it("returns a typed error when the backend throws", async () => {
    const backend: VisionBackend = { detect: vi.fn().mockRejectedValue(new Error("boom")) };
    const r = await runDetectPorts(backend, { imageBase64: "x", mimeType: "image/png", apiKey: "test-key" });
    expect(r.ok).toBe(false);
  });
});

describe("runLookupByName", () => {
  it("validates the lookup's raw output into a DetectedFace", async () => {
    const lookup = vi.fn().mockResolvedValue(okRaw);
    const r = await runLookupByName(lookup, "Cisco Catalyst 9200-24T");
    expect(lookup).toHaveBeenCalledWith("Cisco Catalyst 9200-24T");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.face.groups).toHaveLength(1);
  });

  it("returns a typed error when the lookup output is unreadable", async () => {
    const r = await runLookupByName(vi.fn().mockResolvedValue("garbage"), "x");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("identify") });
  });

  it("returns a typed error when the lookup throws", async () => {
    const r = await runLookupByName(vi.fn().mockRejectedValue(new Error("boom")), "x");
    expect(r.ok).toBe(false);
  });
});
