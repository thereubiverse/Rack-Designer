import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Faceplate, renderFace } from "./Faceplate";
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

  it("draws the two mounting ears when rack-mounted, and never any screw holes", () => {
    const { getAllByTestId, queryAllByTestId } = render(
      <Faceplate face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted />,
    );
    expect(getAllByTestId("face-ear")).toHaveLength(2);
    // Screw holes were removed outright so the ear's full width is free for its label.
    expect(queryAllByTestId("screw-hole")).toHaveLength(0);
  });

  it("drops the ears when not rack-mounted, keeping the grid", () => {
    const { queryAllByTestId, getByTestId } = render(
      <Faceplate face={emptyFace()} widthIn={10.6} rackUnits={1} rackMounted={false} />,
    );
    expect(queryAllByTestId("face-ear")).toHaveLength(0);
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

function cg(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 2, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}

describe("Faceplate — highlight & label position", () => {
  it("recolours only the highlighted port's tile blue", () => {
    const face: Face = { portGroups: [cg()], elements: [] };
    const { getAllByTestId } = render(
      <Faceplate face={face} widthIn={19} rackUnits={1} rackMounted highlight={{ groupId: "g1", portIndex: 1 }} />,
    );
    const cells = getAllByTestId("port-cell");
    const highlighted = cells.filter((c) => c.getAttribute("data-highlighted") === "true");
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0].innerHTML).toContain("#2d5bff");
  });

  it("no port is highlighted when highlight is null", () => {
    const face: Face = { portGroups: [cg()], elements: [] };
    const { getAllByTestId } = render(
      <Faceplate face={face} widthIn={19} rackUnits={1} rackMounted highlight={null} />,
    );
    expect(getAllByTestId("port-cell").every((c) => c.getAttribute("data-highlighted") === "false")).toBe(true);
  });

  it("renders a port's label below the glyph when labelPos is bottom", () => {
    const face: Face = { portGroups: [cg({ portOverrides: { 0: { labelPos: "bottom" } } })], elements: [] };
    const { getAllByTestId } = render(
      <Faceplate face={face} widthIn={19} rackUnits={1} rackMounted />,
    );
    // the first cell's label <text> y should be below its glyph box (greater y than a top label)
    const cell0 = getAllByTestId("port-cell")[0];
    const text = cell0.querySelector("text")!;
    const cell1 = getAllByTestId("port-cell")[1]; // default top
    const text1 = cell1.querySelector("text")!;
    expect(Number(text.getAttribute("y"))).toBeGreaterThan(Number(text1.getAttribute("y")));
  });
});

describe("Faceplate — icon elements", () => {
  it("renders a placed icon element (placeholder until the Iconify data loads)", () => {
    const face: Face = {
      portGroups: [],
      elements: [{ id: "e1", kind: "icon", gridX: 40, gridY: 20, w: 36, h: 36, iconName: "tabler:home" }],
    };
    const { getByTestId } = render(<Faceplate face={face} widthIn={19} rackUnits={1} rackMounted side="FRONT" />);
    // jsdom has no cached icon, so the loading placeholder renders at the element's box.
    const ph = getByTestId("face-icon-loading");
    expect(ph.getAttribute("x")).toBe("40");
    expect(ph.getAttribute("width")).toBe("36");
  });

  it("an ear is a clean unbroken fill — no screw holes punched in it, tinted or plain", () => {
    // Screw holes are gone from the faceplate entirely; the ear's full width belongs to its label.
    // Checked on BOTH ear states because the holes used to render differently on each (white
    // cutouts on a selected blue ear, grey dots on a plain one).
    for (const earColor of ["#155dfc", undefined]) {
      const { container } = render(
        <svg>{renderFace(emptyFace(), { widthIn: 17.5, rackUnits: 1, rackMounted: true, earColor })}</svg>,
      );
      expect(container.querySelectorAll('[data-testid="screw-hole"]')).toHaveLength(0);
      expect(container.querySelectorAll('[data-testid="face-ear"]')).toHaveLength(2);
    }
  });
});
