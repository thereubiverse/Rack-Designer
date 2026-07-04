import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortGroupSettings } from "./PortGroupSettings";
import type { PortGroup } from "@/domain/faceplate";

function grp(over: Partial<PortGroup> = {}): PortGroup {
  return {
    id: "g", media: "copper", connectorType: "RJ45", idPrefix: "",
    countingDirection: "ltr", rows: 1, cols: 1, gridX: 0, gridY: 0,
    colSpacing: 0, rowSpacing: 0, portOverrides: {}, ...over,
  };
}

describe("PortGroupSettings", () => {
  it("shows the media in the header and the media's connector options", () => {
    render(<PortGroupSettings group={grp()} onChange={() => {}} onDelete={() => {}} />);
    expect(screen.getByTestId("pg-settings")).toHaveTextContent(/copper/i);
    const connector = screen.getByLabelText(/connector type/i) as HTMLSelectElement;
    expect([...connector.options].map((o) => o.value)).toEqual(["RJ45", "RJ11", "Keystone"]);
  });

  it("emits patches for ID prefix, counting direction, connector type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortGroupSettings group={grp()} onChange={onChange} onDelete={() => {}} />);
    await user.type(screen.getByLabelText(/id prefix/i), "G");
    expect(onChange).toHaveBeenLastCalledWith({ idPrefix: "G" });
    await user.selectOptions(screen.getByLabelText(/counting direction/i), "rtl");
    expect(onChange).toHaveBeenLastCalledWith({ countingDirection: "rtl" });
    await user.selectOptions(screen.getByLabelText(/connector type/i), "Keystone");
    expect(onChange).toHaveBeenLastCalledWith({ connectorType: "Keystone" });
  });

  it("calls onDelete", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<PortGroupSettings group={grp()} onChange={() => {}} onDelete={onDelete} />);
    await user.click(screen.getByTestId("pg-delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
