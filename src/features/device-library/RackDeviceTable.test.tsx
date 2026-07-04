import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RackDeviceTable } from "./RackDeviceTable";
import type { DeviceTemplateListRow } from "./repository";

const rows: DeviceTemplateListRow[] = [
  { id: "d1", name: "Core-SW", brandName: "Cisco", typeName: "Switch", rackUnits: 1, widthIn: 19, rackMounted: true },
];

describe("RackDeviceTable edit action", () => {
  it("calls onEdit with the row id when Edit is clicked", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<RackDeviceTable rows={rows} onEdit={onEdit} />);
    await user.click(screen.getByTestId("edit-d1"));
    expect(onEdit).toHaveBeenCalledWith("d1");
  });
});
