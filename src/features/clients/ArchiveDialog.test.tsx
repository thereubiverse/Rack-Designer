import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ArchiveDialog } from "./ArchiveDialog";

const base = {
  kind: "client" as const,
  code: "URI",
  error: null,
  busy: false,
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe("ArchiveDialog", () => {
  it("says the record can be restored, and does NOT threaten deletion", () => {
    render(<ArchiveDialog {...base} />);
    const text = screen.getByTestId("archive-dialog").textContent ?? "";
    expect(text).toContain("restored");
    // The old copy claimed "This will permanently delete ..." — after archiving that is false.
    expect(text).not.toMatch(/permanently/i);
    expect(text).not.toMatch(/delete/i);
  });

  it("confirms WITHOUT a typed code — archiving is reversible", () => {
    // A confirmation that costs as much as a destructive one teaches people to type through both.
    const onConfirm = vi.fn();
    render(<ArchiveDialog {...base} onConfirm={onConfirm} />);
    expect(screen.queryByLabelText(/type/i)).toBeNull();
    fireEvent.click(screen.getByTestId("archive-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("names the thing being archived", () => {
    render(<ArchiveDialog {...base} kind="floor" code="GF" />);
    expect(screen.getByTestId("archive-dialog").textContent).toContain("GF");
  });

  it("shows an error and stays open", () => {
    render(<ArchiveDialog {...base} error="db down" />);
    expect(screen.getByTestId("archive-error-message").textContent).toContain("db down");
  });

  it("disables both buttons while busy so a double click cannot double-archive", () => {
    render(<ArchiveDialog {...base} busy />);
    expect(screen.getByTestId("archive-confirm")).toBeDisabled();
    expect(screen.getByTestId("archive-cancel")).toBeDisabled();
  });
});
