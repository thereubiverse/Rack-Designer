import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn(() => ({})) }));
vi.mock("@/features/locations/repository", () => ({ getFloorPlan: vi.fn() }));
vi.mock("./planStorage", () => ({ downloadPlanObject: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
vi.mock("@/features/settings/deviceWizardSettings", () => ({ resolveGeminiKey: vi.fn(async () => "key-123") }));
vi.mock("@/features/settings/store", () => ({ dbSettingsStore: {} }));
vi.mock("./ai/planVisionBackend", () => ({
  geminiPlanBackend: { discoverRooms: vi.fn(), discoverDevices: vi.fn() },
}));

import { discoverRoomsAction, discoverDevicesAction } from "./discoverActions";
import { getFloorPlan } from "@/features/locations/repository";
import { resolveGeminiKey } from "@/features/settings/deviceWizardSettings";
import { geminiPlanBackend } from "./ai/planVisionBackend";

const plan = { id: "p1", floor_id: "f1", storage_path: "SITE-A/f1.png", width_px: 640, height_px: 480,
  original_filename: "", source: "image", created_at: "", updated_at: "" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFloorPlan).mockResolvedValue(plan as never);
  vi.mocked(resolveGeminiKey).mockResolvedValue("key-123");
});

describe("discoverDevicesAction", () => {
  it("returns normalized, clamped, type-coerced proposals", async () => {
    vi.mocked(geminiPlanBackend.discoverDevices).mockResolvedValue({
      devices: [{ label: "CAM01", typeCode: "spaceship", x: 1.5, y: 0.5 }],
    });
    const res = await discoverDevicesAction("f1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.proposals[0].typeCode).toBe("TO"); // unknown coerced
      expect(res.proposals[0].point).toEqual([1, 0.5]); // clamped
    }
  });
  it("no plan → error, backend never called", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue(null);
    const res = await discoverDevicesAction("f1");
    expect(res.ok).toBe(false);
    expect(geminiPlanBackend.discoverDevices).not.toHaveBeenCalled();
  });
  it("no key → 'no-key', backend never called", async () => {
    vi.mocked(resolveGeminiKey).mockResolvedValue(null);
    const res = await discoverDevicesAction("f1");
    expect(res).toEqual({ ok: false, error: "no-key" });
    expect(geminiPlanBackend.discoverDevices).not.toHaveBeenCalled();
  });
  it("backend throws → friendly error, never throws to caller", async () => {
    vi.mocked(geminiPlanBackend.discoverDevices).mockRejectedValue(new Error("503 high demand"));
    const res = await discoverDevicesAction("f1");
    expect(res.ok).toBe(false);
  });
});

describe("discoverRoomsAction", () => {
  it("returns validated room proposals", async () => {
    vi.mocked(geminiPlanBackend.discoverRooms).mockResolvedValue({
      rooms: [{ name: "MDF", roomType: "MDF", polygon: [[0, 0], [1, 0], [1, 1]] }],
    });
    const res = await discoverRoomsAction("f1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.proposals[0].polygon).toHaveLength(3);
  });
});
