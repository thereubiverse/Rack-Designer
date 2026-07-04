import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Faceplate } from "./Faceplate";
import { emptyFace, type Face, type PortGroup } from "@/domain/faceplate";

function copperGroup(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g1",
    media: "copper",
    connectorType: "RJ45",
    idPrefix: "",
    countingDirection: "ltr",
    rows: 1,
    cols: 4,
    gridX: 0,
    gridY: 0,
    colSpacing: 0,
    rowSpacing: 0,
    portOverrides: {},
    ...over,
  };
}

describe("Faceplate", () => {
  it("renders one composed SVG at true 19in : 1.75in-per-U proportion when rack-mounted", () => {
    const { getByTestId } = render(
      <Faceplate face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted />,
    );
    const svg = getByTestId("faceplate-svg");
    // aspect ratio ~ 19 : 1.75
    const w = Number(svg.getAttribute("width"));
    const h = Number(svg.getAttribute("height"));
    expect(w / h).toBeCloseTo(19 / 1.75, 1);
  });

  it("draws screw holes when rack-mounted (4 for 1U)", () => {
    const { getAllByTestId } = render(
      <Faceplate face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted />,
    );
    expect(getAllByTestId("screw-hole")).toHaveLength(4);
  });

  it("drops the ears and screw holes when not rack-mounted, keeping the grid", () => {
    const { queryAllByTestId, getByTestId } = render(
      <Faceplate face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted={false} />,
    );
    expect(queryAllByTestId("screw-hole")).toHaveLength(0);
    expect(getByTestId("faceplate-body")).toBeInTheDocument();
  });

  it("renders one port cell per port in the group", () => {
    const face: Face = { portGroups: [copperGroup()], elements: [] };
    const { getAllByTestId } = render(
      <Faceplate face={face} widthIn={19} rackUnits={1} rackMounted />,
    );
    expect(getAllByTestId("port-cell")).toHaveLength(4);
  });

  it("shows the FRONT side label when provided", () => {
    const { getByText } = render(
      <Faceplate
        face={emptyFace()}
        widthIn={19}
        rackUnits={1}
        rackMounted
        side="FRONT"
      />,
    );
    expect(getByText("FRONT")).toBeInTheDocument();
  });
});
