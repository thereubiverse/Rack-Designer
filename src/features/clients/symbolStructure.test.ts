import { describe, expect, it } from "vitest";
import {
  CLUSTER_PX,
  classifyFill,
  clusterPrimitives,
  extractPrimitives,
  findMatches,
  lenEq,
  signatureFor,
  signaturesMatch,
  type Primitive,
  type StructPath,
} from "./symbolStructure";

/** One straight run as its OWN path — which is how this drawing set emits a triangle's sides, and
 *  the reason every per-path search found nothing. */
function segPath(a: [number, number], b: [number, number], grey = false): StructPath {
  return {
    segs: [{ a, b }],
    minX: Math.min(a[0], b[0]),
    minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]),
    maxY: Math.max(a[1], b[1]),
    grey,
  };
}

/** An equilateral triangle of side 8, delivered as three separate single-segment paths. */
function triangle8(ox = 0, oy = 0, grey = false): StructPath[] {
  const A: [number, number] = [ox, oy];
  const B: [number, number] = [ox + 8, oy];
  const C: [number, number] = [ox + 4, oy + 6.93];
  return [segPath(A, B, grey), segPath(B, C, grey), segPath(C, A, grey)];
}

function rotate(paths: StructPath[], deg: number): StructPath[] {
  const r = (deg * Math.PI) / 180;
  const cs = Math.cos(r);
  const sn = Math.sin(r);
  const rp = ([x, y]: [number, number]): [number, number] => [x * cs - y * sn, x * sn + y * cs];
  return paths.map((p) => {
    const segs = p.segs.map((s) => ({ a: rp(s.a), b: rp(s.b) }));
    const xs = segs.flatMap((s) => [s.a[0], s.b[0]]);
    const ys = segs.flatMap((s) => [s.a[1], s.b[1]]);
    return {
      segs,
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
      grey: p.grey,
    };
  });
}

describe("extractPrimitives", () => {
  it("closes a triangle whose three sides arrive as three SEPARATE paths", () => {
    const prims = extractPrimitives(triangle8());
    expect(prims).toHaveLength(1);
    expect(prims[0].kind).toBe("polygon");
    if (prims[0].kind !== "polygon") throw new Error("unreachable");
    expect(prims[0].sides).toHaveLength(3);
    for (const s of prims[0].sides) expect(s).toBeCloseTo(8, 0);
  });

  it("finds the same triangle whatever order the sides arrive in", () => {
    const [a, b, c] = triangle8();
    for (const order of [
      [a, b, c],
      [c, a, b],
      [b, c, a],
      [c, b, a],
    ]) {
      expect(extractPrimitives(order)).toHaveLength(1);
    }
  });

  it("REFUSES a chain that fails to close — a 2px gap is not a triangle", () => {
    const paths = triangle8();
    // Pull one endpoint away by 2px, past the 1.4px join tolerance.
    paths[2] = segPath([4, 6.93], [2, 0]);
    expect(extractPrimitives(paths)).toHaveLength(0);
  });

  it("EXCLUDES screened-back paths — the background layer's X-braced boxes close triangles too", () => {
    // Load-bearing, not tidiness: measured on E-102P, without this filter the page yields 122
    // "symbols" of which 89 are those background braces.
    expect(extractPrimitives(triangle8(0, 0, true))).toHaveLength(0);
  });

  it("rejects three nearly-collinear segments, which enclose no area", () => {
    const paths = [
      segPath([0, 0], [8, 0]),
      segPath([8, 0], [4, 0.1]),
      segPath([4, 0.1], [0, 0]),
    ];
    expect(extractPrimitives(paths)).toHaveLength(0);
  });

  it("reads a circle from a path with NO straight runs and a square bbox", () => {
    const circle: StructPath = { segs: [], minX: 0, minY: 0, maxX: 10, maxY: 10, grey: false };
    const prims = extractPrimitives([circle]);
    expect(prims).toHaveLength(1);
    expect(prims[0].kind).toBe("circle");
    if (prims[0].kind !== "circle") throw new Error("unreachable");
    expect(prims[0].radius).toBeCloseTo(5, 5);
  });

  it("does not read a long thin curve-only path as a circle", () => {
    const arc: StructPath = { segs: [], minX: 0, minY: 0, maxX: 30, maxY: 4, grey: false };
    expect(extractPrimitives([arc])).toHaveLength(0);
  });

  it("keeps only MINIMAL faces — a ring through two adjoining triangles is dropped", () => {
    // A square split by a diagonal: two triangles are the faces; the square's own 4-side ring is
    // their union and must not survive, or instances that decompose differently stop matching.
    const paths = [
      segPath([0, 0], [10, 0]),
      segPath([10, 0], [10, 10]),
      segPath([10, 10], [0, 10]),
      segPath([0, 10], [0, 0]),
      segPath([0, 0], [10, 10]), // the diagonal
    ];
    const prims = extractPrimitives(paths);
    expect(prims).toHaveLength(2);
    for (const p of prims) {
      if (p.kind !== "polygon") throw new Error("expected polygons");
      expect(p.sides).toHaveLength(3);
    }
  });
});

describe("lenEq", () => {
  it("accepts a rasterisation wobble and rejects a genuinely different size", () => {
    expect(lenEq(8, 8.4)).toBe(true);
    expect(lenEq(8, 7.7)).toBe(true);
    expect(lenEq(8, 12)).toBe(false);
  });
});

describe("clusterPrimitives", () => {
  const at = (cx: number, cy: number): Primitive => ({
    kind: "polygon",
    sides: [8, 8, 8],
    cx,
    cy,
    r: 4,
    verts: [[cx, cy]],
  });

  it("merges parts of one symbol and keeps separate symbols apart", () => {
    expect(clusterPrimitives([at(0, 0), at(3, 0)])).toHaveLength(1);
    expect(clusterPrimitives([at(0, 0), at(9, 0)])).toHaveLength(2);
  });

  it("keeps a transitive chain together", () => {
    // A-B and B-C are each within CLUSTER_PX while A-C is not; they are still one symbol.
    const g = clusterPrimitives([at(0, 0), at(CLUSTER_PX - 0.5, 0), at(2 * CLUSTER_PX - 1, 0)]);
    expect(g).toHaveLength(1);
    expect(g[0]).toHaveLength(3);
  });
});

describe("signatures", () => {
  const box = { minX: -20, minY: -20, maxX: 20, maxY: 20 };

  it("is UNCHANGED by rotation — the wall's angle must not matter", () => {
    const straight = signatureFor(extractPrimitives(triangle8()), box);
    expect(straight).not.toBeNull();
    for (const deg of [17, 37, 90, 143, 270]) {
      const turned = signatureFor(extractPrimitives(rotate(triangle8(), deg)), {
        minX: -30,
        minY: -30,
        maxX: 30,
        maxY: 30,
      });
      expect(turned).not.toBeNull();
      expect(signaturesMatch(straight!, turned!)).toBe(true);
    }
  });

  it("tells a different-sized triangle apart", () => {
    const small = signatureFor(extractPrimitives(triangle8()), box)!;
    const big: StructPath[] = [
      segPath([0, 0], [16, 0]),
      segPath([16, 0], [8, 13.86]),
      segPath([8, 13.86], [0, 0]),
    ];
    const large = signatureFor(extractPrimitives(big), { minX: -30, minY: -30, maxX: 30, maxY: 30 })!;
    expect(signaturesMatch(small, large)).toBe(false);
  });

  it("returns null when the picked box contains no primitive at all", () => {
    expect(signatureFor(extractPrimitives(triangle8()), { minX: 500, minY: 500, maxX: 520, maxY: 520 }))
      .toBeNull();
  });

  it("distinguishes a lone circle from another circle of a different radius", () => {
    const c = (max: number): StructPath => ({ segs: [], minX: 0, minY: 0, maxX: max, maxY: max, grey: false });
    const b = { minX: -5, minY: -5, maxX: 60, maxY: 60 };
    const a10 = signatureFor(extractPrimitives([c(10)]), b)!;
    const a10b = signatureFor(extractPrimitives([c(10)]), b)!;
    const a30 = signatureFor(extractPrimitives([c(30)]), b)!;
    expect(signaturesMatch(a10, a10b)).toBe(true);
    expect(signaturesMatch(a10, a30)).toBe(false);
  });
});

describe("findMatches", () => {
  it("finds every instance of the picked symbol, at any rotation, and nothing else", () => {
    const paths = [
      ...triangle8(0, 0),
      ...triangle8(100, 0),
      ...rotate(triangle8(0, 0), 41).map((p) => ({
        ...p,
        segs: p.segs.map((s) => ({
          a: [s.a[0] + 200, s.a[1] + 200] as [number, number],
          b: [s.b[0] + 200, s.b[1] + 200] as [number, number],
        })),
        minX: p.minX + 200,
        minY: p.minY + 200,
        maxX: p.maxX + 200,
        maxY: p.maxY + 200,
      })),
      // a decoy of a different size, which must NOT match
      segPath([400, 0], [416, 0]),
      segPath([416, 0], [408, 13.86]),
      segPath([408, 13.86], [400, 0]),
    ];
    const prims = extractPrimitives(paths);
    const sig = signatureFor(prims, { minX: -5, minY: -5, maxX: 15, maxY: 15 })!;
    const hits = findMatches(prims, sig);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.parts >= 1)).toBe(true);
  });
});

describe("classifyFill", () => {
  /** A 40x40 field with an `ink`-radius filled square at the centre. */
  const field = (inkRadius: number) => {
    const width = 40;
    const height = 40;
    const data = new Uint8Array(width * height).fill(255);
    for (let y = 20 - inkRadius; y < 20 + inkRadius; y++) {
      for (let x = 20 - inkRadius; x < 20 + inkRadius; x++) data[y * width + x] = 0;
    }
    return { data, width, height };
  };
  const hit = { x: 20, y: 20, r: 10, parts: 2 };

  it("separates solid, half-shaded and hollow — the legend's own distinction", () => {
    // On this drawing set a SOLID triangle is "telephone/data outlet with two RJ-45" and a hollow
    // one is "data outlet"; geometry cannot tell them apart, so the fill is what does.
    expect(classifyFill(field(9), hit)).toBe("solid");
    expect(classifyFill(field(4), hit)).toBe("half");
    expect(classifyFill(field(1), hit)).toBe("hollow");
  });

  it("does not read past the edge of the image", () => {
    expect(() => classifyFill(field(4), { x: 0, y: 0, r: 10, parts: 1 })).not.toThrow();
    expect(() => classifyFill(field(4), { x: 39, y: 39, r: 10, parts: 1 })).not.toThrow();
  });
});

describe("signatureFor with an over-selecting pick box", () => {
  const seg = (a: [number, number], b: [number, number]): StructPath => ({
    segs: [{ a, b }],
    minX: Math.min(a[0], b[0]),
    minY: Math.min(a[1], b[1]),
    maxX: Math.max(a[0], b[0]),
    maxY: Math.max(a[1], b[1]),
    grey: false,
  });
  const tri = (ox: number, oy: number): StructPath[] => [
    seg([ox, oy], [ox + 8, oy]),
    seg([ox + 8, oy], [ox + 4, oy + 6.93]),
    seg([ox + 4, oy + 6.93], [ox, oy]),
  ];
  /** A neighbouring tag box, of the sort a real pick drags in alongside the symbol. */
  const tag = (ox: number, oy: number): StructPath[] => [
    seg([ox, oy], [ox + 20, oy]),
    seg([ox + 20, oy], [ox + 20, oy + 12]),
    seg([ox + 20, oy + 12], [ox, oy + 12]),
    seg([ox, oy + 12], [ox, oy]),
  ];

  it("describes only the symbol nearest the click, not the tag dragged in beside it", () => {
    // Measured failure this guards: a real pick box is 15-70px, which swallowed the neighbour's
    // corners, matched nothing, and silently dropped discovery back to correlation.
    const alone = extractPrimitives(tri(100, 100));
    const tight = signatureFor(alone, { minX: 96, minY: 96, maxX: 114, maxY: 114 })!;

    const crowded = extractPrimitives([...tri(100, 100), ...tag(125, 100)]);
    const wide = signatureFor(crowded, { minX: 80, minY: 80, maxX: 160, maxY: 130 })!;

    expect(wide.points).toBe(tight.points);
    expect(signaturesMatch(tight, wide)).toBe(true);
  });

  it("returns null when no symbol's centre falls in the box at all", () => {
    const prims = extractPrimitives(tri(100, 100));
    expect(signatureFor(prims, { minX: 900, minY: 900, maxX: 950, maxY: 950 })).toBeNull();
  });
});
