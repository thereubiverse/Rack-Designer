import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn(() => ({})) }));
vi.mock("@/features/locations/repository", () => ({ getFloorPlan: vi.fn() }));
vi.mock("./planStorage", () => ({ downloadPlanObject: vi.fn() }));
vi.mock("./planRaster", () => ({ renderPlanGrey: vi.fn() }));
vi.mock("./symbolMatch", () => ({
  extractTemplate: vi.fn(),
  matchSymbol: vi.fn(),
  cropToInk: vi.fn(),
  hasInk: vi.fn(),
  dominantAngles: vi.fn(),
}));
vi.mock("./planPaths", () => ({ decodePlanPage: vi.fn() }));

import { discoverSymbolsAction, pickSymbolAction } from "./symbolActions";
import { getFloorPlan } from "@/features/locations/repository";
import { downloadPlanObject } from "./planStorage";
import { renderPlanGrey } from "./planRaster";
import { extractTemplate, matchSymbol, cropToInk, hasInk, dominantAngles } from "./symbolMatch";
import type { SymbolHit } from "./symbolMatch";
import { decodePlanPage } from "./planPaths";
import type { PlanPath, PlanTextItem } from "./planPaths";

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
  // Identity by default: existing tests assert exact pixel boxes computed straight from `input.box`,
  // so cropToInk must be a pass-through unless a test deliberately overrides it.
  vi.mocked(cropToInk).mockImplementation((_img, box) => box);
  vi.mocked(hasInk).mockReturnValue(true);
  // The default plan below has wall_runs null, so most tests never reach dominantAngles; the ones
  // that do override this. A distinctive list makes it obvious which path a rotations argument came
  // from.
  vi.mocked(dominantAngles).mockReturnValue([0, 90, 180, 270]);
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

  it("applies cropToInk before extractTemplate, using the cropped box not the raw one (test 8)", async () => {
    // Would catch: extracting the template from the raw pixel box, which is exactly the reported
    // bug — a generously-drawn selection stays mostly background and correlates with blank paper.
    const raw = { x: 260, y: 347, w: 130, h: 87 };
    const cropped = { x: 270, y: 355, w: 40, h: 38 };
    vi.mocked(cropToInk).mockReturnValue(cropped);
    const res = await discoverSymbolsAction(input());
    expect(cropToInk).toHaveBeenCalledWith(IMG, raw);
    expect(extractTemplate).toHaveBeenCalledWith(IMG, cropped);
    expect(res.ok).toBe(true);
  });

  it("a selection whose crop has no ink -> {ok:false}, the matcher is never called (test 7)", async () => {
    // Would catch: searching a blank template anyway, which returns hundreds of meaningless hits —
    // the whole point of this gate.
    const cropped = { x: 270, y: 355, w: 40, h: 38 };
    vi.mocked(cropToInk).mockReturnValue(cropped);
    vi.mocked(hasInk).mockReturnValue(false);
    const res = await discoverSymbolsAction(input());
    expect(res).toEqual({
      ok: false,
      error: "Nothing to match there — try a different symbol.",
    });
    expect(hasInk).toHaveBeenCalledWith(IMG, cropped);
    expect(extractTemplate).not.toHaveBeenCalled();
    expect(matchSymbol).not.toHaveBeenCalled();
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

  it("derives the rotations from the plan's OWN wall runs and searches exactly those", async () => {
    // The user's report: "many times the symbols are the same but at different angles because of
    // the walls". Devices mount on walls, so the plan's wall geometry is where the angles worth
    // searching come from. Would catch: leaving the hardcoded four square rotations in place, or
    // deriving them from anything other than this plan's own runs.
    const walls = [{ x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.17 }];
    vi.mocked(getFloorPlan).mockResolvedValue({ ...plan, wall_runs: walls } as never);
    vi.mocked(dominantAngles).mockReturnValue([0, 10, 80, 90, 100, 170, 180, 190, 260, 270, 280, 350]);

    const res = await discoverSymbolsAction(input());

    // The RENDERED raster's aspect ratio, not the stored width_px/height_px (1200 x 800): a wall run
    // is normalized against the page, and reading its angle without undoing that squash gives an
    // angle the building does not have.
    expect(dominantAngles).toHaveBeenCalledWith(walls, { aspectRatio: IMG_W / IMG_H });
    expect(matchSymbol).toHaveBeenCalledWith(IMG, TEMPLATE, {
      minScore: 0.65,
      rotations: [0, 10, 80, 90, 100, 170, 180, 190, 260, 270, 280, 350],
      maxHits: 200,
    });
    expect(res.ok).toBe(true);
  });

  it("wall_runs null -> the four square rotations, and dominantAngles is never consulted", async () => {
    // A plan uploaded before geometry extraction ran has no wall runs. It must still be searchable,
    // with exactly the behaviour this feature shipped with.
    const res = await discoverSymbolsAction(input());
    expect(dominantAngles).not.toHaveBeenCalled();
    expect(matchSymbol).toHaveBeenCalledWith(
      IMG,
      TEMPLATE,
      expect.objectContaining({ rotations: [0, 90, 180, 270] })
    );
    expect(res.ok).toBe(true);
  });

  it("an EMPTY wall_runs array also falls back, rather than deriving angles from nothing", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue({ ...plan, wall_runs: [] } as never);
    await discoverSymbolsAction(input());
    expect(dominantAngles).not.toHaveBeenCalled();
    expect(matchSymbol).toHaveBeenCalledWith(
      IMG,
      TEMPLATE,
      expect.objectContaining({ rotations: [0, 90, 180, 270] })
    );
  });

  it("dominantAngles throwing RESOLVES {ok:false}, never a rejection", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue({
      ...plan,
      wall_runs: [{ x1: 0, y1: 0, x2: 1, y2: 0 }],
    } as never);
    vi.mocked(dominantAngles).mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(discoverSymbolsAction(input())).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
  });

  it("zero hits is a success with an empty list, not an error", async () => {
    vi.mocked(matchSymbol).mockReturnValue([]);
    await expect(discoverSymbolsAction(input())).resolves.toEqual({ ok: true, proposals: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// pickSymbolAction — resolve a CLICK to the symbol's own vector paths.
// ---------------------------------------------------------------------------------------------

const NO_SYMBOL = "No symbol there — click directly on a device symbol.";

/** One decoded path, reduced to what picking reads: its bbox and its colour class. `segs` is
 *  irrelevant here (picking never looks at them), so it stays empty. */
function pathAt(minX: number, minY: number, maxX: number, maxY: number, grey = false): PlanPath {
  return { segs: [], minX, minY, maxX, maxY, grey };
}

/** A page whose paths (and, optionally, text items) are exactly what the test constructs, at the
 *  same 2600 x 1733 raster the discovery tests above use — so a normalized coordinate means the
 *  same thing in both blocks. */
function page(paths: PlanPath[], texts: PlanTextItem[] = []) {
  return { paths, texts, width: IMG_W, height: IMG_H };
}

/** One decoded text item, reduced to what picking reads: its own glyph-run box. `x`/`y` (the
 *  baseline anchor planExtract's plan_labels use) are irrelevant here, so they just mirror the
 *  box's top-left. */
function textAt(minX: number, minY: number, maxX: number, maxY: number, text = "TXT"): PlanTextItem {
  return { text, x: minX, y: minY, minX, minY, maxX, maxY };
}

/** The device-symbol fixture: a 14 x 14 circle at (100,200)-(114,214) page pixels. */
const SYMBOL = pathAt(100, 200, 114, 214);
/** Its centre, normalized — what the canvas would send for a click on it. */
const ON_SYMBOL = { x: 107 / IMG_W, y: 207 / IMG_H };

describe("pickSymbolAction", () => {
  beforeEach(() => {
    vi.mocked(decodePlanPage).mockResolvedValue(page([SYMBOL]));
  });

  it("happy path: decodes the STORED page and returns the symbol's bbox, normalized", async () => {
    // Would catch: hardcoding page 0, returning PAGE PIXELS instead of 0..1, or returning the
    // click point rather than the path it landed on.
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });

    expect(getFloorPlan).toHaveBeenCalledWith(expect.anything(), "f1");
    expect(downloadPlanObject).toHaveBeenCalledWith(expect.anything(), "SITE-A/f1.pdf");
    expect(decodePlanPage).toHaveBeenCalledWith(MOCK_BYTES, 3);
    // Hand-computed against the RENDERED raster (2600 x 1733): x = 100 / 2600 = 0.0384615384…
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.x).toBeCloseTo(0.03846153846154, 12);
    expect(res.box.y).toBeCloseTo(200 / IMG_H, 12);
    expect(res.box.w).toBeCloseTo(14 / IMG_W, 12);
    expect(res.box.h).toBeCloseTo(14 / IMG_H, 12);
    expect(res.pathCount).toBe(1);
  });

  it("grows the group through a NEARBY path with no text info nearby", async () => {
    // Would catch: returning only the path under the cursor, which on the real sheet is one arc of
    // a circle rather than the whole symbol. No text item covers this neighbour (there is no page
    // text at all here), so it groups normally — the text-exclusion tests below cover the case
    // where a path IS a glyph.
    const ring2 = pathAt(86, 205, 96, 212); // right edge 4px from the symbol's left edge = LINK
    vi.mocked(decodePlanPage).mockResolvedValue(page([SYMBOL, ring2]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.x).toBeCloseTo(86 / IMG_W, 12);
    expect(res.box.w).toBeCloseTo((114 - 86) / IMG_W, 12);
    expect(res.pathCount).toBe(2);
  });

  it("EXCLUDES a path whose centre lies inside a text box — the tag-swallowing regression", async () => {
    // The regression test for the reported bug: on the real sheet, a click on a card-reader circle
    // grew LEFT and swallowed the adjacent "AC-C-n" tag, because that tag's glyph paths sat within
    // PICK_LINK_PX and the group had no reason to refuse them. Those tags carry different digits at
    // every instance, so a template that includes one is worse than useless for matching the rest.
    // Same geometry as "grows the group through a NEARBY path" above, except this neighbour now
    // sits inside a text item's box: it must never join, so the group stays the bare 14px symbol.
    // Delete the text exclusion (or the isTextGlyph filter) and this box widens to 28px, like above.
    const tag = pathAt(86, 205, 96, 212);
    const tagText = textAt(85, 204, 97, 213, "AC-C-1");
    vi.mocked(decodePlanPage).mockResolvedValue(page([SYMBOL, tag], [tagText]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.x).toBeCloseTo(100 / IMG_W, 12);
    expect(res.box.w).toBeCloseTo(14 / IMG_W, 12);
    expect(res.pathCount).toBe(1);
  });

  it("a symbol with no text nearby is unaffected — matches pre-change behaviour", async () => {
    // Would catch: the text-box machinery accidentally excluding ordinary symbol paths even when
    // there is no text on the page at all.
    vi.mocked(decodePlanPage).mockResolvedValue(page([SYMBOL], []));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.x).toBeCloseTo(100 / IMG_W, 12);
    expect(res.box.w).toBeCloseTo(14 / IMG_W, 12);
    expect(res.pathCount).toBe(1);
  });

  it("text exclusion does not stop a legitimate multi-path symbol from grouping", async () => {
    // Would catch: an over-broad exclusion (e.g. by proximity rather than by centre-in-box) that
    // also throws out a symbol's own second path just because some unrelated label is nearby.
    const ring2 = pathAt(86, 205, 96, 212); // a real second path of the symbol, not a glyph
    const unrelatedText = textAt(895, 895, 905, 905, "W1"); // far away, must not affect anything
    vi.mocked(decodePlanPage).mockResolvedValue(page([SYMBOL, ring2], [unrelatedText]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.x).toBeCloseTo(86 / IMG_W, 12);
    expect(res.box.w).toBeCloseTo((114 - 86) / IMG_W, 12);
    expect(res.pathCount).toBe(2);
  });

  it("REFUSES a neighbour that would push the group past the max side — the wall guard", async () => {
    // The regression test for the failure this whole approach exists to avoid: a symbol drawn on a
    // wall, or beside a leader line, must not drag that line's whole length into the template.
    // The neighbour starts 2px from the symbol (well inside the 4px link distance) so ONLY the
    // size refusal can keep it out. Delete the guard and the box becomes 300px wide.
    const wall = pathAt(116, 206, 400, 208);
    vi.mocked(decodePlanPage).mockResolvedValue(page([SYMBOL, wall]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.x).toBeCloseTo(100 / IMG_W, 12);
    expect(res.box.w).toBeCloseTo(14 / IMG_W, 12);
    expect(res.pathCount).toBe(1);
  });

  it("the MAX-side wall guard still holds when text boxes are also present", async () => {
    // Would catch: the text-exclusion pass accidentally short-circuiting the size guard (e.g. by
    // returning early once any exclusion applies) — the wall must still be refused for being too
    // long, independent of whether any text is on the page.
    const wall = pathAt(116, 206, 400, 208);
    const nearbyText = textAt(195, 202, 205, 212, "CP"); // near the symbol, but not ON any path
    vi.mocked(decodePlanPage).mockResolvedValue(page([SYMBOL, wall], [nearbyText]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.x).toBeCloseTo(100 / IMG_W, 12);
    expect(res.box.w).toBeCloseTo(14 / IMG_W, 12);
    expect(res.pathCount).toBe(1);
  });

  it("a long path under the click is never the seed", async () => {
    // Would catch: seeding on the wall the symbol sits on. With the symbol gone there is nothing
    // small to pick, so the answer must be "no symbol" rather than a 500px box.
    vi.mocked(decodePlanPage).mockResolvedValue(page([pathAt(0, 200, 500, 214)]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res).toEqual({ ok: false, error: NO_SYMBOL });
  });

  it("seeds on the SMALLEST path under the click, not the first one", async () => {
    // Would catch: taking whichever qualifying path came first in the operator list — on the real
    // sheet that is usually the enclosing box, not the glyph the user aimed at.
    const enclosing = pathAt(80, 190, 140, 240);   // 60 x 50, still under the max side
    vi.mocked(decodePlanPage).mockResolvedValue(page([enclosing]));
    const wide = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(wide.ok && Math.round(wide.box.w * IMG_W)).toBe(60);

    // With the small symbol present too, the small one must win — and the enclosing path then
    // joins by growth (it is within link distance), so the box is the union, seeded correctly.
    vi.mocked(decodePlanPage).mockResolvedValue(page([pathAt(200, 600, 214, 614), SYMBOL]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.w).toBeCloseTo(14 / IMG_W, 12);
    expect(res.pathCount).toBe(1);
  });

  it("ignores SCREENED-BACK paths: a click on the architecture finds no symbol", async () => {
    // Would catch: dropping the grey/foreground split, which would let a click anywhere on the
    // sheet return a chunk of the base building as the template.
    vi.mocked(decodePlanPage).mockResolvedValue(page([pathAt(100, 200, 114, 214, true)]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res).toEqual({ ok: false, error: NO_SYMBOL });
  });

  it("a grey path never joins the group either", async () => {
    const greyNeighbour = pathAt(116, 190, 130, 240, true);
    vi.mocked(decodePlanPage).mockResolvedValue(page([SYMBOL, greyNeighbour]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res.ok && res.pathCount).toBe(1);
    expect(res.ok && Math.round(res.box.h * IMG_H)).toBe(14);
  });

  it("a click on blank paper -> {ok:false} with the click-the-symbol message", async () => {
    const res = await pickSymbolAction({ floorId: "f1", point: { x: 0.9, y: 0.9 } });
    expect(res).toEqual({ ok: false, error: NO_SYMBOL });
  });

  it("an out-of-range point is CLAMPED into the page, not rejected", async () => {
    // Would catch: bailing out on a click the canvas reported just off the sheet edge. Clamped to
    // (2600, 0), the click lands on the corner path (with the ~3px hit tolerance).
    const corner = pathAt(2592, 0, 2600, 8);
    vi.mocked(decodePlanPage).mockResolvedValue(page([corner]));
    const res = await pickSymbolAction({ floorId: "f1", point: { x: 1.4, y: -0.2 } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.box.x).toBeCloseTo(2592 / IMG_W, 12);
    expect(res.box.y).toBe(0);
  });

  it("a non-finite point -> {ok:false}, never a throw", async () => {
    const res = await pickSymbolAction({ floorId: "f1", point: { x: Number.NaN, y: 0.5 } });
    expect(res).toEqual({ ok: false, error: NO_SYMBOL });
  });

  it("no plan row -> {ok:false}, nothing downloaded or decoded", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue(null);
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res).toEqual({ ok: false, error: "Upload a plan first." });
    expect(downloadPlanObject).not.toHaveBeenCalled();
    expect(decodePlanPage).not.toHaveBeenCalled();
  });

  it("pdf_storage_path null -> {ok:false}, nothing downloaded or decoded", async () => {
    vi.mocked(getFloorPlan).mockResolvedValue({ ...plan, pdf_storage_path: null } as never);
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res).toEqual({ ok: false, error: "This plan has no source PDF." });
    expect(downloadPlanObject).not.toHaveBeenCalled();
    expect(decodePlanPage).not.toHaveBeenCalled();
  });

  it("getFloorPlan rejecting RESOLVES {ok:false}, never a rejection", async () => {
    // Would catch: the await sitting outside the try/catch — the bug an earlier slice shipped.
    vi.mocked(getFloorPlan).mockRejectedValue(new Error("db exploded"));
    await expect(pickSymbolAction({ floorId: "f1", point: ON_SYMBOL })).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(downloadPlanObject).not.toHaveBeenCalled();
  });

  it("decodePlanPage rejecting RESOLVES {ok:false} (encrypted / malformed PDF)", async () => {
    vi.mocked(decodePlanPage).mockRejectedValue(new Error("bad pdf"));
    await expect(pickSymbolAction({ floorId: "f1", point: ON_SYMBOL })).resolves.toEqual(
      expect.objectContaining({ ok: false })
    );
  });

  it("a page with no paths at all -> {ok:false}", async () => {
    vi.mocked(decodePlanPage).mockResolvedValue(page([]));
    const res = await pickSymbolAction({ floorId: "f1", point: ON_SYMBOL });
    expect(res).toEqual({ ok: false, error: NO_SYMBOL });
  });
});
