import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn(() => ({})) }));
vi.mock("@/features/locations/repository", () => ({ getFloorPlan: vi.fn() }));
vi.mock("./planStorage", () => ({ downloadPlanObject: vi.fn() }));
vi.mock("./planRaster", () => ({ renderPlanGrey: vi.fn() }));
vi.mock("./symbolMatch", () => ({ extractTemplate: vi.fn(), matchSymbol: vi.fn() }));

import { discoverSymbolsAction } from "./symbolActions";
import { getFloorPlan } from "@/features/locations/repository";
import { downloadPlanObject } from "./planStorage";
import { renderPlanGrey } from "./planRaster";
import { extractTemplate, matchSymbol } from "./symbolMatch";
import type { SymbolHit } from "./symbolMatch";

// The rendered page. Deliberately NOT square and NOT the stored width_px/height_px, so a value
// hand-computed against these dimensions can only come from the rendered raster.
const IMG_W = 2600;
const IMG_H = 1733;
const IMG = { data: new Uint8Array(0), width: IMG_W, height: IMG_H };
const TEMPLATE = { data: new Uint8Array(4), width: 2, height: 2 };
const MOCK_BYTES = new Uint8Array([1, 2, 3]);

// pdf_page deliberately non-zero, so a hardcoded 0 in the action is caught.
const plan = {
  id: "fp1",
  floor_id: "f1",
  storage_path: "SITE-A/f1.png",
  width_px: 1200,
  height_px: 800,
  original_filename: "sheet.pdf",
  source: "pdf",
  created_at: "",
  updated_at: "",
  pdf_storage_path: "SITE-A/f1.pdf",
  pdf_page: 3,
  wall_runs: null,
  plan_labels: null,
  geometry_extracted_at: null,
};

function hit(over: Partial<SymbolHit> = {}): SymbolHit {
  return { x: 1300, y: 866.5, score: 0.9, rotationDeg: 0, ...over };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFloorPlan).mockResolvedValue(plan as never);
  vi.mocked(downloadPlanObject).mockResolvedValue(MOCK_BYTES);
  vi.mocked(renderPlanGrey).mockResolvedValue(IMG);
  vi.mocked(extractTemplate).mockReturnValue(TEMPLATE);
  vi.mocked(matchSymbol).mockReturnValue([hit()]);
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

const input = (over: Partial<Parameters<typeof discoverSymbolsAction>[0]> = {}) => ({
  floorId: "f1",
  box: { x: 0.1, y: 0.2, w: 0.05, h: 0.05 },
  typeCode: "CAM",
  ...over,
});

describe("discoverSymbolsAction", () => {
  it("happy path: renders the STORED page, cuts the template at the hand-computed pixel box, and returns proposals", async () => {
    // Would catch: hardcoding page 0, feeding the matcher the raw normalized box, or passing
    // something other than the extracted template into matchSymbol.
    const res = await discoverSymbolsAction(input());

    expect(getFloorPlan).toHaveBeenCalledWith(expect.anything(), "f1");
    expect(downloadPlanObject).toHaveBeenCalledWith(expect.anything(), "SITE-A/f1.pdf");
    expect(renderPlanGrey).toHaveBeenCalledWith(MOCK_BYTES, 3);
    // Hand-computed against the RENDERED raster (2600 x 1733), not the stored 1200 x 800:
    //   x = 0.1  * 2600 = 260
    //   y = 0.2  * 1733 = 346.6            -> 347
    //   w = (0.15 - 0.1) * 2600 = 130
    //   h = (0.25 - 0.2) * 1733 = 86.65    -> 87
    expect(extractTemplate).toHaveBeenCalledWith(IMG, { x: 260, y: 347, w: 130, h: 87 });
    expect(matchSymbol).toHaveBeenCalledWith(IMG, TEMPLATE, {
      minScore: 0.65,
      rotations: [0, 90, 180, 270],
      maxHits: 200,
    });

    expect(res).toEqual({
      ok: true,
      proposals: [
        { id: "sym-0", label: "", typeCode: "CAM", point: [0.5, 0.5], confidence: "high" },
      ],
    });
  });

  it("ids run sym-0, sym-1, … in hit order", async () => {
    // Would catch: reusing one id for every hit, which would make the review panel's keys collide
    // and an Accept drop the wrong proposal.
    vi.mocked(matchSymbol).mockReturnValue([hit(), hit({ x: 26, y: 17.33 }), hit({ x: 520, y: 173.3 })]);
    const res = await discoverSymbolsAction(input());
    expect(res.ok && res.proposals.map((p) => p.id)).toEqual(["sym-0", "sym-1", "sym-2"]);
  });

  it("no plan row -> {ok:false}, nothing downloaded or matched", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue(null);
    const res = await discoverSymbolsAction(input());
    expect(res).toEqual({ ok: false, error: "Upload a plan first." });
    expect(downloadPlanObject).not.toHaveBeenCalled();
    expect(renderPlanGrey).not.toHaveBeenCalled();
    expect(matchSymbol).not.toHaveBeenCalled();
  });

  it("pdf_storage_path null -> {ok:false}, nothing downloaded or matched", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue({ ...plan, pdf_storage_path: null } as never);
    const res = await discoverSymbolsAction(input());
    expect(res).toEqual({ ok: false, error: "This plan has no source PDF." });
    expect(downloadPlanObject).not.toHaveBeenCalled();
    expect(renderPlanGrey).not.toHaveBeenCalled();
    expect(matchSymbol).not.toHaveBeenCalled();
  });

  it("getFloorPlan rejecting RESOLVES {ok:false}, never a rejection", async () => {
    // Would catch: the getFloorPlan await sitting outside the try/catch — the exact bug an
    // earlier slice shipped. `.resolves` fails outright if the action rejects instead.
    vi.mocked(getFloorPlan).mockRejectedValue(new Error("db exploded"));
    await expect(discoverSymbolsAction(input())).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(downloadPlanObject).not.toHaveBeenCalled();
  });

  it("renderPlanGrey rejecting RESOLVES {ok:false} (encrypted / malformed PDF)", async () => {
    vi.mocked(renderPlanGrey).mockRejectedValue(new Error("bad pdf"));
    await expect(discoverSymbolsAction(input())).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(matchSymbol).not.toHaveBeenCalled();
  });

  it("matchSymbol throwing RESOLVES {ok:false}", async () => {
    vi.mocked(matchSymbol).mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(discoverSymbolsAction(input())).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
  });

  it("a box under 6x6 page pixels -> {ok:false}, the matcher is never called", async () => {
    // 0.001 * 2600 = 2.6px wide. Correlating a 3px template against the sheet would return
    // hundreds of meaningless hits, so this must be refused rather than run.
    const res = await discoverSymbolsAction(input({ box: { x: 0.5, y: 0.5, w: 0.001, h: 0.001 } }));
    expect(res.ok).toBe(false);
    expect(extractTemplate).not.toHaveBeenCalled();
    expect(matchSymbol).not.toHaveBeenCalled();
  });

  it("a zero-area box -> {ok:false}, the matcher is never called", async () => {
    const res = await discoverSymbolsAction(input({ box: { x: 0.5, y: 0.5, w: 0, h: 0 } }));
    expect(res.ok).toBe(false);
    expect(matchSymbol).not.toHaveBeenCalled();
  });

  it("a non-finite box -> {ok:false}, the matcher is never called", async () => {
    const res = await discoverSymbolsAction(
      input({ box: { x: Number.NaN, y: 0.2, w: 0.05, h: 0.05 } })
    );
    expect(res.ok).toBe(false);
    expect(matchSymbol).not.toHaveBeenCalled();
  });

  it("an out-of-range box is CLAMPED into the page, not rejected", async () => {
    // Would catch: trusting the client box and handing extractTemplate a window that runs past the
    // right/bottom edge, or bailing out on a drag that merely overshot the sheet.
    const res = await discoverSymbolsAction(input({ box: { x: -0.5, y: 0.9, w: 2, h: 2 } }));
    expect(res.ok).toBe(true);
    expect(extractTemplate).toHaveBeenCalledWith(IMG, {
      x: 0,
      // 0.9 * 1733 = 1559.7 -> 1560; bottom clamps to 1733, so h = 1733 - 1559.7 = 173.3 -> 173
      y: 1560,
      w: IMG_W,
      h: 173,
    });
  });

  it("a box dragged bottom-right -> top-left (negative w/h) is normalized, not rejected", async () => {
    const res = await discoverSymbolsAction(input({ box: { x: 0.15, y: 0.25, w: -0.05, h: -0.05 } }));
    expect(res.ok).toBe(true);
    expect(extractTemplate).toHaveBeenCalledWith(IMG, { x: 260, y: 347, w: 130, h: 87 });
  });

  it("an unknown typeCode is COERCED, never trusted through to the proposal", async () => {
    // Would catch: passing the caller's string straight into the proposal, so an accept could
    // create a device with a type code that no device_types row has.
    const res = await discoverSymbolsAction(input({ typeCode: "ZZZ; drop table" }));
    expect(res.ok && res.proposals[0].typeCode).toBe("TO");
  });

  it("a lowercase known typeCode is canonicalised", async () => {
    const res = await discoverSymbolsAction(input({ typeCode: "cam" }));
    expect(res.ok && res.proposals[0].typeCode).toBe("CAM");
  });

  it("maps score to confidence at the exact boundaries", async () => {
    // Would catch: > instead of >=, or the two thresholds transposed.
    vi.mocked(matchSymbol).mockReturnValue([
      hit({ score: 0.85 }),
      hit({ score: 0.8499 }),
      hit({ score: 0.72 }),
      hit({ score: 0.7199 }),
      hit({ score: 0.65 }),
    ]);
    const res = await discoverSymbolsAction(input());
    expect(res.ok && res.proposals.map((p) => p.confidence)).toEqual([
      "high",
      "medium",
      "medium",
      "low",
      "low",
    ]);
  });

  it("normalizes hit centres against the RENDERED raster, and 0 is a real coordinate", async () => {
    vi.mocked(matchSymbol).mockReturnValue([hit({ x: 0, y: 0 }), hit({ x: 650, y: 1299.75 })]);
    const res = await discoverSymbolsAction(input());
    expect(res.ok && res.proposals.map((p) => p.point)).toEqual([
      [0, 0],
      [0.25, 0.75],
    ]);
  });

  it("adopts a code-shaped plan label near the hit, and ignores prose", async () => {
    // Would catch: dropping the label lookup entirely, or accepting any nearby text — the sheet is
    // full of prose ("FOR CARD MACHINE"), which would land in the device's code field.
    vi.mocked(getFloorPlan).mockResolvedValue({
      ...plan,
      plan_labels: [
        // 20px right of the hit at (1300, 866.5) -> within the ~40px radius, code-shaped.
        { text: "CP12", x: 1320 / IMG_W, y: 866.5 / IMG_H },
        // Closer still, but prose: must never win.
        { text: "FOR CARD MACHINE", x: 1305 / IMG_W, y: 866.5 / IMG_H },
      ],
    } as never);
    const res = await discoverSymbolsAction(input());
    expect(res.ok && res.proposals[0].label).toBe("CP12");
  });

  it("leaves the label empty when the only nearby text is prose", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue({
      ...plan,
      plan_labels: [{ text: "FOR CARD MACHINE", x: 1305 / IMG_W, y: 866.5 / IMG_H }],
    } as never);
    const res = await discoverSymbolsAction(input());
    expect(res.ok && res.proposals[0].label).toBe("");
  });

  it("leaves the label empty when the nearest code-shaped label is out of range", async () => {
    // Would catch: taking the globally nearest label with no distance gate at all, which on a
    // 2600px sheet would label every hit with whatever text happened to be closest.
    vi.mocked(getFloorPlan).mockResolvedValue({
      ...plan,
      plan_labels: [{ text: "CP12", x: 1500 / IMG_W, y: 866.5 / IMG_H }],
    } as never);
    const res = await discoverSymbolsAction(input());
    expect(res.ok && res.proposals[0].label).toBe("");
  });

  it("picks the NEAREST code-shaped label when several are in range", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue({
      ...plan,
      plan_labels: [
        { text: "CP99", x: 1330 / IMG_W, y: 866.5 / IMG_H },
        { text: "CP12", x: 1310 / IMG_W, y: 866.5 / IMG_H },
      ],
    } as never);
    const res = await discoverSymbolsAction(input());
    expect(res.ok && res.proposals[0].label).toBe("CP12");
  });

  it("zero hits is a success with an empty list, not an error", async () => {
    vi.mocked(matchSymbol).mockReturnValue([]);
    await expect(discoverSymbolsAction(input())).resolves.toEqual({ ok: true, proposals: [] });
  });
});
