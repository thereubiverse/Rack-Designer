import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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
import { downloadPlanObject } from "./planStorage";
import { resolveGeminiKey } from "@/features/settings/deviceWizardSettings";
import { geminiPlanBackend } from "./ai/planVisionBackend";

const plan = { id: "p1", floor_id: "f1", storage_path: "SITE-A/f1.png", width_px: 640, height_px: 480,
  original_filename: "", source: "image", created_at: "", updated_at: "" };

// The bytes downloadPlanObject is mocked to resolve with (see vi.mock above) — kept as a named
// constant so tests can independently compute the exact base64 the action must produce, rather
// than assuming the encoding step worked.
const MOCK_BYTES = new Uint8Array([1, 2, 3]);
const EXPECTED_BASE64 = Buffer.from(MOCK_BYTES).toString("base64");

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFloorPlan).mockResolvedValue(plan as never);
  vi.mocked(resolveGeminiKey).mockResolvedValue("key-123");
  // vi.clearAllMocks() clears call history but NOT a previously-set mockResolvedValue/
  // mockRejectedValue implementation — re-assert the default here so a rejection set by one
  // test (e.g. the "downloadPlanObject rejecting" case below) can't leak into a later test.
  vi.mocked(downloadPlanObject).mockResolvedValue(MOCK_BYTES);
  // The action deliberately logs on error paths (see discoverActions.ts catch blocks) — silence
  // that expected noise so test output stays pristine, and restore it after each test.
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
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

  it("threads floorId, the plan-derived storage path, and the encoded image through to every dependency", async () => {
    // Would catch: prepare() ignoring the floorId argument, using the wrong/client-supplied
    // storage path instead of the plan row's, dropping the apiKey, or a broken/missing
    // base64 encoding step.
    vi.mocked(geminiPlanBackend.discoverDevices).mockResolvedValue({ devices: [] });

    await discoverDevicesAction("f1");

    expect(getFloorPlan).toHaveBeenCalledWith(expect.anything(), "f1");
    expect(downloadPlanObject).toHaveBeenCalledWith(expect.anything(), "SITE-A/f1.png");
    expect(geminiPlanBackend.discoverDevices).toHaveBeenCalledWith({
      imageBase64: EXPECTED_BASE64,
      mimeType: "image/png",
      apiKey: "key-123",
    });
  });

  it("no plan → error, backend never called", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue(null);
    const res = await discoverDevicesAction("f1");
    expect(res.ok).toBe(false);
    expect(geminiPlanBackend.discoverDevices).not.toHaveBeenCalled();
  });

  it("no key → 'no-key', neither download nor backend is called", async () => {
    vi.mocked(resolveGeminiKey).mockResolvedValue(null);
    const res = await discoverDevicesAction("f1");
    expect(res).toEqual({ ok: false, error: "no-key" });
    expect(downloadPlanObject).not.toHaveBeenCalled();
    expect(geminiPlanBackend.discoverDevices).not.toHaveBeenCalled();
  });

  it("backend throws → friendly error, never throws to caller", async () => {
    vi.mocked(geminiPlanBackend.discoverDevices).mockRejectedValue(new Error("503 high demand"));
    const res = await discoverDevicesAction("f1");
    expect(res.ok).toBe(false);
  });

  it("getFloorPlan rejecting (e.g. a transient DB error) resolves to { ok: false }, never a rejection", async () => {
    // Would catch: prepare()'s await sitting outside the action's try/catch, letting a thrown
    // DB error escape as an unhandled rejection instead of a returned error result.
    vi.mocked(getFloorPlan).mockRejectedValue(new Error("db exploded"));
    await expect(discoverDevicesAction("f1")).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(geminiPlanBackend.discoverDevices).not.toHaveBeenCalled();
  });

  it("downloadPlanObject rejecting (e.g. a transient storage error) resolves to { ok: false }, never a rejection", async () => {
    // Would catch the same missing try/catch coverage, specifically around the storage download
    // step rather than the DB lookup step.
    vi.mocked(downloadPlanObject).mockRejectedValue(new Error("storage exploded"));
    await expect(discoverDevicesAction("f1")).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(geminiPlanBackend.discoverDevices).not.toHaveBeenCalled();
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

  it("threads floorId, the plan-derived storage path, and the encoded image through to every dependency", async () => {
    // Same threading guarantee as discoverDevicesAction's equivalent test, for the rooms path.
    vi.mocked(geminiPlanBackend.discoverRooms).mockResolvedValue({ rooms: [] });

    await discoverRoomsAction("f1");

    expect(getFloorPlan).toHaveBeenCalledWith(expect.anything(), "f1");
    expect(downloadPlanObject).toHaveBeenCalledWith(expect.anything(), "SITE-A/f1.png");
    expect(geminiPlanBackend.discoverRooms).toHaveBeenCalledWith({
      imageBase64: EXPECTED_BASE64,
      mimeType: "image/png",
      apiKey: "key-123",
    });
  });
});
