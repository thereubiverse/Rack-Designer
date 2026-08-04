import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import { UsersTable } from "./UsersTable";
import { inviteMemberAction, setMemberRoleAction, setMemberActiveAction } from "./actions";
import type { MemberRow } from "./repository";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("./actions", () => ({
  inviteMemberAction: vi.fn(async () => ({ ok: true })),
  setMemberRoleAction: vi.fn(async () => ({ ok: true })),
  setMemberActiveAction: vi.fn(async () => ({ ok: true })),
}));

function member(overrides: Partial<MemberRow> = {}): MemberRow {
  return {
    id: "m1",
    email: "jane@example.com",
    name: "Jane Doe",
    role: "editor",
    disabledAt: null,
    authUserId: "auth-1",
    invitedAt: "2026-01-01T00:00:00.000Z",
    lastSignInAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("UsersTable", () => {
  it("renders a row per member with name, email and role label", () => {
    const members = [member()];
    render(<UsersTable members={members} meId="someone-else" />);
    const row = screen.getByTestId("user-row-m1");
    expect(row).toHaveTextContent("Jane Doe");
    expect(row).toHaveTextContent("jane@example.com");
    // Not the signed-in member's own row, so the role is a select, not plain text.
    const select = within(row).getByTestId("role-select-m1") as HTMLSelectElement;
    expect(select.value).toBe("editor");
  });

  it("shows Active when authUserId is set and disabledAt is null", () => {
    const members = [member({ authUserId: "auth-1", disabledAt: null })];
    render(<UsersTable members={members} meId="someone-else" />);
    expect(screen.getByTestId("user-row-m1")).toHaveTextContent("Active");
  });

  it("shows Pending, presented neutrally, when authUserId is null", () => {
    const members = [member({ authUserId: null, disabledAt: null, lastSignInAt: null })];
    render(<UsersTable members={members} meId="someone-else" />);
    const row = screen.getByTestId("user-row-m1");
    expect(row).toHaveTextContent("Pending");
    // Pending is a normal state, not an error: no red/error styling on the badge.
    const badge = within(row).getByText("Pending");
    expect(badge.className).not.toContain("red");
  });

  it("shows Revoked when disabledAt is set, even if authUserId is null", () => {
    const members = [member({ authUserId: null, disabledAt: "2026-02-01T00:00:00.000Z" })];
    render(<UsersTable members={members} meId="someone-else" />);
    expect(screen.getByTestId("user-row-m1")).toHaveTextContent("Revoked");
  });

  it("offers no role control and no revoke control on the signed-in member's own row", () => {
    const members = [member({ id: "me", disabledAt: null })];
    render(<UsersTable members={members} meId="me" />);
    const row = screen.getByTestId("user-row-me");
    expect(within(row).queryByTestId("role-select-me")).toBeNull();
    expect(within(row).queryByTestId("revoke-user-me")).toBeNull();
    expect(within(row).queryByTestId("restore-user-me")).toBeNull();
    // The role is still visible, just as plain text.
    expect(row).toHaveTextContent("Editor");
  });

  it("still offers the revoke control on someone else's row", () => {
    const members = [member({ id: "other" })];
    render(<UsersTable members={members} meId="me" />);
    expect(screen.getByTestId("revoke-user-other")).toBeInTheDocument();
  });

  it("offers restore, not revoke, on a revoked member's row", () => {
    const members = [member({ id: "other", disabledAt: "2026-02-01T00:00:00.000Z" })];
    render(<UsersTable members={members} meId="me" />);
    expect(screen.getByTestId("restore-user-other")).toBeInTheDocument();
    expect(screen.queryByTestId("revoke-user-other")).toBeNull();
  });

  // React 19 resets a <form action={fn}> to defaultValue when the action settles, whatever it
  // resolved to. This pins the fix for the invite dialog: on a failed invite the dialog stays open
  // AND the typed values are still there.
  it("keeps the typed values in the invite dialog when a duplicate email fails", async () => {
    vi.mocked(inviteMemberAction).mockResolvedValueOnce({
      ok: false,
      error: "Someone with that email has already been invited.",
    });

    render(<UsersTable members={[]} meId="me" />);
    fireEvent.click(screen.getByTestId("table-invite"));
    const dialog = within(screen.getByRole("dialog", { name: "Invite member" }));

    fireEvent.change(dialog.getByLabelText(/email/i), { target: { value: "dupe@example.com" } });
    fireEvent.change(dialog.getByLabelText(/name/i), { target: { value: "Dupe Person" } });
    fireEvent.click(dialog.getByText("Invite"));

    await waitFor(() =>
      expect(dialog.getByTestId("invite-error-message")).toHaveTextContent(
        "Someone with that email has already been invited."
      )
    );
    expect((dialog.getByLabelText(/email/i) as HTMLInputElement).value).toBe("dupe@example.com");
    expect((dialog.getByLabelText(/name/i) as HTMLInputElement).value).toBe("Dupe Person");
    // The dialog must still be open — the failure was not treated as a success.
    expect(screen.getByRole("dialog", { name: "Invite member" })).toBeInTheDocument();
  });

  it("shows a warning returned alongside ok: true as a warning, not a failure", async () => {
    vi.mocked(inviteMemberAction).mockResolvedValueOnce({
      ok: true,
      warning: "Invited, but the email could not be sent. They can still sign in with Google or Microsoft.",
    });

    render(<UsersTable members={[]} meId="me" />);
    fireEvent.click(screen.getByTestId("table-invite"));
    const dialog = within(screen.getByRole("dialog", { name: "Invite member" }));
    fireEvent.change(dialog.getByLabelText(/email/i), { target: { value: "new@example.com" } });
    fireEvent.click(dialog.getByText("Invite"));

    // Succeeded — the dialog closes, unlike the failure case above.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invite member" })).toBeNull());
    const banner = screen.getByTestId("invite-warning-banner");
    expect(banner).toHaveTextContent("Invited, but the email could not be sent");
    expect(screen.queryByTestId("invite-error-message")).toBeNull();
  });

  it("changes a role by submitting the select's new value", async () => {
    const members = [member({ id: "other", role: "viewer" })];
    render(<UsersTable members={members} meId="me" />);
    fireEvent.change(screen.getByTestId("role-select-other"), { target: { value: "admin" } });

    await waitFor(() => expect(setMemberRoleAction).toHaveBeenCalled());
    const sent = vi.mocked(setMemberRoleAction).mock.calls[0][0] as FormData;
    expect(sent.get("id")).toBe("other");
    expect(sent.get("role")).toBe("admin");
  });

  it("revokes through the confirm dialog", async () => {
    const members = [member({ id: "other" })];
    render(<UsersTable members={members} meId="me" />);
    fireEvent.click(screen.getByTestId("revoke-user-other"));
    fireEvent.click(screen.getByTestId("revoke-confirm"));

    await waitFor(() => expect(setMemberActiveAction).toHaveBeenCalled());
    const sent = vi.mocked(setMemberActiveAction).mock.calls[0][0] as FormData;
    expect(sent.get("id")).toBe("other");
    expect(sent.get("active")).toBe("false");
  });

  it("keeps the revoke dialog open and shows the error when revoking fails", async () => {
    vi.mocked(setMemberActiveAction).mockResolvedValueOnce({ ok: false, error: "There has to be at least one active admin." });
    const members = [member({ id: "other" })];
    render(<UsersTable members={members} meId="me" />);
    fireEvent.click(screen.getByTestId("revoke-user-other"));
    fireEvent.click(screen.getByTestId("revoke-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("revoke-error-message")).toHaveTextContent("There has to be at least one active admin.")
    );
    expect(screen.getByTestId("revoke-confirm")).toBeInTheDocument();
  });
});
