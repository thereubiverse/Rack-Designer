import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddDevicePicker } from "./AddDevicePicker";
import { emptyFace } from "@/domain/faceplate";
import type { DeviceTypeRow, PickerTemplate } from "@/features/device-library/repository";

const type = (id: string, name: string, code: string): DeviceTypeRow => ({
  id, organization_id: "o1", name, created_at: "", category: "rack", code, is_standard: true,
});
const tpl = (id: string, name: string, typeId: string): PickerTemplate => ({
  id, name, brandId: null, brandName: "cisco", deviceTypeId: typeId,
  rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: emptyFace(), backFace: emptyFace(),
});

const types = [type("t1", "Switch", "SW"), type("t2", "UPS", "UPS")];
const templatesByType = {
  t1: [tpl("a", "cisco 48p", "t1"), tpl("b", "cisco 24p", "t1")],
  t2: [],
};

describe("AddDevicePicker", () => {
  it("type list → pick type → pick template → previews + Insert fires", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<AddDevicePicker types={types} templatesByType={templatesByType} onInsert={onInsert} onClose={() => {}} />);
    // Level 1: the type list, not templates yet.
    expect(screen.getByText("Select type")).toBeInTheDocument();
    expect(screen.getByTestId("picker-type-SW")).toBeInTheDocument();
    expect(screen.queryByText("cisco 48p")).toBeNull();
    // Drill into Switch → templates appear.
    await user.click(screen.getByTestId("picker-type-SW"));
    expect(screen.getByText("cisco 24p")).toBeInTheDocument();
    await user.click(screen.getByText("cisco 48p"));
    expect(screen.getByText(/1 RU/)).toBeInTheDocument();
    expect(screen.getAllByTestId("faceplate-svg").length).toBe(2); // front + back previews
    await user.click(screen.getByTestId("picker-insert"));
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("initialTypeId opens straight to the templates; back arrow returns to the type list", async () => {
    const user = userEvent.setup();
    render(<AddDevicePicker types={types} templatesByType={templatesByType} initialTypeId="t1" onInsert={() => {}} onClose={() => {}} />);
    expect(screen.getByText("cisco 48p")).toBeInTheDocument(); // level 2 directly
    expect(screen.queryByText("Select type")).toBeNull();
    await user.click(screen.getByTestId("picker-back"));
    expect(screen.getByText("Select type")).toBeInTheDocument();
    expect(screen.getByTestId("picker-type-UPS")).toBeInTheDocument();
  });

  it("filters templates by the search box", async () => {
    const user = userEvent.setup();
    render(<AddDevicePicker types={types} templatesByType={templatesByType} initialTypeId="t1" onInsert={() => {}} onClose={() => {}} />);
    await user.type(screen.getByPlaceholderText("Search"), "48");
    expect(screen.getByText("cisco 48p")).toBeInTheDocument();
    expect(screen.queryByText("cisco 24p")).toBeNull();
  });

  it("empty type shows a hint and no Insert", () => {
    render(<AddDevicePicker types={types} templatesByType={templatesByType} initialTypeId="t2" onInsert={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no ups templates yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("picker-insert")).not.toBeInTheDocument();
  });
});
