import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackDeviceSettings } from "./RackDeviceSettings";
import { emptyFace } from "@/domain/faceplate";

const d = {
  id: "d1", deviceTemplateId: "t1", code: "SW01", name: null, startU: 5, side: "front" as const,
  status: "installed" as const, manufacturer: null, modelName: null, serialNumber: null,
  purchaseDate: null, operationStart: null,
  frontFace: emptyFace(), backFace: emptyFace(), heightU: 1,
};

describe("RackDeviceSettings", () => {
  it("shows the code and fires onChange patches for edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RackDeviceSettings device={d} templateName="cisco 48p" codeError={null} onChange={onChange} onDelete={() => {}} />);
    expect(screen.getByDisplayValue("SW01")).toBeInTheDocument();
    expect(screen.getByText("cisco 48p")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/status/i), "verified");
    expect(onChange).toHaveBeenCalledWith({ status: "verified" });
    await user.type(screen.getByLabelText(/serial/i), "X");
    expect(onChange).toHaveBeenCalledWith({ serialNumber: "X" });
  });
  it("renders a code error and a delete button", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<RackDeviceSettings device={d} templateName="x" codeError="Duplicate ID" onChange={() => {}} onDelete={onDelete} />);
    expect(screen.getByText("Duplicate ID")).toBeInTheDocument();
    await user.click(screen.getByTestId("device-delete"));
    expect(onDelete).toHaveBeenCalled();
  });
});
