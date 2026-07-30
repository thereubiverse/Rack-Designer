import { describe, it, expect } from "vitest";
import type { FloorDeviceRow } from "@/lib/supabase/types";
import {
  dedupePolygon,
  edgeResizeCursor,
  insertVertexOnEdge,
  isNorm,
  isValidPolygon,
  moveEdge,
  normToScreen,
  partitionPlacement,
  polygonCentroid,
  removeVertex,
  screenToNorm,
  type NormPoint,
} from "./floorPlanOps";

function device(over: Partial<FloorDeviceRow>): FloorDeviceRow {
  return {
    id: "d1", site_id: "s1", floor_id: "f1", room_id: null, device_type_id: "t1",
    code: "CAM01", name: "", status: "planned", x: null, y: null,
    created_at: "2026-01-01", updated_at: "2026-01-01", ...over,
  };
}

describe("isNorm / isValidPolygon", () => {
  it("accepts 0 and 1 (edges are real placements — the Null Island lesson)", () => {
    expect(isNorm(0)).toBe(true);
    expect(isNorm(1)).toBe(true);
  });
  it("rejects out-of-range, NaN, Infinity", () => {
    for (const v of [-0.001, 1.001, NaN, Infinity, -Infinity]) expect(isNorm(v)).toBe(false);
  });
  it("rejects polygons below 3 vertices and malformed shapes, never throws", () => {
    for (const bad of [null, "x", [], [[0, 0]], [[0, 0], [1, 1]], [[0, 0], [1, 1], [0.5]], [[0, 0], [1, 1], [0.5, 2]]]) {
      expect(isValidPolygon(bad)).toBe(false);
    }
  });
  it("accepts a triangle on the exact edges", () => {
    expect(isValidPolygon([[0, 0], [1, 0], [0.5, 1]])).toBe(true);
  });
});

describe("insertVertexOnEdge / removeVertex", () => {
  const tri: [number, number][] = [[0, 0], [1, 0], [0.5, 1]];
  it("inserts the midpoint of the WRAPPING edge (last->first)", () => {
    const out = insertVertexOnEdge(tri, 2);
    expect(out).toHaveLength(4);
    expect(out[3]).toEqual([0.25, 0.5]);
  });
  it("does not mutate its input", () => {
    insertVertexOnEdge(tri, 0);
    expect(tri).toHaveLength(3);
  });
  it("refuses to remove below 3 vertices — returns the polygon unchanged", () => {
    expect(removeVertex(tri, 1)).toEqual(tri);
  });
  it("removes from a quad", () => {
    const quad: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(removeVertex(quad, 3)).toEqual([[0, 0], [1, 0], [1, 1]]);
  });
});

describe("partitionPlacement", () => {
  it("x=0, y=0 is PLACED — falsy checks are the bug this test exists to catch", () => {
    const d = device({ id: "edge", x: 0, y: 0 });
    const { placed, unplaced } = partitionPlacement([d]);
    expect(placed.map((p) => p.id)).toEqual(["edge"]);
    expect(unplaced).toEqual([]);
  });
  it("half-set coordinates count as unplaced (defensive; DB forbids the state)", () => {
    const { unplaced } = partitionPlacement([device({ x: 0.5, y: null })]);
    expect(unplaced).toHaveLength(1);
  });
});

describe("dedupePolygon", () => {
  const EPS = 1e-3;

  it("collapses an exact-duplicate consecutive vertex", () => {
    const out = dedupePolygon([[0.1, 0.1], [0.3, 0.1], [0.2, 0.2], [0.2, 0.2]], EPS);
    expect(out).toEqual([[0.1, 0.1], [0.3, 0.1], [0.2, 0.2]]);
  });

  it("collapses a near-duplicate consecutive vertex under epsilon", () => {
    const out = dedupePolygon([[0.1, 0.1], [0.3, 0.1], [0.220, 0.536], [0.2201, 0.5361]], EPS);
    expect(out).toEqual([[0.1, 0.1], [0.3, 0.1], [0.220, 0.536]]);
  });

  it("leaves distinct points (farther apart than epsilon) untouched", () => {
    const pts: [number, number][] = [[0.1, 0.1], [0.3, 0.1], [0.2, 0.9]];
    expect(dedupePolygon(pts, EPS)).toEqual(pts);
  });

  it("drops a trailing vertex that wraps around to duplicate the first", () => {
    const out = dedupePolygon([[0.1, 0.1], [0.3, 0.1], [0.2, 0.9], [0.1, 0.1]], EPS);
    expect(out).toEqual([[0.1, 0.1], [0.3, 0.1], [0.2, 0.9]]);
  });

  it("can drop below 3 vertices when enough of the input collapses — the caller must then refuse the close, exactly like any <3 polygon", () => {
    const out = dedupePolygon([[0.5, 0.5], [0.5, 0.5], [0.5001, 0.5001]], EPS);
    expect(out.length).toBeLessThan(3);
    expect(isValidPolygon(out)).toBe(false);
  });
});

describe("screenToNorm / normToScreen", () => {
  const view = { panX: 10, panY: 20, zoom: 2, imgW: 1000, imgH: 500 };
  it("round-trips", () => {
    const screen = normToScreen([0.25, 0.5], view);
    expect(screenToNorm(screen, view)).toEqual([0.25, 0.5]);
  });
  it("returns null outside the image", () => {
    expect(screenToNorm({ x: -1e9, y: 0 }, view)).toBeNull();
  });
  it("maps the origin corner exactly to [0,0]", () => {
    expect(screenToNorm({ x: 10, y: 20 }, view)).toEqual([0, 0]);
  });
});

describe("moveEdge", () => {
  // A unit square, clockwise from the top-left. Edge 0 is the TOP wall, edge 1 the RIGHT wall.
  const sq = (): NormPoint[] => [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.8, 0.8],
    [0.2, 0.8],
  ];

  it("slides a wall along its normal, keeping it parallel and taking its neighbours with it", () => {
    const out = moveEdge(sq(), 0, [0, 0.1]);
    expect(out[0]).toEqual([0.2, 0.30000000000000004]);
    expect(out[1]).toEqual([0.8, 0.30000000000000004]);
    // The other two corners are untouched — the side walls stretched to follow.
    expect(out[2]).toEqual([0.8, 0.8]);
    expect(out[3]).toEqual([0.2, 0.8]);
  });

  it("DISCARDS the component along the wall — a wall cannot slide sideways", () => {
    // A big sideways drag with no perpendicular component must do nothing at all.
    expect(moveEdge(sq(), 0, [0.3, 0])).toEqual(sq());
    // And a diagonal drag moves it only by its perpendicular part.
    const out = moveEdge(sq(), 0, [0.3, 0.1]);
    expect(out[0][0]).toBeCloseTo(0.2, 10);
    expect(out[0][1]).toBeCloseTo(0.3, 10);
  });

  it("retracts as well as extends", () => {
    const out = moveEdge(sq(), 0, [0, -0.1]);
    expect(out[0][1]).toBeCloseTo(0.1, 10);
    expect(out[1][1]).toBeCloseTo(0.1, 10);
  });

  it("moves a vertical wall horizontally", () => {
    const out = moveEdge(sq(), 1, [0.1, 0]);
    expect(out[1][0]).toBeCloseTo(0.9, 10);
    expect(out[2][0]).toBeCloseTo(0.9, 10);
    expect(out[1][1]).toBeCloseTo(0.2, 10);
  });

  it("scales the offset back at the plan edge instead of BENDING the wall", () => {
    // Pushing the top wall up by 0.5 would take it to -0.3; both endpoints must stop together.
    const out = moveEdge(sq(), 0, [0, -0.5]);
    expect(out[0][1]).toBeCloseTo(0, 10);
    expect(out[1][1]).toBeCloseTo(0, 10);
    expect(out[0][1]).toBeCloseTo(out[1][1], 10); // still parallel — the whole point
  });

  it("respects the plan's ASPECT when deciding what perpendicular means", () => {
    // A 45-degree wall in normalized space is NOT 45 degrees on a 3:2 sheet, so the same drag
    // resolves to a different offset once the aspect is taken into account.
    const diag: NormPoint[] = [[0.2, 0.2], [0.6, 0.6], [0.2, 0.6]];
    const square = moveEdge(diag, 0, [0.1, 0], 1);
    const wide = moveEdge(diag, 0, [0.1, 0], 2600 / 1733);
    expect(square[0][1]).not.toBeCloseTo(wide[0][1], 6);
  });

  it("leaves the polygon alone for a bad index, a degenerate edge, or too few points", () => {
    expect(moveEdge(sq(), 9, [0, 0.1])).toEqual(sq());
    expect(moveEdge(sq(), -1, [0, 0.1])).toEqual(sq());
    expect(moveEdge(sq(), 1.5, [0, 0.1])).toEqual(sq());
    expect(moveEdge([[0.1, 0.1], [0.2, 0.2]], 0, [0, 0.1])).toEqual([[0.1, 0.1], [0.2, 0.2]]);
    const dup: NormPoint[] = [[0.2, 0.2], [0.2, 0.2], [0.5, 0.5]];
    expect(moveEdge(dup, 0, [0, 0.1])).toEqual(dup);
  });

  it("does not mutate the input", () => {
    const p = sq();
    moveEdge(p, 0, [0, 0.1]);
    expect(p).toEqual(sq());
  });
});

describe("edgeResizeCursor", () => {
  it("points the arrows along the wall's normal", () => {
    // Horizontal wall -> you drag it up/down.
    expect(edgeResizeCursor([0.2, 0.2], [0.8, 0.2])).toBe("ns-resize");
    // Vertical wall -> left/right.
    expect(edgeResizeCursor([0.2, 0.2], [0.2, 0.8])).toBe("ew-resize");
    // Direction is irrelevant — the same wall drawn backwards drags the same way.
    expect(edgeResizeCursor([0.8, 0.2], [0.2, 0.2])).toBe("ns-resize");
  });

  it("uses the diagonal cursors for angled walls", () => {
    expect(edgeResizeCursor([0.2, 0.2], [0.6, 0.6])).toBe("nesw-resize");
    expect(edgeResizeCursor([0.2, 0.6], [0.6, 0.2])).toBe("nwse-resize");
  });

  it("falls back to grab on a degenerate edge rather than picking a meaningless arrow", () => {
    expect(edgeResizeCursor([0.3, 0.3], [0.3, 0.3])).toBe("grab");
  });
});
