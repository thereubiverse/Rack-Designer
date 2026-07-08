import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddDevicePicker } from "./AddDevicePicker";
import { emptyFace } from "@/domain/faceplate";
import type { PickerTemplate } from "@/features/device-library/repository";

const tpl = (id: string, name: string): PickerTemplate => ({
  id, name, brandId: null, brandName: "cisco", deviceTypeId: "t1",
  rackUnits: 1, widthIn: 17.5, rackMounted: true, frontFace: emptyFace(), backFace: emptyFace(),
});

describe("AddDevicePicker", () => {
  it("lists templates of the type; selecting shows previews; Insert fires with the template", async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(<AddDevicePicker typeName="Switch" templates={[tpl("a", "cisco 48p"), tpl("b", "cisco 24p")]} onInsert={onInsert} onClose={() => {}} />);
    expect(screen.getByText("Add device")).toBeInTheDocument();
    expect(screen.getByText("cisco 24p")).toBeInTheDocument();
    await user.click(screen.getByText("cisco 48p"));
    expect(screen.getByText(/1 RU/)).toBeInTheDocument();
    expect(screen.getAllByTestId("faceplate-svg").length).toBe(2); // front + back previews
    await user.click(screen.getByTestId("picker-insert"));
    expect(onInsert).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });
  it("empty type shows a hint and no Insert", () => {
    render(<AddDevicePicker typeName="UPS" templates={[]} onInsert={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/no .* templates yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("picker-insert")).not.toBeInTheDocument();
  });
});
