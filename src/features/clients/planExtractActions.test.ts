import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/features/auth/withMember", () => ({
  withMember: (_key: string, fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
  withEditor: (_key: string, fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
  withAdmin: (_key: string, fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn(() => ({})) }));
vi.mock("@/features/locations/repository", () => ({
  getFloorPlan: vi.fn(),
  saveFloorPlanGeometry: vi.fn(async () => {}),
}));
vi.mock("./planStorage", () => ({ downloadPlanObject: vi.fn(async () => new Uint8Array([9, 9, 9])) }));
vi.mock("./planExtract", () => ({ extractPlanGeometry: vi.fn() }));

import { extractPlanGeometryAction } from "./planExtractActions";
import { getFloorPlan, saveFloorPlanGeometry } from "@/features/locations/repository";
import { downloadPlanObject } from "./planStorage";
import { extractPlanGeometry } from "./planExtract";
import { revalidatePath } from "next/cache";

// pdf_page deliberately non-zero (2) — a hardcoded `0` in the action would still pass tests
// that used page 0, so this fixture exists specifically to catch that bug.
const plan = {
  id: "fp1",
  floor_id: "f1",
  storage_path: "SITE-A/f1.png",
  width_px: 2600,
  height_px: 1733,
  original_filename: "sheet.pdf",
  source: "pdf",
  created_at: "",
  updated_at: "",
  pdf_storage_path: "SITE-A/f1.pdf",
  pdf_page: 2,
  wall_runs: null,
  plan_labels: null,
  geometry_extracted_at: null,
};

const MOCK_BYTES = new Uint8Array([9, 9, 9]);
const WALLS = [{ x1: 0, y1: 0, x2: 1, y2: 0 }, { x1: 0, y1: 0, x2: 0, y2: 1 }];
const LABELS = [{ text: "MDF", x: 0.1, y: 0.1 }];

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFloorPlan).mockResolvedValue(plan as never);
  vi.mocked(downloadPlanObject).mockResolvedValue(MOCK_BYTES);
  vi.mocked(extractPlanGeometry).mockResolvedValue({ walls: WALLS, labels: LABELS, width: 2600, height: 1733 } as never);
  vi.mocked(saveFloorPlanGeometry).mockResolvedValue(undefined as never);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("extractPlanGeometryAction", () => {
  it("happy path: downloads the retained PDF, extracts at the STORED page, persists, and reports counts", async () => {
    // Would catch: hardcoding pageIndex 0 instead of reading plan.pdf_page, passing the wrong
    // bytes/path to downloadPlanObject or extractPlanGeometry, or dropping the persisted result.
    const res = await extractPlanGeometryAction("f1");

    expect(getFloorPlan).toHaveBeenCalledWith(expect.anything(), "f1");
    expect(downloadPlanObject).toHaveBeenCalledWith(expect.anything(), "SITE-A/f1.pdf");
    expect(extractPlanGeometry).toHaveBeenCalledWith(MOCK_BYTES, 2);
    expect(saveFloorPlanGeometry).toHaveBeenCalledWith(expect.anything(), "f1", {
      walls: WALLS,
      labels: LABELS,
    });
    expect(revalidatePath).toHaveBeenCalledWith("/clients");
    expect(res).toEqual({ ok: true, walls: 2, labels: 1 });
  });

  it("no plan row -> {ok:false}, downloadPlanObject NOT called", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue(null);
    const res = await extractPlanGeometryAction("f1");
    expect(res).toEqual({ ok: false, error: "Upload a plan first." });
    expect(downloadPlanObject).not.toHaveBeenCalled();
    expect(extractPlanGeometry).not.toHaveBeenCalled();
    expect(saveFloorPlanGeometry).not.toHaveBeenCalled();
  });

  it("pdf_storage_path null -> {ok:false}, downloadPlanObject NOT called", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue({ ...plan, pdf_storage_path: null } as never);
    const res = await extractPlanGeometryAction("f1");
    expect(res).toEqual({ ok: false, error: "This plan has no source PDF." });
    expect(downloadPlanObject).not.toHaveBeenCalled();
    expect(extractPlanGeometry).not.toHaveBeenCalled();
    expect(saveFloorPlanGeometry).not.toHaveBeenCalled();
  });

  it("getFloorPlan rejecting resolves { ok: false }, never a rejection", async () => {
    // Would catch: the getFloorPlan await sitting outside the action's try/catch, letting a
    // thrown DB error escape as an unhandled rejection instead of a returned error result.
    vi.mocked(getFloorPlan).mockRejectedValue(new Error("db exploded"));
    await expect(extractPlanGeometryAction("f1")).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(downloadPlanObject).not.toHaveBeenCalled();
  });

  it("extractPlanGeometry rejecting resolves { ok: false }, saveFloorPlanGeometry NOT called", async () => {
    // Would catch: the extractPlanGeometry await sitting outside the try/catch (malformed/
    // encrypted PDF path), or persisting a partial/undefined result after a failed extraction.
    vi.mocked(extractPlanGeometry).mockRejectedValue(new Error("bad pdf"));
    await expect(extractPlanGeometryAction("f1")).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(saveFloorPlanGeometry).not.toHaveBeenCalled();
  });
});
