import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DeleteDialog } from "./DeleteDialog";

const base = { open: true, kind: "client" as const, code: "ACME", onConfirm: vi.fn(), onCancel: vi.fn() };

describe("DeleteDialog", () => {
  it("spells out what the delete destroys", () => {
    render(<DeleteDialog {...base} counts={{ sites: 3, racks: 7, devices: 41 }} />);
    expect(screen.getByTestId("delete-cascade")).toHaveTextContent("3 sites, 7 racks and 41 devices");
  });

  it("keeps Delete locked until the code is typed exactly", () => {
    render(<DeleteDialog {...base} counts={{ racks: 2 }} />);
    const confirm = screen.getByTestId("delete-confirm");
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByTestId("delete-code-input"), { target: { value: "acme" } });
    expect(confirm).toBeDisabled();                       // case must match
    fireEvent.change(screen.getByTestId("delete-code-input"), { target: { value: "ACME" } });
    expect(confirm).toBeEnabled();
  });

  it("skips the typing gate entirely when nothing would be destroyed", () => {
    render(<DeleteDialog {...base} counts={{}} />);
    expect(screen.queryByTestId("delete-code-input")).toBeNull();
    expect(screen.getByTestId("delete-confirm")).toBeEnabled();
  });

  it("fires onConfirm only once the gate is satisfied", () => {
    const onConfirm = vi.fn();
    render(<DeleteDialog {...base} counts={{ racks: 1 }} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByTestId("delete-confirm"));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("delete-code-input"), { target: { value: "ACME" } });
    fireEvent.click(screen.getByTestId("delete-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
