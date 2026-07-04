import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackDeviceTable } from "./RackDeviceTable";
import type { DeviceTemplateListRow } from "./repository";

const rows: DeviceTemplateListRow[] = [
  { id: "1", name: "48xCAT 4xSFP", brandName: "Generic", typeName: "Switch", rackUnits: 1, widthIn: 19, rackMounted: true },
  { id: "2", name: "Mini Patch 12", brandName: null, typeName: "Patch Panel", rackUnits: 1, widthIn: 10.6, rackMounted: true },
];

describe("RackDeviceTable", () => {
  it("renders a row per template", () => {
    render(<RackDeviceTable rows={rows} />);
    expect(screen.getByText("48xCAT 4xSFP")).toBeInTheDocument();
    expect(screen.getByText("Mini Patch 12")).toBeInTheDocument();
  });
  it("filters by search", async () => {
    render(<RackDeviceTable rows={rows} />);
    await userEvent.type(screen.getByPlaceholderText(/search/i), "Patch");
    expect(screen.queryByText("48xCAT 4xSFP")).not.toBeInTheDocument();
    expect(screen.getByText("Mini Patch 12")).toBeInTheDocument();
  });
  it("shows an em dash when brand is null", () => {
    render(<RackDeviceTable rows={[rows[1]]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
