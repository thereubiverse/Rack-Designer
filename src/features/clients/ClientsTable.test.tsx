import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { ClientsTable } from "./ClientsTable";
import { archiveClientAction, renameClientAction, createClientAction } from "./actions";
import { RoleContext } from "@/features/shell/roleContext";

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

  // React 19 resets a <form action={fn}> to defaultValue when the action settles, whatever it
  // resolved to. These two pin the fix: on a failed save the dialog stays open AND still holds what
  // the user typed, so the error is about a value they can see.
  it("keeps the edited code in the rename dialog when saving fails", async () => {
    vi.mocked(renameClientAction).mockResolvedValueOnce({ ok: false, error: "That code is taken" });

    render(<ClientsTable clients={clients} />);
    fireEvent.click(screen.getByTestId("edit-client-ACME"));

    const code = screen.getByDisplayValue("ACME") as HTMLInputElement;
    fireEvent.change(code, { target: { value: "TAKEN" } });
    fireEvent.click(screen.getByText("Save"));

    await waitFor(() => expect(screen.getByText("That code is taken")).toBeInTheDocument());
    expect((screen.getByDisplayValue("TAKEN") as HTMLInputElement).value).toBe("TAKEN");
  });

  it("keeps what was typed in the create dialog when saving fails", async () => {
    vi.mocked(createClientAction).mockResolvedValueOnce({ ok: false, error: "That code is taken" });

    render(<ClientsTable clients={clients} />);
    fireEvent.click(screen.getByTestId("table-create"));
    const dialog = within(screen.getByRole("dialog", { name: "Add client" }));

    // Both fields are `required`, and onSubmit runs native constraint validation — so an empty
    // name would block submission before the action ever ran.
    fireEvent.change(dialog.getByLabelText(/code/i), { target: { value: "NEWCO" } });
    fireEvent.change(dialog.getByLabelText(/name/i), { target: { value: "New Co" } });
    fireEvent.click(dialog.getByText("Create"));

    await waitFor(() => expect(dialog.getByText("That code is taken")).toBeInTheDocument());
    expect((dialog.getByLabelText(/code/i) as HTMLInputElement).value).toBe("NEWCO");
  });

  // Presentation only — see roleContext.tsx. The server already refuses a viewer's create/rename/
  // archive after Task 4; this just confirms the buttons that would only ever fail are not shown.
  it("hides the create and edit/delete controls for a viewer, and shows them for an editor", () => {
    const { rerender } = render(
      <RoleContext.Provider value="viewer">
        <ClientsTable clients={clients} />
      </RoleContext.Provider>
    );
    expect(screen.queryByTestId("table-create")).toBeNull();
    expect(screen.queryByTestId("edit-client-ACME")).toBeNull();

    rerender(
      <RoleContext.Provider value="editor">
        <ClientsTable clients={clients} />
      </RoleContext.Provider>
    );
    expect(screen.getByTestId("table-create")).toBeInTheDocument();
    expect(screen.getByTestId("edit-client-ACME")).toBeInTheDocument();
  });
});
