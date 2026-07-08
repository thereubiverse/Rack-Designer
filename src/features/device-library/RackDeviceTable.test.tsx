import { describe, it, expect, vi } from "vitest";
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

describe("RackDeviceTable sorting", () => {
  const dataRows = () => screen.getAllByRole("row").slice(1).map((r) => r.querySelector("td")?.textContent);
  it("sorts by a column header, toggling asc/desc", async () => {
    const user = userEvent.setup();
    render(<RackDeviceTable rows={rows} />);
    expect(dataRows()).toEqual(["48xCAT 4xSFP", "Mini Patch 12"]); // default name asc
    await user.click(screen.getByRole("button", { name: /^name/i }));
    expect(dataRows()).toEqual(["Mini Patch 12", "48xCAT 4xSFP"]); // → desc
  });
});

describe("RackDeviceTable pagination", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: String(i), name: `Dev ${String(i).padStart(2, "0")}`,
    brandName: null, typeName: "Switch", rackUnits: 1, widthIn: 19, rackMounted: true,
  }));
  it("shows one page of 10 and advances to the next", async () => {
    const user = userEvent.setup();
    render(<RackDeviceTable rows={many} />);
    expect(screen.getAllByRole("row").slice(1)).toHaveLength(10); // page 1
    expect(screen.getByText("Dev 00")).toBeInTheDocument();
    expect(screen.queryByText("Dev 11")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /next page/i }));
    expect(screen.getByText("Dev 11")).toBeInTheDocument(); // page 2
    expect(screen.queryByText("Dev 00")).not.toBeInTheDocument();
  });
});

describe("RackDeviceTable edit action", () => {
  it("calls onEdit with the row id when Edit is clicked", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<RackDeviceTable rows={rows} onEdit={onEdit} />);
    await user.click(screen.getByTestId("edit-1"));
    expect(onEdit).toHaveBeenCalledWith("1");
  });
});

describe("RackDeviceTable row actions", () => {
  it("renders duplicate/edit/delete icons and fires their callbacks", async () => {
    const user = userEvent.setup();
    const onDuplicate = vi.fn(), onEdit = vi.fn(), onDelete = vi.fn();
    render(<RackDeviceTable rows={rows} onEdit={onEdit} onDuplicate={onDuplicate} onDelete={onDelete} />);
    await user.click(screen.getByTestId("duplicate-1"));
    await user.click(screen.getByTestId("edit-1"));
    await user.click(screen.getByTestId("delete-1"));
    expect(onDuplicate).toHaveBeenCalledWith("1");
    expect(onEdit).toHaveBeenCalledWith("1");
    expect(onDelete).toHaveBeenCalledWith("1");
  });

  it("name becomes a view link when onView is provided", async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    render(<RackDeviceTable rows={rows} onView={onView} />);
    await user.click(screen.getByTestId("view-1"));
    expect(onView).toHaveBeenCalledWith("1");
  });
});
