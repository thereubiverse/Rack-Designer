import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeviceTypesManager } from "./DeviceTypesManager";
import type { DeviceTypeRow } from "./repository";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("./typeActions", () => ({
  createDeviceTypeAction: vi.fn(async () => ({ ok: true })),
  saveDeviceTypesAction: vi.fn(async () => ({ ok: true })),
  deleteDeviceTypeAction: vi.fn(async () => ({ ok: true })),
}));
import { createDeviceTypeAction, saveDeviceTypesAction, deleteDeviceTypeAction } from "./typeActions";

function row(over: Partial<DeviceTypeRow>): DeviceTypeRow {
  return {
    id: "t1", name: "Switch", created_at: "2026-01-01",
    category: "rack", code: "SW", is_standard: true, ...over,
  };
}
const floor = [row({ id: "f1", name: "Camera", code: "CAM", category: "floor" })];
const rack = [
  row({ id: "r1", name: "Switch", code: "SW" }),
  row({ id: "r2", name: "Media Converter", code: "MC", is_standard: false }),
];

beforeEach(() => vi.clearAllMocks());

describe("DeviceTypesManager", () => {
  it("renders both columns with standard codes and custom rows", () => {
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    expect(screen.getByText("Floor Device Types")).toBeInTheDocument();
    expect(screen.getByText("Rack Device Types")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CAM")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Media Converter")).toBeInTheDocument(); // custom name is an input
    expect(screen.getByText("Switch")).toBeInTheDocument();                  // standard name is text
  });

  it("standard rows have no delete button; custom rows do", () => {
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    expect(screen.queryByTestId("delete-type-r1")).not.toBeInTheDocument();
    expect(screen.getByTestId("delete-type-r2")).toBeInTheDocument();
  });

  it("editing a code enables that column's Save and saves only changed rows", async () => {
    const user = userEvent.setup();
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    const save = screen.getByTestId("save-rack");
    expect(save).toBeDisabled();
    const code = screen.getByDisplayValue("SW");
    await user.clear(code);
    await user.type(code, "SWX");
    expect(save).toBeEnabled();
    await user.click(save);
    expect(saveDeviceTypesAction).toHaveBeenCalledWith([{ id: "r1", code: "SWX" }]);
    expect(refresh).toHaveBeenCalled();
  });

  it("Add opens the create modal and validates the prefix before creating", async () => {
    const user = userEvent.setup();
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    await user.click(screen.getByTestId("add-type-rack"));
    await user.type(screen.getByTestId("new-type-name"), "PDU Bar");
    await user.click(screen.getByTestId("new-type-create")); // empty prefix
    expect(createDeviceTypeAction).not.toHaveBeenCalled();
    expect(screen.getAllByText(/1–4 characters/).length).toBeGreaterThan(0);
    await user.type(screen.getByTestId("new-type-code"), "pdub"); // normalizes to PDUB
    await user.click(screen.getByTestId("new-type-create"));
    expect(createDeviceTypeAction).toHaveBeenCalledWith({ name: "PDU Bar", code: "PDUB", category: "rack" });
  });

  it("deleting a custom type calls the action and surfaces failures", async () => {
    (deleteDeviceTypeAction as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "This type is in use by a device template" });
    const user = userEvent.setup();
    render(<DeviceTypesManager floor={floor} rack={rack} />);
    await user.click(screen.getByTestId("delete-type-r2"));
    expect(deleteDeviceTypeAction).toHaveBeenCalledWith("r2");
    expect(await screen.findByText("This type is in use by a device template")).toBeInTheDocument();
  });
});
