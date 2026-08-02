import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { ClientsTable } from "./ClientsTable";
import { archiveClientAction } from "./actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  createClientAction: vi.fn(async () => ({ ok: true })),
  renameClientAction: vi.fn(async () => ({ ok: true })),
  archiveClientAction: vi.fn(async () => ({ ok: true })),
}));

const clients = [
  { id: "c1", code: "ACME", name: "Acme Corp", siteCount: 3, rackCount: 12, deviceCount: 41, floorDeviceCount: 0 },
];

describe("ClientsTable", () => {
  it("renders a linked row per client with site and rack counts", () => {
    render(<ClientsTable clients={clients} />);
    const row = screen.getByTestId("client-row-ACME");
    const link = within(row).getByRole("link", { name: /Acme Corp/ });
    expect(link).toHaveAttribute("href", "/clients/ACME");
    expect(row).toHaveTextContent("3");
    expect(row).toHaveTextContent("12");
  });

  it("shows an empty state that still offers the create control", () => {
    render(<ClientsTable clients={[]} />);
    expect(screen.getByText("No clients yet")).toBeInTheDocument();
    expect(screen.getByTestId("table-create")).toBeInTheDocument();
  });

  it("keeps the failure visible when an archive fails, instead of silently closing", async () => {
    // Regression for the IMPORTANT finding: archive paths awaited the action but never checked
    // res.ok, so a failed archive closed the dialog and refreshed exactly like a success — no
    // message told the user anything went wrong.
    vi.mocked(archiveClientAction).mockResolvedValueOnce({ ok: false, error: "Cannot archive: has dependent racks" });

    render(<ClientsTable clients={clients} />);
    fireEvent.click(screen.getByTestId("delete-client-ACME"));
    // Archiving is reversible, so there is no typed-confirm gate to satisfy first.
    fireEvent.click(screen.getByTestId("archive-confirm"));

    await waitFor(() => expect(screen.getByTestId("archive-error-message")).toHaveTextContent("Cannot archive: has dependent racks"));
    // The dialog must still be open — the failure was not treated as a success.
    expect(screen.getByTestId("archive-confirm")).toBeInTheDocument();
  });
});
