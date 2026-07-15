import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { outletPortRects, OutletFaceplate, PLATE_W, PLATE_H } from "./outletFaceplate";
import type { OutletPortCount } from "./endpointOps";

/** Port centres, in port-number order. */
const centres = (n: OutletPortCount) =>
  outletPortRects(n).map((r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 }));

describe("outletPortRects", () => {
  it("gives a blank plate no openings at all", () => {
    expect(outletPortRects(0)).toEqual([]);
  });

  it("puts every count on the plate the reference family shows", () => {
    // 1/2/3 are a single column; 4 is 2x2; 6 is 2x3.
    const cols = (n: OutletPortCount) => new Set(centres(n).map((c) => c.x)).size;
    const rows = (n: OutletPortCount) => new Set(centres(n).map((c) => c.y)).size;
    expect([cols(1), rows(1)]).toEqual([1, 1]);
    expect([cols(2), rows(2)]).toEqual([1, 2]);
    expect([cols(3), rows(3)]).toEqual([1, 3]);
    expect([cols(4), rows(4)]).toEqual([2, 2]);
    expect([cols(6), rows(6)]).toEqual([2, 3]);
  });

  it("returns one rect per port", () => {
    for (const n of [0, 1, 2, 3, 4, 6] as OutletPortCount[]) {
      expect(outletPortRects(n)).toHaveLength(n);
    }
  });

  it("numbers ports left-to-right, top-to-bottom", () => {
    const c = centres(6);
    // row 1: 1,2 — same y, ascending x
    expect(c[0].y).toBe(c[1].y);
    expect(c[0].x).toBeLessThan(c[1].x);
    // rows descend
    expect(c[0].y).toBeLessThan(c[2].y);
    expect(c[2].y).toBeLessThan(c[4].y);
    // the column x's repeat per row
    expect(c[2].x).toBe(c[0].x);
    expect(c[3].x).toBe(c[1].x);
  });

  it("centres every layout on the plate", () => {
    for (const n of [1, 2, 3, 4, 6] as OutletPortCount[]) {
      const c = centres(n);
      const midX = (Math.min(...c.map((p) => p.x)) + Math.max(...c.map((p) => p.x))) / 2;
      const midY = (Math.min(...c.map((p) => p.y)) + Math.max(...c.map((p) => p.y))) / 2;
      expect(midX).toBeCloseTo(PLATE_W / 2);
      expect(midY).toBeCloseTo(PLATE_H / 2);
    }
  });

  it("keeps every opening inside the plate", () => {
    for (const n of [1, 2, 3, 4, 6] as OutletPortCount[]) {
      for (const r of outletPortRects(n)) {
        expect(r.x).toBeGreaterThan(0);
        expect(r.y).toBeGreaterThan(0);
        expect(r.x + r.w).toBeLessThan(PLATE_W);
        expect(r.y + r.h).toBeLessThan(PLATE_H);
      }
    }
  });
});

describe("OutletFaceplate", () => {
  it("renders an opening per port and marks the landing one", () => {
    render(<OutletFaceplate portCount={4} landingPortIndex={2} />);
    expect(screen.getAllByTestId(/^outlet-port-/)).toHaveLength(4);
    expect(screen.getByTestId("outlet-port-2").getAttribute("data-landing")).toBe("true");
    expect(screen.getByTestId("outlet-port-0").getAttribute("data-landing")).toBe("false");
  });

  it("renders a blank plate with no openings and no landing port", () => {
    render(<OutletFaceplate portCount={0} />);
    expect(screen.queryAllByTestId(/^outlet-port-/)).toHaveLength(0);
    expect(screen.getByTestId("endpoint-face")).toBeTruthy();
  });

  it("draws no port as landing when no landing index is given", () => {
    render(<OutletFaceplate portCount={2} />);
    for (const p of screen.getAllByTestId(/^outlet-port-/)) {
      expect(p.getAttribute("data-landing")).toBe("false");
    }
  });
});
