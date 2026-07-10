import { describe, it, expect, vi } from "vitest";
import { runDetectPorts, runIdentifyDevice } from "./pipeline";
import type { VisionBackend } from "./visionBackend";
import type { Searcher } from "./search";

const okRaw = { groups: [{ media: "copper", connector: "RJ45", count: 24, rows: 2, order: "ltr", bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "high" };

describe("runDetectPorts", () => {
  it("validates the backend's raw output into a DetectedFace", async () => {
    const backend: VisionBackend = { detect: vi.fn().mockResolvedValue(okRaw) };
    const r = await runDetectPorts(backend, { imageBase64: "x", mimeType: "image/png" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.face.groups).toHaveLength(1);
  });

  it("returns a typed error when the model output is unreadable", async () => {
    const backend: VisionBackend = { detect: vi.fn().mockResolvedValue("garbage") };
    const r = await runDetectPorts(backend, { imageBase64: "x", mimeType: "image/png" });
    expect(r).toEqual({ ok: false, error: expect.stringContaining("read") });
  });

  it("returns a typed error when the backend throws", async () => {
    const backend: VisionBackend = { detect: vi.fn().mockRejectedValue(new Error("boom")) };
    const r = await runDetectPorts(backend, { imageBase64: "x", mimeType: "image/png" });
    expect(r.ok).toBe(false);
  });
});

describe("runIdentifyDevice", () => {
  const searcher: Searcher = { find: vi.fn().mockResolvedValue({ title: "Cisco Catalyst 9200", description: "1U switch", imageUrl: "http://img/x.png", source: "duckduckgo" }) };
  const fetchImage = vi.fn().mockResolvedValue({ base64: "AAAA", mimeType: "image/png" });

  it("returns a DeviceMatch + fetched image", async () => {
    const r = await runIdentifyDevice(searcher, fetchImage, "C9200-24T");
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.match.brand).toBe("Cisco"); expect(r.imageBase64).toBe("AAAA"); }
  });

  it("returns a typed error when nothing is found", async () => {
    const none: Searcher = { find: vi.fn().mockResolvedValue(null) };
    const r = await runIdentifyDevice(none, fetchImage, "nothing");
    expect(r.ok).toBe(false);
  });
});
