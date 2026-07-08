// src/features/racks/RackFrame.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RackFrame, ruTopY, rackSvgSize, RACK_INTERIOR_W } from "./RackFrame";
import { RU_PX } from "@/domain/faceplate-geometry";
import { emptyFace, type Face } from "@/domain/faceplate";

const face: Face = emptyFace();
const tpl = { rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: face, backFace: face };

describe("rack geometry", () => {
  it("sizes the svg from the rack height", () => {
    const { height } = rackSvgSize(12);
    expect(height).toBeGreaterThan(12 * RU_PX); // interior + padding
  });
  it("ruTopY puts U1 at the bottom", () => {
    // a 1U device at U1 sits one RU above the interior bottom
    expect(ruTopY(1, 1, 12)).toBeGreaterThan(ruTopY(12, 1, 12));
    expect(ruTopY(12, 1, 12)).toBeLessThan(RU_PX); // top slot near the top edge
  });
});

describe("RackFrame", () => {
  it("renders rails, one slot marker per RU, and RU numbers", () => {
    render(<svg>{RackFrame({ heightU: 4, placements: [], side: "FRONT" })}</svg>);
    expect(screen.getAllByTestId("rack-slot")).toHaveLength(4);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
  it("renders a placed device's faceplate at its RU", () => {
    render(
      <svg>
        {RackFrame({ heightU: 4, placements: [{ id: "d1", startU: 2, template: tpl }], side: "FRONT" })}
      </svg>,
    );
    expect(screen.getByTestId("rack-device-d1")).toBeInTheDocument();
    // occupied RU no longer shows a free-slot marker
    expect(screen.getAllByTestId("rack-slot")).toHaveLength(3);
  });
  it("interior width is the 19-inch rail span", () => {
    expect(RACK_INTERIOR_W).toBe(912);
  });
});
