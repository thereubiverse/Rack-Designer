import { describe, it, expect } from "vitest";
import type { FloorDeviceRow } from "@/lib/supabase/types";
import {
  isNorm, isValidPolygon, insertVertexOnEdge, removeVertex,
  polygonCentroid, partitionPlacement, screenToNorm, normToScreen,
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
