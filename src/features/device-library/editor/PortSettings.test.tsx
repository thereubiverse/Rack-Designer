import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PortSettings, BatchSettings } from "./PortSettings";

describe("PortSettings", () => {
  it("shows the port label and current name", () => {
    render(<PortSettings portLabel="03" name="UPLINK" rotation={0} labelPos="top" onChange={() => {}} />);
    expect(screen.getByTestId("port-settings")).toHaveTextContent(/port 03/i);
    expect(screen.getByLabelText(/port name/i)).toHaveValue("UPLINK");
  });

  it("emits the typed name", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="" rotation={0} labelPos="top" onChange={onChange} />);
    await user.type(screen.getByLabelText(/port name/i), "A");
    expect(onChange).toHaveBeenLastCalledWith({ name: "A" });
  });

  it("emits undefined when the name is cleared", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="X" rotation={0} labelPos="top" onChange={onChange} />);
    await user.clear(screen.getByLabelText(/port name/i));
    expect(onChange).toHaveBeenLastCalledWith({ name: undefined });
  });

  it("flip toggle rotates the port 180°", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="" rotation={0} labelPos="top" onChange={onChange} />);
    await user.click(screen.getByTestId("port-flip"));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 180 });
  });

  it("flip toggle rotates a 180° port back to 0°", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="" rotation={180} labelPos="top" onChange={onChange} />);
    await user.click(screen.getByTestId("port-flip"));
    expect(onChange).toHaveBeenLastCalledWith({ rotation: 0 });
  });

  it("toggles label position top↔bottom", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<PortSettings portLabel="01" name="" rotation={0} labelPos="top" onChange={onChange} />);
    await user.click(screen.getByTestId("port-labelpos"));
    expect(onChange).toHaveBeenLastCalledWith({ labelPos: "bottom" });
  });

  it("hides the label toggle when hideLabel is set (label owned by the vertical snap)", () => {
    render(<PortSettings portLabel="01" name="" rotation={0} labelPos="top" onChange={() => {}} hideLabel />);
    expect(screen.queryByTestId("port-labelpos")).toBeNull();
    expect(screen.getByTestId("port-flip")).toBeInTheDocument(); // flip still available
  });
});

describe("BatchSettings", () => {
  it("hides the label toggle when hideLabel is set", () => {
    render(<BatchSettings title="2 ports selected" rotated="off" labelPos="top" onFlip={() => {}} onLabel={() => {}} hideLabel />);
    expect(screen.queryByTestId("batch-labelpos")).toBeNull();
    expect(screen.getByTestId("batch-flip")).toBeInTheDocument();
  });

  it("shows the label toggle by default", () => {
    render(<BatchSettings title="2 ports selected" rotated="off" labelPos="top" onFlip={() => {}} onLabel={() => {}} />);
    expect(screen.getByTestId("batch-labelpos")).toBeInTheDocument();
  });
});
