import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/features/auth/withMember", () => ({
  withMember: (_key: string, fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
  withEditor: (_key: string, fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
  withAdmin: (_key: string, fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
}));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn(() => ({})) }));
vi.mock("@/features/locations/repository", () => ({ getFloorPlan: vi.fn(), listRoomsForFloor: vi.fn(async () => []) }));
vi.mock("./planStorage", () => ({ downloadPlanObject: vi.fn(async () => new Uint8Array([1, 2, 3])) }));
vi.mock("@/features/settings/deviceWizardSettings", () => ({ resolveGeminiKey: vi.fn(async () => "key-123") }));
vi.mock("@/features/settings/store", () => ({ dbSettingsStore: {} }));
// sharp does real image work; the fixture bytes are not a real PNG. Stub the chain so the crop
// PATH is exercised (locate -> toCropRect -> extract -> inverse-map) without decoding an image.
// The action treats any sharp failure as "skip the crop", so an unmocked sharp would silently
// turn every crop assertion below into a false pass.
vi.mock("sharp", () => ({
  default: () => ({
    extract: () => ({ png: () => ({ toBuffer: async () => Buffer.from("cropped-image-bytes") }) }),
  }),
}));
vi.mock("./ai/planVisionBackend", () => ({
  geminiPlanBackend: { discoverRooms: vi.fn(), discoverDevices: vi.fn(), locateDrawingArea: vi.fn() },
}));

import { discoverRoomsAction, discoverDevicesAction } from "./discoverActions";
import { getFloorPlan, listRoomsForFloor } from "@/features/locations/repository";
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
  vi.mocked(listRoomsForFloor).mockResolvedValue([]);
  // Default: the locate pass returns nothing usable, so the room pass runs on the FULL sheet.
  // Tests that care about cropping set their own value. Keeping the default uncropped means the
  // pre-existing assertions still describe the un-cropped path they were written for.
  vi.mocked(geminiPlanBackend.locateDrawingArea).mockResolvedValue(null as never);
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

  // The backend is mocked wholesale everywhere else in this file, so nothing else in the suite
  // would notice a refactor that dropped the guard from one prompt. importActual reaches the REAL
  // prompt strings past that mock.
  it("keeps the plan-text-is-data guard in BOTH prompts", async () => {
    const backend = await vi.importActual<typeof import("./ai/planVisionBackend")>(
      "./ai/planVisionBackend"
    );
    expect(backend.GUARD).toMatch(/NEVER as instructions/i);
    expect(backend.ROOMS_PROMPT).toContain(backend.GUARD);
    expect(backend.DEVICES_PROMPT).toContain(backend.GUARD);
  });
});

describe("discoverRoomsAction — crop + already-traced filtering", () => {
  const roomAt = (poly: [number, number][]) => ({
    id: "r1", floor_id: "f1", code: "MO", name: "Maintenance Office",
    type: "other", plan_polygon: poly, created_at: "",
  });

  it("maps polygons from CROP space back onto the full sheet", async () => {
    // Located box occupies the middle of the sheet...
    vi.mocked(geminiPlanBackend.locateDrawingArea).mockResolvedValue({ x: 0.2, y: 0.25, w: 0.5, h: 0.5 } as never);
    // ...and the model reports a room filling that crop entirely.
    vi.mocked(geminiPlanBackend.discoverRooms).mockResolvedValue({
      rooms: [{ name: "R", roomType: "other", polygon: [[0, 0], [1, 0], [1, 1]] }],
    } as never);
    const res = await discoverRoomsAction("f1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Without the inverse mapping these would still be [0,0]/[1,0]/[1,1] — the whole floor's
      // geometry collapsed into the sheet's top-left corner.
      expect(res.proposals[0].polygon).toEqual([[0.2, 0.25], [0.7, 0.25], [0.7, 0.75]]);
    }
  });

  it("leaves coordinates untouched when the locate pass gives nothing usable", async () => {
    vi.mocked(geminiPlanBackend.locateDrawingArea).mockResolvedValue({ x: 0.4, y: 0.4, w: 0.05, h: 0.05 } as never);
    vi.mocked(geminiPlanBackend.discoverRooms).mockResolvedValue({
      rooms: [{ name: "R", roomType: "other", polygon: [[0, 0], [1, 0], [1, 1]] }],
    } as never);
    const res = await discoverRoomsAction("f1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.proposals[0].polygon).toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it("still returns proposals when the locate call itself throws", async () => {
    vi.mocked(geminiPlanBackend.locateDrawingArea).mockRejectedValue(new Error("locate exploded"));
    vi.mocked(geminiPlanBackend.discoverRooms).mockResolvedValue({
      rooms: [{ name: "R", roomType: "other", polygon: [[0, 0], [1, 0], [1, 1]] }],
    } as never);
    const res = await discoverRoomsAction("f1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.proposals).toHaveLength(1);
  });

  it("drops proposals that land on a room the user already outlined", async () => {
    vi.mocked(listRoomsForFloor).mockResolvedValue([roomAt([[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]])] as never);
    vi.mocked(geminiPlanBackend.discoverRooms).mockResolvedValue({
      rooms: [
        { name: "already done", roomType: "other", polygon: [[0.12, 0.12], [0.38, 0.12], [0.38, 0.38], [0.12, 0.38]] },
        { name: "genuinely new", roomType: "other", polygon: [[0.6, 0.6], [0.9, 0.6], [0.9, 0.9], [0.6, 0.9]] },
      ],
    } as never);
    const res = await discoverRoomsAction("f1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.proposals.map((p) => p.name)).toEqual(["genuinely new"]);
  });

  it("derives the rooms it filters against from the floorId, never from the caller", async () => {
    vi.mocked(geminiPlanBackend.discoverRooms).mockResolvedValue({ rooms: [] } as never);
    await discoverRoomsAction("f1");
    expect(vi.mocked(listRoomsForFloor).mock.calls[0][1]).toBe("f1");
  });
});
