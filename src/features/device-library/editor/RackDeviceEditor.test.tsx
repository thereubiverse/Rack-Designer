import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
    expect(screen.getByLabelText(/width/i)).toBeInTheDocument();
    expect(screen.getByTestId("faceplate-svg")).toBeInTheDocument();
  });

  it("Save is disabled until the draft is valid, then calls onSave", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={onSave} onCancel={noop} />);
    const save = screen.getByTestId("editor-save");
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText(/name/i), "48-port");
    await user.selectOptions(screen.getByLabelText(/device type/i), "t1");
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
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} />);
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

  it("adds and selects a brand via + Add brand", async () => {
    const user = userEvent.setup();
    const onCreateBrand = vi.fn(async (name: string): Promise<BrandRow> => ({
      id: "b2", organization_id: "o", name, created_at: "",
    }));
    render(
      <RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={noop} onCreateBrand={onCreateBrand} />,
    );
    await user.click(screen.getByRole("button", { name: /add brand/i }));
    await user.type(screen.getByTestId("brand-add-input"), "Juniper");
    await user.click(screen.getByTestId("brand-add-confirm"));
    expect(onCreateBrand).toHaveBeenCalledWith("Juniper");
  });

  it("Cancel calls onCancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<RackDeviceEditor mode="create" types={types} brands={brands} onSave={noop} onCancel={onCancel} />);
    await user.click(screen.getByTestId("editor-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
