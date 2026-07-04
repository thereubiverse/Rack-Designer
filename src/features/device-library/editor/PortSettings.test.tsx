import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortSettings } from "./PortSettings";

describe("PortSettings", () => {
  it("shows the port label and current name", () => {
    render(<PortSettings portLabel="03" name="UPLINK" flipped={false} onChange={() => {}} />);
    expect(screen.getByTestId("port-settings")).toHaveTextContent(/port 03/i);
    expect(screen.getByLabelText(/port name/i)).toHaveValue("UPLINK");
  });

  it("emits the typed name", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="" flipped={false} onChange={onChange} />);
    await user.type(screen.getByLabelText(/port name/i), "A");
    expect(onChange).toHaveBeenLastCalledWith({ name: "A" });
  });

  it("emits undefined when the name is cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="X" flipped={false} onChange={onChange} />);
    await user.clear(screen.getByLabelText(/port name/i));
    expect(onChange).toHaveBeenLastCalledWith({ name: undefined });
  });

  it("toggles flip", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="" flipped={false} onChange={onChange} />);
    await user.click(screen.getByTestId("port-flip"));
    expect(onChange).toHaveBeenLastCalledWith({ flipped: true });
  });
});
