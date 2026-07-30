import { describe, it, expect } from "vitest";
import {
  extractTemplate,
  matchSymbol,
  cropToInk,
  hasInk,
  dominantAngles,
  type GreyImage,
} from "./symbolMatch";

// ---------------------------------------------------------------------------
// Synthetic canvas helpers. The module is pure, so every test here draws its
// own tiny image — no PDF, no fixtures, no I/O.
// ---------------------------------------------------------------------------

const WHITE = 255;
const BLACK = 0;

function blank(width: number, height: number, value = WHITE): GreyImage {
  return { data: new Uint8Array(width * height).fill(value), width, height };
}

function put(img: GreyImage, x: number, y: number, v: number) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  img.data[y * img.width + x] = v;
}

/** A size x size solid black square, used as a minimal "glyph" for the ink-focused tests below. */
function drawDot(img: GreyImage, ox: number, oy: number, size = 4, v = BLACK) {
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) put(img, ox + x, oy + y, v);
}

/** 12x12 plus sign: a 2px vertical bar and a 2px horizontal bar. 4-fold symmetric. */
function drawCross(img: GreyImage, ox: number, oy: number) {
  for (let i = 0; i < 12; i++) {
    put(img, ox + 5, oy + i, BLACK);
    put(img, ox + 6, oy + i, BLACK);
    put(img, ox + i, oy + 5, BLACK);
    put(img, ox + i, oy + 6, BLACK);
  }
}

/** 12x12 hollow square. Has plenty of variance but no resemblance to a plus. */
function drawRing(img: GreyImage, ox: number, oy: number) {
  for (let i = 0; i < 12; i++) {
    put(img, ox + i, oy, BLACK);
    put(img, ox + i, oy + 11, BLACK);
    put(img, ox, oy + i, BLACK);
    put(img, ox + 11, oy + i, BLACK);
  }
}

/** 12x12 stencil for an "L" — deliberately asymmetric so rotation is detectable. */
function lStencil(): boolean[][] {
  const m: boolean[][] = Array.from({ length: 12 }, () => Array(12).fill(false));
  for (let y = 0; y < 12; y++) for (let x = 0; x < 3; x++) m[y][x] = true; // upright stem
  for (let y = 9; y < 12; y++) for (let x = 0; x < 12; x++) m[y][x] = true; // foot
  return m;
}

function drawStencil(img: GreyImage, ox: number, oy: number, m: boolean[][]) {
  for (let y = 0; y < m.length; y++)
    for (let x = 0; x < m[y].length; x++) if (m[y][x]) put(img, ox + x, oy + y, BLACK);
}

/** Rotate a square stencil 90 degrees CLOCKWISE — pins the module's rotation convention. */
function rot90cw(m: boolean[][]): boolean[][] {
  const n = m.length;
  const out: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) out[x][n - 1 - y] = m[y][x];
  return out;
}

/**
 * An asymmetric glyph, defined ANALYTICALLY in its own local space so it can be stamped at any
 * angle. Rectangles, in local coordinates about the glyph's centre: a tall stem on the left, a foot
 * along the bottom, and a tab at the top middle that kills the 180-degree symmetry the first two
 * would otherwise leave. Stamped by inverse-rotating each destination pixel, which is independent of
 * how symbolMatch rotates a template — so a test built on it can actually fail.
 */
const GLYPH_RECTS = [
  { x0: -8, x1: -5, y0: -9, y1: 9 },
  { x0: -8, x1: 8, y0: 6, y1: 9 },
  { x0: -2, x1: 2, y0: -9, y1: -6 },
];

/** Stamp GLYPH_RECTS centred at (cx, cy), turned `deg` CLOCKWISE on screen (y grows downwards). */
function stampGlyph(img: GreyImage, cx: number, cy: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (let dy = -18; dy <= 18; dy++) {
    for (let dx = -18; dx <= 18; dx++) {
      const lx = cos * dx + sin * dy;
      const ly = -sin * dx + cos * dy;
      if (GLYPH_RECTS.some((r) => lx >= r.x0 && lx <= r.x1 && ly >= r.y0 && ly <= r.y1)) {
        put(img, cx + dx, cy + dy, BLACK);
      }
    }
  }
}

/** A 23x23 template cut from an upright stamp of GLYPH_RECTS. */
function glyphTemplate() {
  const src = blank(60, 60);
  stampGlyph(src, 30, 30, 0);
  return extractTemplate(src, { x: 19, y: 19, w: 23, h: 23 });
}

/** One normalized wall run of `len` (in units of 1/1000 of the page) starting at (x, y), at `deg`. */
function run(x: number, y: number, len: number, deg: number) {
  const r = (deg * Math.PI) / 180;
  return { x1: x, y1: y, x2: x + (len * Math.cos(r)) / 1000, y2: y + (len * Math.sin(r)) / 1000 };
}

/** True if `list` holds an angle within `tol` of `deg`. */
const hasAngle = (list: number[], deg: number, tol = 0.5) =>
  list.some((v) => Math.abs(v - deg) < tol);

/** Centre of a wxh window whose top-left is at (x,y), in pixel-centre coordinates. */
const centreOf = (x: number, size: number) => x + (size - 1) / 2;

const byPosition = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.y - b.y || a.x - b.x;

// ---------------------------------------------------------------------------

describe("extractTemplate", () => {
  it("crops the requested box", () => {
    const img = blank(20, 20);
    put(img, 5, 6, 10);
    const tpl = extractTemplate(img, { x: 4, y: 5, w: 3, h: 3 });
    expect(tpl.width).toBe(3);
    expect(tpl.height).toBe(3);
    expect(Array.from(tpl.data)).toEqual([255, 255, 255, 255, 10, 255, 255, 255, 255]);
  });

  it("clamps a box that runs off the edge", () => {
    const img = blank(10, 10);
    const tpl = extractTemplate(img, { x: 8, y: 8, w: 5, h: 5 });
    expect(tpl.width).toBe(2);
    expect(tpl.height).toBe(2);
  });
});

describe("matchSymbol", () => {
  it("finds every identical instance, with exact centres (test 1)", () => {
    const img = blank(200, 200);
    const spots: [number, number][] = [
      [20, 20],
      [100, 40],
      [60, 150],
    ];
    for (const [x, y] of spots) drawCross(img, x, y);

    const tpl = extractTemplate(img, { x: 20, y: 20, w: 12, h: 12 });
    const hits = matchSymbol(img, tpl, { minScore: 0.8 });

    expect(hits).toHaveLength(3);
    const sorted = [...hits].sort(byPosition);
    const want = spots
      .map(([x, y]) => ({ x: centreOf(x, 12), y: centreOf(y, 12) }))
      .sort(byPosition);
    expect(sorted.map((h) => ({ x: h.x, y: h.y }))).toEqual(want);
    for (const h of hits) expect(h.score).toBeGreaterThan(0.99);
  });

  it("is contrast invariant, which pins the window's OWN mean and std (test 1b)", () => {
    // The documented prior failure was a correlation that centred/normalised
    // the window with statistics taken from the wrong pixel set. That bug is
    // invisible when every instance has the template's exact contrast, so this
    // test deliberately varies contrast: a mid-grey template against a
    // full-black instance and a very faint instance. Correct NCC scores ~1.0
    // for all three; a wrong denominator scales the score by sigmaT/sigmaW and
    // pushes them off 1.0 in both directions.
    const img = blank(200, 200);
    const paint = (ox: number, oy: number, ink: number) => {
      for (let i = 0; i < 12; i++) {
        put(img, ox + 5, oy + i, ink);
        put(img, ox + 6, oy + i, ink);
        put(img, ox + i, oy + 5, ink);
        put(img, ox + i, oy + 6, ink);
      }
    };
    paint(20, 20, 128); // template source: mid grey
    paint(100, 40, 0); // higher contrast than the template
    paint(60, 150, 210); // much lower contrast than the template

    const tpl = extractTemplate(img, { x: 20, y: 20, w: 12, h: 12 });
    const hits = matchSymbol(img, tpl, { minScore: 0.9 });

    expect(hits).toHaveLength(3);
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0.99);
      // NCC is bounded by 1. A score above it means the normalisation used a
      // denominator that does not belong to this window.
      expect(h.score).toBeLessThanOrEqual(1.0000001);
    }
  });

  it("never reports a score outside [-1, 1] on busy content", () => {
    // Broad invariant over many differently-contrasted windows: whatever the
    // scan does, a normalised correlation cannot exceed 1.
    const img = blank(160, 160);
    for (let y = 0; y < 160; y++)
      for (let x = 0; x < 160; x++)
        img.data[y * 160 + x] = ((x * 7 + y * 13) % 5) * 60; // deterministic texture
    drawCross(img, 40, 40);
    const tpl = extractTemplate(img, { x: 40, y: 40, w: 12, h: 12 });
    const hits = matchSymbol(img, tpl, { minScore: -1, maxHits: 200 });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(Number.isFinite(h.score)).toBe(true);
      expect(h.score).toBeGreaterThanOrEqual(-1.0000001);
      expect(h.score).toBeLessThanOrEqual(1.0000001);
    }
  });

  it("does not match a structurally different shape (test 2)", () => {
    const img = blank(200, 200);
    drawCross(img, 20, 20);
    drawRing(img, 120, 120); // distractor: same bbox, same ink budget, wrong structure

    const tpl = extractTemplate(img, { x: 20, y: 20, w: 12, h: 12 });
    const hits = matchSymbol(img, tpl, { minScore: 0.7 });

    expect(hits).toHaveLength(1);
    expect(hits[0].x).toBe(centreOf(20, 12));
    expect(hits[0].y).toBe(centreOf(20, 12));
  });

  it("finds a 90-degree instance only when 90 is in rotations (test 3)", () => {
    const upright = lStencil();
    const turned = rot90cw(upright);
    const img = blank(200, 200);
    drawStencil(img, 20, 20, upright);
    drawStencil(img, 120, 60, turned);

    const tpl = extractTemplate(img, { x: 20, y: 20, w: 12, h: 12 });

    const withRot = matchSymbol(img, tpl, { minScore: 0.8 });
    expect(withRot).toHaveLength(2);
    const rotated = withRot.find((h) => h.rotationDeg === 90);
    expect(rotated).toBeDefined();
    expect(rotated!.x).toBe(centreOf(120, 12));
    expect(rotated!.y).toBe(centreOf(60, 12));
    expect(withRot.find((h) => h.rotationDeg === 0)).toBeDefined();

    const uprightOnly = matchSymbol(img, tpl, { minScore: 0.8, rotations: [0] });
    expect(uprightOnly).toHaveLength(1);
    expect(uprightOnly[0].rotationDeg).toBe(0);
    expect(uprightOnly[0].x).toBe(centreOf(20, 12));
  });

  // THE regression test for the reported problem: "many times the symbols are the same but at
  // different angles because of the walls". Before this, matchSymbol snapped every rotation to a
  // multiple of 90 and an instance in a wing turned ~10 degrees was simply not findable.
  it("finds a 10-degree instance ONLY when 10 is in rotations — the rotated-wing case", () => {
    const tpl = glyphTemplate();
    const img = blank(160, 160);
    stampGlyph(img, 80, 78, 10);

    const square = matchSymbol(img, tpl, { minScore: 0.7, rotations: [0] });
    expect(square).toEqual([]);

    const tilted = matchSymbol(img, tpl, { minScore: 0.7, rotations: [0, 10] });
    expect(tilted).toHaveLength(1);
    expect(tilted[0].rotationDeg).toBe(10);
    expect(tilted[0].x).toBeCloseTo(80, 0);
    expect(tilted[0].y).toBeCloseTo(78, 0);
  });

  // Rotating to an arbitrary angle leaves corners of the destination box with no source pixel behind
  // them. Filling those with BLACK paints a dark frame the real page never has, which drags the
  // correlation down on the genuine instance: measured on this exact fixture, black fill scores the
  // 45-degree instance below 0.7 (not found at all) and the 10-degree one at 0.666 instead of 0.874.
  // The fill has to be the template's own background — the paper the symbol actually sits on.
  it("fills a rotation's uncovered corners with the template's BACKGROUND, not black", () => {
    const tpl = glyphTemplate();
    // 45 degrees is the worst case: the rotated box is 2x the area, so half of it is fill.
    // Deliberately close to the image edge, where a dark frame would have nothing to hide behind.
    const img = blank(120, 120);
    stampGlyph(img, 26, 26, 45);

    const hits = matchSymbol(img, tpl, { minScore: 0.7, rotations: [0, 45] });
    expect(hits).toHaveLength(1);
    expect(hits[0].rotationDeg).toBe(45);
    expect(hits[0].score).toBeGreaterThan(0.8);
    expect(hits[0].x).toBeCloseTo(26, 0);
    expect(hits[0].y).toBeCloseTo(26, 0);
  });

  it("suppresses overlapping peaks down to one hit (test 4)", () => {
    const img = blank(200, 200);
    drawCross(img, 50, 50);
    drawCross(img, 50, 54); // overlaps the first — one symbol's worth of response ridge

    const tpl = blank(12, 12);
    drawCross(tpl as GreyImage, 0, 0);

    const hits = matchSymbol(img, tpl, { minScore: 0.7 });
    expect(hits).toHaveLength(1);
  });

  it("respects maxHits, keeping the best-scoring hits (test 5)", () => {
    const img = blank(200, 200);
    drawCross(img, 20, 20);
    drawCross(img, 100, 40);
    drawCross(img, 60, 150);

    const tpl = extractTemplate(img, { x: 20, y: 20, w: 12, h: 12 });
    const all = matchSymbol(img, tpl, { minScore: 0.8 });
    expect(all).toHaveLength(3);

    const capped = matchSymbol(img, tpl, { minScore: 0.8, maxHits: 2 });
    expect(capped).toHaveLength(2);
    for (let i = 1; i < capped.length; i++)
      expect(capped[i - 1].score).toBeGreaterThanOrEqual(capped[i].score);
  });

  it("returns no hits and no NaN on a uniform image (test 6)", () => {
    const source = blank(200, 200);
    drawCross(source, 20, 20);
    const tpl = extractTemplate(source, { x: 20, y: 20, w: 12, h: 12 });

    const flat = blank(200, 200, 200); // zero variance everywhere
    const hits = matchSymbol(flat, tpl, { minScore: 0.5 });
    expect(hits).toEqual([]);

    // Nothing may squeak through at any threshold, including a negative one:
    // a zero-variance window must score a finite 0, never NaN or Infinity.
    const forced = matchSymbol(flat, tpl, { minScore: -1 });
    for (const h of forced) expect(Number.isFinite(h.score)).toBe(true);
    expect(forced.every((h) => h.score === 0)).toBe(true);

    // A zero-variance TEMPLATE is equally degenerate and must not divide by zero.
    const flatTpl = { data: new Uint8Array(144).fill(7), width: 12, height: 12 };
    expect(matchSymbol(source, flatTpl, { minScore: -1 })).toEqual([]);
  });

  it("returns empty when the template is larger than the image (test 7)", () => {
    const img = blank(10, 10);
    const tpl = { data: new Uint8Array(20 * 20).fill(0), width: 20, height: 20 };
    expect(() => matchSymbol(img, tpl)).not.toThrow();
    expect(matchSymbol(img, tpl)).toEqual([]);

    // Also larger in only one axis, and after a 90-degree turn.
    const tall = { data: new Uint8Array(5 * 40).fill(0), width: 5, height: 40 };
    expect(matchSymbol(img, tall)).toEqual([]);
    expect(matchSymbol({ ...blank(60, 10) }, tall, { rotations: [90] })).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The coarse-to-fine path. A 12x12 template is small enough that the module
  // scans it at stride 1; only a symbol-sized template (the real sheet's are
  // ~40px) goes through downsample -> coarse peaks -> stride-1 refinement.
  // These tests exist so that path is not shipped untested.
  // -------------------------------------------------------------------------

  const S = 44;

  /** The 44x44 box outline shared by both fixture glyphs. */
  function drawBox(img: GreyImage, ox: number, oy: number, ink: number) {
    for (let i = 0; i < S; i++) {
      put(img, ox + i, oy, ink);
      put(img, ox + i, oy + S - 1, ink);
      put(img, ox, oy + i, ink);
      put(img, ox + S - 1, oy + i, ink);
    }
  }

  /**
   * Box + centred cross. Thin 1-2px strokes, ~15% ink — the same sparse line art
   * a real plan symbol is made of, which is exactly the regime where the coarse
   * pass is fragile. Do NOT "improve" these fixtures into fat, solid shapes:
   * a solid glyph passes the offset sweep below even with the coarse smoothing
   * removed, which makes the test vacuous. Measured, not assumed.
   */
  function drawRingCross(img: GreyImage, ox: number, oy: number, ink = BLACK) {
    drawBox(img, ox, oy, ink);
    for (let i = 8; i < S - 8; i++) {
      put(img, ox + 21, oy + i, ink);
      put(img, ox + 22, oy + i, ink);
      put(img, ox + i, oy + 21, ink);
      put(img, ox + i, oy + 22, ink);
    }
    // A small corner tick. Fine detail like this is the part of a symbol that
    // survives least well through a downsample, and it is measurably what makes
    // the offset sweep below able to detect a degraded coarse pass. Removing it
    // lets the "coarse smoothing disabled" mutant slip through.
    for (let i = 0; i < 10; i++) {
      put(img, ox + 6 + i, oy + 6, ink);
      put(img, ox + 6, oy + 6 + i, ink);
    }
  }

  /**
   * Box + two short bars + a long bar + a side rail. Also thin line art, but
   * strongly asymmetric: it scores 0.67 against its own 90-degree rotation,
   * where drawRingCross scores 0.93. The rotation tests need that gap to mean
   * anything.
   */
  function drawOutlet(img: GreyImage, ox: number, oy: number, ink = BLACK) {
    drawBox(img, ox, oy, ink);
    for (let i = 8; i < 20; i++) {
      put(img, ox + i, oy + 10, ink);
      put(img, ox + i, oy + 14, ink);
    }
    for (let i = 8; i < S - 8; i++) put(img, ox + i, oy + 33, ink);
    for (let i = 10; i < 34; i++) put(img, ox + 30, oy + i, ink);
  }

  const drawGlyph = drawOutlet;

  it("finds symbol-sized instances via the coarse-to-fine path (test 8)", () => {
    const img = blank(600, 400);
    const spots: [number, number][] = [
      [30, 30],
      [301, 57],
      [180, 250],
      [470, 300],
    ];
    for (const [x, y] of spots) drawGlyph(img, x, y);

    const tpl = extractTemplate(img, { x: 30, y: 30, w: 44, h: 44 });
    const hits = matchSymbol(img, tpl, { minScore: 0.8 }).sort(byPosition);

    expect(hits).toHaveLength(4);
    const want = spots
      .map(([x, y]) => ({ x: centreOf(x, 44), y: centreOf(y, 44) }))
      .sort(byPosition);
    expect(hits.map((h) => ({ x: h.x, y: h.y }))).toEqual(want);
    for (const h of hits) expect(h.score).toBeGreaterThan(0.99);
  });

  it("finds instances at EVERY sub-cell offset, not just on the coarse grid (test 8b)", () => {
    // The single most important test in this file. The coarse pass samples a
    // downsampled grid; a real symbol almost never sits on a multiple of the
    // downsample factor. An earlier version of this module passed every other
    // test here while silently losing any instance whose position was not a
    // multiple of the coarse factor — the recall damage was invisible in the
    // numbers and obvious only in a picture. Sweeping all 4x4 sub-cell phases,
    // on thin line art, is what makes that failure fail loudly.
    for (const [name, draw] of [
      ["ringcross", drawRingCross],
      ["outlet", drawOutlet],
    ] as const) {
      for (const dx of [0, 1, 2, 3]) {
        for (const dy of [0, 1, 2, 3]) {
          const img = blank(300, 200);
          draw(img, 20, 20);
          draw(img, 150 + dx, 100 + dy);
          const tpl = extractTemplate(img, { x: 20, y: 20, w: S, h: S });
          const hits = matchSymbol(img, tpl, { minScore: 0.9 }).sort(byPosition);
          const where = `${name} offset ${dx},${dy}`;
          expect(hits, where).toHaveLength(2);
          expect(hits[1].x, where).toBe(centreOf(150 + dx, S));
          expect(hits[1].y, where).toBe(centreOf(100 + dy, S));
        }
      }
    }
  });

  it("is contrast invariant on the coarse-to-fine path too (test 8c)", () => {
    // Same guard as test 1b, but for symbol-sized templates, which take the
    // pyramid path. Both passes must normalise by the window's own statistics.
    const img = blank(600, 300);
    drawGlyph(img, 30, 30, 120); // template source: mid grey
    drawGlyph(img, 250, 60, 0); // darker than the template
    drawGlyph(img, 450, 200, 205); // much fainter than the template

    const tpl = extractTemplate(img, { x: 30, y: 30, w: 44, h: 44 });
    const hits = matchSymbol(img, tpl, { minScore: 0.9 });

    expect(hits).toHaveLength(3);
    for (const h of hits) {
      expect(h.score).toBeGreaterThan(0.99);
      expect(h.score).toBeLessThanOrEqual(1.0000001);
    }
  });

  it("rejects a different symbol-sized shape on the coarse path (test 8d)", () => {
    const img = blank(600, 300);
    drawGlyph(img, 30, 30);
    // Distractor: a solid-bordered 44x44 box with a diagonal, not the glyph.
    for (let i = 0; i < 44; i++) {
      put(img, 300 + i, 100, BLACK);
      put(img, 300 + i, 143, BLACK);
      put(img, 300, 100 + i, BLACK);
      put(img, 343, 100 + i, BLACK);
      put(img, 300 + i, 100 + i, BLACK);
    }
    const tpl = extractTemplate(img, { x: 30, y: 30, w: 44, h: 44 });
    const hits = matchSymbol(img, tpl, { minScore: 0.8 });
    expect(hits).toHaveLength(1);
    expect(hits[0].x).toBe(centreOf(30, 44));
  });

  it("finds a rotated symbol-sized instance on the coarse path (test 8e)", () => {
    const upright = blank(44, 44);
    drawGlyph(upright, 0, 0);
    // Rotate the 44x44 patch 90 degrees clockwise by hand.
    const turned = blank(44, 44);
    for (let y = 0; y < 44; y++)
      for (let x = 0; x < 44; x++)
        turned.data[x * 44 + (44 - 1 - y)] = upright.data[y * 44 + x];

    const img = blank(600, 300);
    for (let y = 0; y < 44; y++)
      for (let x = 0; x < 44; x++) {
        put(img, 30 + x, 30 + y, upright.data[y * 44 + x]);
        put(img, 300 + x, 150 + y, turned.data[y * 44 + x]);
      }

    const tpl = extractTemplate(img, { x: 30, y: 30, w: 44, h: 44 });
    const both = matchSymbol(img, tpl, { minScore: 0.9 });
    expect(both).toHaveLength(2);
    const rotated = both.find((h) => h.rotationDeg === 90);
    expect(rotated).toBeDefined();
    expect(rotated!.x).toBe(centreOf(300, 44));
    expect(rotated!.y).toBe(centreOf(150, 44));

    expect(matchSymbol(img, tpl, { minScore: 0.9, rotations: [0] })).toHaveLength(1);
  });

  it("returns no hits and no NaN on a uniform image, coarse path (test 8f)", () => {
    const source = blank(200, 200);
    drawGlyph(source, 20, 20);
    const tpl = extractTemplate(source, { x: 20, y: 20, w: 44, h: 44 });
    const flat = blank(600, 300, 180);
    expect(matchSymbol(flat, tpl, { minScore: 0.5 })).toEqual([]);
    const forced = matchSymbol(flat, tpl, { minScore: -1 });
    for (const h of forced) expect(Number.isFinite(h.score)).toBe(true);
  });

  it("handles a mostly-blank template whose refine windows are flat (test 8g)", () => {
    // A sparse template (one small mark in a large empty box) makes the
    // stride-1 refinement slide over windows that are perfectly uniform, so the
    // zero-variance branch in the NCC is genuinely executed — instrumented at
    // 960 hits for this exact case, so it is live code, not a dead guard.
    const img = blank(400, 300);
    for (const [ox, oy] of [
      [100, 100],
      [250, 180],
    ] as const)
      for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) put(img, ox + x, oy + y, BLACK);

    const tpl = extractTemplate(img, { x: 100, y: 100, w: 44, h: 44 });
    const hits = matchSymbol(img, tpl, { minScore: 0.9, maxHits: 50 });

    expect(hits.length).toBeGreaterThanOrEqual(2);
    for (const h of hits) {
      expect(Number.isFinite(h.score)).toBe(true);
      expect(h.score).toBeLessThanOrEqual(1.0000001);
    }
    const upright = hits.filter((h) => h.rotationDeg === 0).sort(byPosition);
    expect(upright.map((h) => ({ x: h.x, y: h.y }))).toEqual([
      { x: centreOf(100, 44), y: centreOf(100, 44) },
      { x: centreOf(250, 44), y: centreOf(180, 44) },
    ]);
  });

  it("is deterministic across repeated runs", () => {
    const img = blank(200, 200);
    drawCross(img, 20, 20);
    drawCross(img, 100, 40);
    const tpl = extractTemplate(img, { x: 20, y: 20, w: 12, h: 12 });
    const a = matchSymbol(img, tpl, { minScore: 0.8 });
    const b = matchSymbol(img, tpl, { minScore: 0.8 });
    expect(a).toEqual(b);
  });

  it("honours an explicit suppressRadiusPx", () => {
    const img = blank(200, 200);
    drawCross(img, 20, 20);
    drawCross(img, 60, 20);
    const tpl = extractTemplate(img, { x: 20, y: 20, w: 12, h: 12 });

    expect(matchSymbol(img, tpl, { minScore: 0.8 })).toHaveLength(2);
    expect(matchSymbol(img, tpl, { minScore: 0.8, suppressRadiusPx: 80 })).toHaveLength(1);
  });

  it("still finds instances when the template is a loose crop with slack around it", () => {
    // The real caller drags a box; it will not be pixel-tight. A template with
    // white margin must still land on the same centres.
    const img = blank(200, 200);
    drawCross(img, 20, 20);
    drawCross(img, 120, 90);
    const tpl = extractTemplate(img, { x: 14, y: 14, w: 24, h: 24 });
    const hits = matchSymbol(img, tpl, { minScore: 0.8 }).sort(byPosition);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ x: centreOf(14, 24), y: centreOf(14, 24) });
    expect(hits[1]).toMatchObject({ x: centreOf(114, 24), y: centreOf(84, 24) });
  });

  // ---------------------------------------------------------------------------
  // The ink-density gate. Regression coverage for: "it discovers all the symbols
  // based on my selection but also discovers a whole lot of other things that
  // are not the symbol" — a generously-drawn selection is mostly background, and
  // a low-variance template correlates with blank paper everywhere. Measured on
  // the real Cellar sheet: a box on blank paper (0% ink) hit the 400-hit cap at
  // minScore 0.65, versus 7 genuine hits for a tight box (27.4% ink).
  // ---------------------------------------------------------------------------

  // A 40x40 fixture with a deterministic per-OFFSET background texture (so the same
  // pattern reproduces exactly wherever it is tiled) plus, for the glyph variant, a
  // solid 10x10 black square. The glyph dominates the template's own variance (as a
  // real symbol's ink does), so a window sharing only the background texture is
  // structurally "mostly not this symbol" despite the shared context — exactly the
  // shape of the reported bug, just small enough to reason about by hand.
  const GS = 40;
  function paintTexture(img: GreyImage, ox: number, oy: number) {
    for (let dy = 0; dy < GS; dy++)
      for (let dx = 0; dx < GS; dx++) put(img, ox + dx, oy + dy, 245 - ((dx * 7 + dy * 13) % 10));
  }
  function paintTextureGlyph(img: GreyImage, ox: number, oy: number) {
    paintTexture(img, ox, oy);
    for (let dy = 15; dy < 25; dy++) for (let dx = 15; dx < 25; dx++) put(img, ox + dx, oy + dy, BLACK);
  }
  const nearGlyph = (h: { x: number; y: number }) =>
    h.x > centreOf(30, GS) - GS / 2 && h.x < centreOf(30, GS) + GS / 2 && h.y > 30 && h.y < 70;
  const nearBlank = (h: { x: number; y: number }) => h.x >= 200 && h.x < 240 && h.y >= 100 && h.y < 140;

  it("rejects a blank region that would otherwise correlate (test 5)", () => {
    const img = blank(400, 300);
    paintTextureGlyph(img, 30, 30); // the real symbol: shared texture + a solid glyph
    paintTexture(img, 200, 100); // "blank": identical texture, no glyph at all

    const tpl = extractTemplate(img, { x: 30, y: 30, w: GS, h: GS });
    // minScore is deliberately low (0.3, not the real 0.65 operating point): a synthetic texture
    // strong enough to clear 0.65 on its own would have to be so glyph-like it stops being a fair
    // stand-in for "blank paper". The point survives at any threshold the shared texture clears.
    const opts = { minScore: 0.3, rotations: [0] as number[] };

    // Without the gate: this is the reported bug, reproduced in miniature. Must fail without the
    // gate — that is what makes this a regression test rather than a demonstration.
    const noGate = matchSymbol(img, tpl, { ...opts, inkRatioMin: 0 });
    expect(noGate.some(nearBlank)).toBe(true);
    expect(noGate.some(nearGlyph)).toBe(true); // the genuine instance must still be found

    // With the gate (default inkRatioMin 0.5): the blank region is gone, the real hit remains.
    const withGate = matchSymbol(img, tpl, opts);
    expect(withGate.some(nearBlank)).toBe(false);
    expect(withGate.some(nearGlyph)).toBe(true);
  });

  it("inkRatioMin: 0 reproduces the pre-gate behaviour exactly (test 6)", () => {
    const img = blank(400, 300);
    paintTextureGlyph(img, 30, 30);
    paintTexture(img, 200, 100);
    const tpl = extractTemplate(img, { x: 30, y: 30, w: GS, h: GS });

    const disabled = matchSymbol(img, tpl, { minScore: 0.3, rotations: [0], inkRatioMin: 0 });
    // Same scene as test 5's "without the gate" call: inkRatioMin 0 must restore exactly the hits
    // the gate otherwise removes, not just "some" of them.
    expect(disabled.some(nearBlank)).toBe(true);
    expect(disabled.some(nearGlyph)).toBe(true);
  });
});

describe("dominantAngles", () => {
  it("an axis-aligned building asks for exactly the four square rotations", () => {
    // Would catch: emitting spurious near-zero angles (a refined peak lands at 0.007, not 0) and so
    // doubling the search cost on a plain rectilinear plan for nothing.
    const runs = [run(0.1, 0.1, 500, 0), run(0.2, 0.2, 500, 90), run(0.3, 0.1, 400, 0)];
    expect(dominantAngles(runs)).toEqual([0, 90, 180, 270]);
  });

  it("a building drawn at 10 degrees asks for ~10 and its four quadrants", () => {
    // The user's case: "the symbols are the same but at different angles because of the walls".
    // 100 degrees is the SAME building grid as 10 — walls perpendicular to each other, one grid.
    const runs = [run(0.1, 0.1, 500, 10), run(0.2, 0.3, 400, 100), run(0.3, 0.5, 300, 10)];
    const out = dominantAngles(runs);
    for (const q of [10, 100, 190, 280]) expect(hasAngle(out, q)).toBe(true);
    // …and never less than the previous fixed behaviour.
    for (const q of [0, 90, 180, 270]) expect(hasAngle(out, q)).toBe(true);
  });

  it("also asks for the NEGATIVE offset — the picked example may itself be in the rotated wing", () => {
    // Measured on the real Cellar sheet, and the whole reason this returns differences rather than
    // the building's absolute orientations: the plan uses 0 and 9.3 degrees, the GFI outlet the user
    // clicks sits in the 9.3-degree part, and the instances discovery misses sit in the square part.
    // Matching those needs the template turned by MINUS 9.3. Searching [0, 9.3] and quadrants left
    // recall at 12/14; adding the negative took it to 13/14.
    const runs = [run(0.1, 0.1, 500, 10), run(0.4, 0.1, 500, 0)];
    const out = dominantAngles(runs);
    expect(hasAngle(out, 10)).toBe(true);
    expect(hasAngle(out, 80)).toBe(true); // -10, folded into [0, 360)
    expect(hasAngle(out, 350)).toBe(true);
  });

  it("weights by LENGTH: many short stubs lose to a few long walls", () => {
    // Would catch: counting runs instead of measuring them. 50 stubs outnumber 3 walls 16:1, but a
    // 400px wall says far more about the building's grid than a 2px fragment does.
    const stubs = Array.from({ length: 50 }, (_, i) => run(0.05 + i * 0.01, 0.5, 2, 40));
    const walls = [run(0.1, 0.1, 400, 10), run(0.2, 0.3, 400, 10), run(0.3, 0.6, 400, 10)];
    const out = dominantAngles([...stubs, ...walls], { maxAngles: 1 });
    expect(hasAngle(out, 10)).toBe(true);
    expect(hasAngle(out, 40)).toBe(false);
  });

  it("ignores an orientation holding less than minShareFrac of the total wall length", () => {
    const walls = [run(0.1, 0.1, 900, 0), run(0.2, 0.3, 900, 90)];
    const sliver = [run(0.5, 0.5, 40, 25)];
    expect(dominantAngles([...walls, ...sliver])).toEqual([0, 90, 180, 270]);
    // …unless the caller lowers the bar, which proves the sliver was really there.
    expect(hasAngle(dominantAngles([...walls, ...sliver], { minShareFrac: 0.01 }), 25)).toBe(true);
  });

  it("respects maxAngles: only the heaviest orientations are searched", () => {
    const a = [run(0.1, 0.1, 900, 0), run(0.15, 0.1, 900, 0)];
    const b = [run(0.2, 0.2, 600, 10), run(0.25, 0.2, 600, 10)];
    const c = [run(0.3, 0.3, 300, 40), run(0.35, 0.3, 300, 40)];
    const all = [...a, ...b, ...c];
    expect(hasAngle(dominantAngles(all, { maxAngles: 3 }), 40)).toBe(true);
    const capped = dominantAngles(all, { maxAngles: 1 });
    expect(hasAngle(capped, 40)).toBe(false);
    expect(hasAngle(capped, 10)).toBe(false); // only the single heaviest orientation survives
    expect(capped).toEqual([0, 90, 180, 270]);
  });

  it("undoes the page's aspect ratio before measuring an angle", () => {
    // Would catch: reading angles straight out of the normalized coordinates. Normalising divides x
    // by the page WIDTH and y by its HEIGHT — an anisotropic squash that changes every angle that
    // isn't square. This run is a true 10 degrees on a 2:1 page.
    const tilted = [
      { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.1 + 0.4 * 2 * Math.tan((10 * Math.PI) / 180) },
    ];
    expect(hasAngle(dominantAngles(tilted, { aspectRatio: 2 }), 10)).toBe(true);
    // Without the correction the same wall reads as ~19.4 degrees — a rotation the building
    // never uses, and the real 10-degree one never searched.
    const uncorrected = dominantAngles(tilted);
    expect(hasAngle(uncorrected, 10)).toBe(false);
    expect(hasAngle(uncorrected, 19.4, 0.2)).toBe(true);
  });

  it("empty, zero-length and non-finite input all fall back to the four square rotations", () => {
    // Never throws: this feeds a server action, and a plan whose geometry extraction produced
    // nothing usable must still be searchable.
    expect(dominantAngles([])).toEqual([0, 90, 180, 270]);
    expect(dominantAngles([{ x1: 0.1, y1: 0.1, x2: 0.1, y2: 0.1 }])).toEqual([0, 90, 180, 270]);
    expect(
      dominantAngles([{ x1: Number.NaN, y1: 0, x2: 1, y2: 1 }, { x1: 0, y1: 0, x2: Infinity, y2: 0 }])
    ).toEqual([0, 90, 180, 270]);
  });

  it("returns a sorted, de-duplicated list inside [0, 360)", () => {
    const out = dominantAngles([run(0.1, 0.1, 500, 10), run(0.4, 0.1, 500, 0)]);
    expect(out).toEqual([...out].sort((a, b) => a - b));
    expect(new Set(out).size).toBe(out.length);
    expect(out.every((v) => v >= 0 && v < 360)).toBe(true);
  });
});

describe("cropToInk", () => {
  it("tightens a generously-drawn box to the glyph's ink plus a margin (test 1)", () => {
    const img = blank(200, 200);
    drawDot(img, 100, 100, 6); // ink spans x:100-105, y:100-105
    const box = { x: 50, y: 50, w: 120, h: 120 }; // large blank area, glyph off-centre
    const cropped = cropToInk(img, box);
    // ink bbox [100,105]x[100,105] + margin 2 on every side: [98,108)x[98,108).
    expect(cropped).toEqual({ x: 98, y: 98, w: 10, h: 10 });
  });

  it("returns the box unchanged when it contains no ink (test 2)", () => {
    const img = blank(200, 200);
    const box = { x: 20, y: 30, w: 40, h: 25 };
    expect(cropToInk(img, box)).toEqual(box);
  });

  it("never returns smaller than minSizePx (test 3)", () => {
    const img = blank(200, 200);
    drawDot(img, 100, 100, 1); // a single ink pixel
    const box = { x: 90, y: 90, w: 30, h: 30 };
    const cropped = cropToInk(img, box, { minSizePx: 20 });
    expect(cropped.w).toBeGreaterThanOrEqual(20);
    expect(cropped.h).toBeGreaterThanOrEqual(20);
  });

  it("leaves an already-tight box roughly unchanged, within the margin (test 4)", () => {
    const img = blank(200, 200);
    drawDot(img, 100, 100, 6); // ink spans x:100-105, y:100-105
    const tight = { x: 100, y: 100, w: 6, h: 6 }; // already pixel-tight around the ink
    const cropped = cropToInk(img, tight);
    expect(cropped).toEqual({ x: 98, y: 98, w: 10, h: 10 });
    expect(Math.abs(cropped.x - tight.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(cropped.y - tight.y)).toBeLessThanOrEqual(2);
    expect(cropped.w - tight.w).toBeLessThanOrEqual(4);
    expect(cropped.h - tight.h).toBeLessThanOrEqual(4);
  });

  it("never throws on a box that runs off the edge of the image", () => {
    const img = blank(50, 50);
    drawDot(img, 46, 46, 4); // clipped by the image edge
    expect(() => cropToInk(img, { x: 40, y: 40, w: 20, h: 20 })).not.toThrow();
  });
});

describe("hasInk", () => {
  it("is true when the box contains a pixel darker than the threshold", () => {
    const img = blank(50, 50);
    drawDot(img, 10, 10, 3);
    expect(hasInk(img, { x: 0, y: 0, w: 50, h: 50 })).toBe(true);
  });

  it("is false on an all-blank box", () => {
    const img = blank(50, 50);
    expect(hasInk(img, { x: 0, y: 0, w: 50, h: 50 })).toBe(false);
  });

  it("respects a custom inkThreshold", () => {
    const img = blank(50, 50, 200); // uniform mid-grey, not white
    // 200 is "ink" only under a looser threshold than the 160 default.
    expect(hasInk(img, { x: 0, y: 0, w: 50, h: 50 })).toBe(false);
    expect(hasInk(img, { x: 0, y: 0, w: 50, h: 50 }, { inkThreshold: 210 })).toBe(true);
  });
});
