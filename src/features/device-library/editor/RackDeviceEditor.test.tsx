import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackDeviceEditor } from "./RackDeviceEditor";
import type { DeviceTypeRow, BrandRow } from "../repository";
import type { Face } from "@/domain/faceplate";

const types: DeviceTypeRow[] = [{ id: "t1", organization_id: "o", name: "Switch", created_at: "" }];
const brands: BrandRow[] = [{ id: "b1", organization_id: "o", name: "Cisco", created_at: "" }];

const oneGroupFace: Face = {
  portGroups: [{
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 3, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {},
  }],
  elements: [],
};

function noop() {}

describe("RackDeviceEditor", () => {
  it("renders header fields and a faceplate preview", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/device type/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/width \(in\)/i)).toBeInTheDocument();
    expect(screen.getByTestId("faceplate-svg")).toBeInTheDocument();
  });

  it("Save is disabled until the draft is valid, then calls onSave", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={onSave} onCancel={noop} />);
    const save = screen.getByTestId("editor-save");
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/name/i), "48-port");
    await user.click(screen.getByTestId("device-type-trigger"));
    await user.click(screen.getByRole("option", { name: "Switch" }));
    expect(save).toBeEnabled();
    await user.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ name: "48-port", deviceTypeId: "t1" });
  });

  it("Front/Back toggle switches the previewed side", async () => {
    const user = userEvent.setup();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    expect(screen.getByText("FRONT")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText("BACK")).toBeInTheDocument();
  });

  it("Rack Mounted toggle drops the screw holes in the preview", async () => {
    const user = userEvent.setup();
    render(
      <RackDeviceEditor
        mode="create"
        types={types}
        brands={brands}
        initial={{ widthIn: 10.6 }}
        onSave={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getAllByTestId("screw-hole").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /rack mounted/i }));
    expect(screen.queryAllByTestId("screw-hole")).toHaveLength(0);
  });

  it("edit mode pre-fills fields and the active face", () => {
    render(
      <RackDeviceEditor
        mode="edit"
        types={types}
        brands={brands}
        initial={{ name: "Core-SW", deviceTypeId: "t1", brandId: "b1", widthIn: 10.6, frontFace: oneGroupFace }}
        onSave={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByLabelText(/name/i)).toHaveValue("Core-SW");
    expect(screen.getByTestId("editor-save")).toHaveTextContent(/save/i);
    // the pre-filled front face renders 3 port cells
    expect(screen.getAllByTestId("port-cell")).toHaveLength(3);
  });

  it("adds a brand from inside the dropdown", async () => {
    const user = userEvent.setup();
    const onCreateBrand = vi.fn(async (name: string): Promise<BrandRow> => ({
      id: "b2", organization_id: "o", name, created_at: "",
    }));
    render(
      <RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} onCreateBrand={onCreateBrand} />,
    );
    await user.click(screen.getByTestId("brand-trigger")); // open dropdown
    await user.click(screen.getByTestId("brand-add"));      // reveal the inline input
    await user.type(screen.getByTestId("brand-add-input"), "Juniper");
    await user.click(screen.getByTestId("brand-add-confirm"));
    expect(onCreateBrand).toHaveBeenCalledWith("Juniper");
  });

  it("deletes a brand from a row inside the dropdown", async () => {
    const user = userEvent.setup();
    const onDeleteBrand = vi.fn(async () => true);
    render(
      <RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} onDeleteBrand={onDeleteBrand} />,
    );
    await user.click(screen.getByTestId("brand-trigger")); // open dropdown
    expect(screen.getByRole("option", { name: "Cisco" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /delete cisco/i }));
    expect(onDeleteBrand).toHaveBeenCalledWith("b1");
    // the row disappears from the still-open menu
    expect(screen.queryByRole("option", { name: "Cisco" })).toBeNull();
  });

  it("does not offer a delete button for the protected Generic brand", async () => {
    const user = userEvent.setup();
    const withGeneric: BrandRow[] = [
      { id: "b1", organization_id: "o", name: "Cisco", created_at: "" },
      { id: "bg", organization_id: "o", name: "Generic", created_at: "" },
    ];
    render(
      <RackDeviceEditor mode="create" types={types} brands={withGeneric} onSave={noop} onCancel={noop} onDeleteBrand={vi.fn(async () => true)} />,
    );
    await user.click(screen.getByTestId("brand-trigger"));
    expect(screen.getByRole("option", { name: "Generic" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete generic/i })).toBeNull();
    expect(screen.getByRole("button", { name: /delete cisco/i })).toBeInTheDocument();
  });

  it("Cancel calls onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={onCancel} />);
    await user.click(screen.getByTestId("editor-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("clicking the backdrop does NOT close the editor (guards against stray drag-releases)", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={onCancel} />);
    await user.click(screen.getByTestId("rack-device-editor")); // the backdrop root itself
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("closing a device with unsaved work asks to confirm instead of closing", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={onCancel} />);
    await user.type(screen.getByLabelText(/name/i), "Switch"); // make it dirty
    await user.click(screen.getByTestId("editor-cancel"));
    expect(onCancel).not.toHaveBeenCalled();               // held back by the warning
    expect(screen.getByTestId("discard-confirm")).toBeInTheDocument();
    await user.click(screen.getByTestId("discard-confirm-btn"));
    expect(onCancel).toHaveBeenCalledTimes(1);              // Discard closes
  });

  it("'Keep editing' dismisses the warning without closing", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={onCancel} />);
    await user.type(screen.getByLabelText(/name/i), "Switch"); // make it dirty
    await user.click(screen.getByTestId("editor-cancel"));
    await user.click(screen.getByTestId("discard-cancel"));
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.queryByTestId("discard-confirm")).not.toBeInTheDocument();
  });

  it("does not close when clicking inside the dialog panel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={onCancel} />);
    await user.click(screen.getByLabelText(/name/i));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("pressing Escape calls onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={onCancel} />);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("RackDeviceEditor — port-group building", () => {
  it("dropping a palette media creates a group and selects it (settings appear)", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} initial={{ name: "S", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={noop} />);
    fireEvent.drop(screen.getByTestId("editor-overlay"), { dataTransfer: { getData: () => "copper" }, clientX: 60, clientY: 12 });
    expect(screen.getByTestId("pg-settings")).toBeInTheDocument();
    expect(screen.getAllByTestId("port-cell").length).toBe(1);
  });

  it("chevron adds a column (preview gains a port cell)", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} initial={{ name: "S", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={noop} />);
    fireEvent.drop(screen.getByTestId("editor-overlay"), { dataTransfer: { getData: () => "copper" }, clientX: 40, clientY: 12 });
    expect(screen.getAllByTestId("port-cell").length).toBe(1);
    fireEvent.pointerDown(screen.getByTestId("chevron-col"), { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 });
    expect(screen.getAllByTestId("port-cell").length).toBe(2);
  });

  it("deleting the selected group removes it and hides settings", () => {
    const user = userEvent.setup();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} initial={{ name: "S", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={noop} />);
    fireEvent.drop(screen.getByTestId("editor-overlay"), { dataTransfer: { getData: () => "copper" }, clientX: 40, clientY: 12 });
    expect(screen.getByTestId("pg-settings")).toBeInTheDocument();
    return user.click(screen.getByTestId("pg-delete")).then(() => {
      expect(screen.queryByTestId("pg-settings")).toBeNull();
      expect(screen.queryAllByTestId("port-cell")).toHaveLength(0);
    });
  });

  it("switching Front/Back deselects the group", async () => {
    const user = userEvent.setup();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} initial={{ name: "S", deviceTypeId: "t1", widthIn: 19 }} onSave={noop} onCancel={noop} />);
    fireEvent.drop(screen.getByTestId("editor-overlay"), { dataTransfer: { getData: () => "copper" }, clientX: 40, clientY: 12 });
    expect(screen.getByTestId("pg-settings")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.queryByTestId("pg-settings")).toBeNull();
  });
});

describe("RackDeviceEditor — per-port editing", () => {
  function withGroup() {
    const face: Face = {
      portGroups: [{
        id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
        countingDirection: "ltr", rows: 1, cols: 3, gridX: 0, gridY: 0,
        colSpacing: 0, rowSpacing: 0, portOverrides: {},
      }],
      elements: [],
    };
    render(<RackDeviceEditor mode="edit" types={types} brands={brands}
      initial={{ name: "S", deviceTypeId: "t1", widthIn: 19, frontFace: face }} onSave={noop} onCancel={noop} />);
  }

  it("selecting a port shows the port panel", () => {
    withGroup();
    // select the group first
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-1"));
    expect(screen.getByTestId("port-settings")).toBeInTheDocument();
  });

  it("the rotate button rotates the selected port icon 180° (disabled with no port)", () => {
    withGroup();
    const rotate = screen.getByTestId("rotate-element");
    expect(rotate).toBeDisabled(); // nothing selected yet
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    expect(rotate).toBeEnabled();
    const glyph = () => screen.getAllByTestId("port-cell")[0].querySelector("g[transform]")?.getAttribute("transform") ?? "";
    expect(glyph()).not.toContain("rotate(180");
    fireEvent.click(rotate);
    expect(glyph()).toContain("rotate(180");
    fireEvent.click(rotate); // 180 + 180 = back to 0
    expect(glyph()).not.toContain("rotate(180");
  });

  it("clicking empty canvas space deselects the group and port", () => {
    withGroup();
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-1"));
    expect(screen.getByTestId("pg-settings")).toBeInTheDocument();
    expect(screen.getByTestId("port-settings")).toBeInTheDocument();
    // click empty palette space (the "Port Types" label) — both selections clear
    fireEvent.click(screen.getByText("Port Types"));
    expect(screen.queryByTestId("pg-settings")).toBeNull();
    expect(screen.queryByTestId("port-settings")).toBeNull();
  });

  it("typing a port name updates the rendered label", async () => {
    const user = userEvent.setup();
    withGroup();
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    await user.type(screen.getByLabelText(/port name/i), "WAN");
    // "WAN" renders twice while the port is selected: once in the always-on
    // faceplate SVG label, once in the blue port-highlight overlay copy.
    expect(screen.getAllByText("WAN").length).toBeGreaterThan(0);
  });

  it("switching Front/Back clears the port selection", async () => {
    const user = userEvent.setup();
    withGroup();
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    expect(screen.getByTestId("port-settings")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.queryByTestId("port-settings")).toBeNull();
  });
});

describe("RackDeviceEditor — 3d refinements", () => {
  function withGroup() {
    const face: Face = {
      portGroups: [{
        id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
        countingDirection: "ltr", rows: 1, cols: 3, gridX: 0, gridY: 0,
        colSpacing: 0, rowSpacing: 0, portOverrides: {},
      }],
      elements: [],
    };
    render(<RackDeviceEditor mode="edit" types={types} brands={brands}
      initial={{ name: "S", deviceTypeId: "t1", widthIn: 19, frontFace: face }} onSave={noop} onCancel={noop} />);
  }

  it("selecting a port highlights it in the preview (blue tile, no overlay copy)", () => {
    withGroup();
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-1"));
    expect(screen.queryByTestId("port-highlight")).toBeNull();
    const blued = screen.getAllByTestId("port-cell").filter((c) => c.getAttribute("data-highlighted") === "true");
    expect(blued).toHaveLength(1);
  });

  it("locks a single-row group's label to the vertical snap (no per-port label toggle)", () => {
    withGroup(); // 1×3 single-row group — its label side is owned by the snap positions
    fireEvent.click(screen.getByTestId("group-box-g"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    expect(screen.getByTestId("port-settings")).toBeInTheDocument(); // panel still shows (name/flip)
    expect(screen.queryByTestId("port-labelpos")).toBeNull();        // but no standalone label toggle
  });
});

describe("RackDeviceEditor — palette sections (3e)", () => {
  it("renders Port Types and Elements sections; Icon is draggable, Text still inert", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    expect(screen.getByText("Port Types")).toBeInTheDocument();
    expect(screen.getByText("Elements")).toBeInTheDocument();
    expect(screen.getByTestId("element-text")).not.toHaveAttribute("draggable", "true");
    expect(screen.getByTestId("element-icon").getAttribute("draggable")).toBe("true"); // Icon is now live
    // a media chip is still draggable
    expect(screen.getByTitle("Copper").getAttribute("draggable")).toBe("true");
  });
});

describe("RackDeviceEditor — palette drag ghost", () => {
  const dt = { setData() {}, setDragImage() {}, effectAllowed: "" };
  it("shows a floating chip clone while dragging and removes it on drop/end", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    const chip = screen.getByTitle("Copper");
    expect(screen.queryByTestId("palette-drag-ghost")).toBeNull();
    fireEvent.dragStart(chip, { clientX: 100, clientY: 100, dataTransfer: dt });
    const ghost = screen.getByTestId("palette-drag-ghost");
    expect(ghost).toHaveTextContent("Copper");
    expect(chip.className).toContain("opacity-40"); // source dims while dragging
    fireEvent.dragEnd(chip);
    expect(screen.queryByTestId("palette-drag-ghost")).toBeNull();
  });

  it("the Icon chip drags with a follow-cursor ghost like the media chips (dims source, clears on end)", () => {
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    const chip = screen.getByTestId("element-icon");
    expect(screen.queryByTestId("palette-drag-ghost")).toBeNull();
    fireEvent.dragStart(chip, { clientX: 100, clientY: 100, dataTransfer: dt });
    const ghost = screen.getByTestId("palette-drag-ghost");
    expect(ghost).toHaveTextContent("Icon");
    expect(chip.className).toContain("opacity-40"); // source dims while dragging
    fireEvent.dragEnd(chip);
    expect(screen.queryByTestId("palette-drag-ghost")).toBeNull();
  });

  it("the Icon chip drag uses a 'move' effect so real drops aren't rejected by the overlay", () => {
    // The overlay's onDragOver forces dropEffect='move'; the chip's effectAllowed must include it
    // or the browser rejects the drop and the picker never opens.
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
    const d = { setData() {}, setDragImage() {}, effectAllowed: "" };
    fireEvent.dragStart(screen.getByTestId("element-icon"), { dataTransfer: d });
    expect(d.effectAllowed).toBe("move");
  });
});

describe("RackDeviceEditor — multi-select (shift+click)", () => {
  // Two non-overlapping 2-port groups so both single- and multi-group paths are testable.
  const twoGroupFace: Face = {
    portGroups: [
      { id: "g1", media: "copper", connectorType: "RJ45", idPrefix: "", countingDirection: "ltr", rows: 1, cols: 2, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {} },
      { id: "g2", media: "copper", connectorType: "RJ45", idPrefix: "", countingDirection: "ltr", rows: 1, cols: 2, gridX: 300, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {} },
    ],
    elements: [],
  };
  function render2() {
    render(<RackDeviceEditor mode="edit" types={types} brands={brands}
      initial={{ name: "S", deviceTypeId: "t1", widthIn: 19, frontFace: twoGroupFace }} onSave={noop} onCancel={noop} />);
  }
  const rotated = () => screen.getAllByTestId("port-cell").filter((c) => (c.querySelector("g[transform]")?.getAttribute("transform") ?? "").includes("rotate(180"));

  it("shift+clicking ports selects several and shows the batch panel", () => {
    render2();
    fireEvent.click(screen.getByTestId("group-box-g1"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    fireEvent.click(screen.getByTestId("port-target-1"), { shiftKey: true });
    expect(screen.getByTestId("batch-settings")).toHaveTextContent("2 ports selected");
    const blued = screen.getAllByTestId("port-cell").filter((c) => c.getAttribute("data-highlighted") === "true");
    expect(blued).toHaveLength(2);
  });

  it("batch Flip rotates every selected port", () => {
    render2();
    fireEvent.click(screen.getByTestId("group-box-g1"));
    fireEvent.click(screen.getByTestId("port-target-0"));
    fireEvent.click(screen.getByTestId("port-target-1"), { shiftKey: true });
    expect(rotated()).toHaveLength(0);
    fireEvent.click(screen.getByTestId("batch-flip"));
    expect(rotated()).toHaveLength(2); // both selected ports in g1
  });

  it("shift+clicking group boxes selects several groups (and clears port selection)", () => {
    render2();
    fireEvent.click(screen.getByTestId("group-box-g1"));
    fireEvent.click(screen.getByTestId("group-box-g2"), { shiftKey: true });
    expect(screen.getByTestId("batch-settings")).toHaveTextContent("2 groups selected");
    expect(screen.getByTestId("group-box-g1").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("group-box-g2").getAttribute("data-selected")).toBe("true");
  });

  it("batch Flip on multiple groups rotates every port in each group", () => {
    render2();
    fireEvent.click(screen.getByTestId("group-box-g1"));
    fireEvent.click(screen.getByTestId("group-box-g2"), { shiftKey: true });
    fireEvent.click(screen.getByTestId("batch-flip"));
    expect(rotated()).toHaveLength(4); // all 4 ports across both groups
  });

  it("Delete groups button removes all selected groups", () => {
    render2();
    fireEvent.click(screen.getByTestId("group-box-g1"));
    fireEvent.click(screen.getByTestId("group-box-g2"), { shiftKey: true });
    fireEvent.click(screen.getByTestId("batch-delete"));
    expect(screen.queryByTestId("group-box-g1")).toBeNull();
    expect(screen.queryByTestId("group-box-g2")).toBeNull();
  });

  it("the Delete key removes the selected group(s)", () => {
    render2();
    fireEvent.click(screen.getByTestId("group-box-g1"));
    fireEvent.keyDown(window, { key: "Delete" });
    expect(screen.queryByTestId("group-box-g1")).toBeNull();
    expect(screen.getByTestId("group-box-g2")).toBeInTheDocument(); // untouched
  });
});
