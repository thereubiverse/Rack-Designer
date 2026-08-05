import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ProfileForm } from "./ProfileForm";

const updateProfileAction = vi.fn();
const uploadAvatarAction = vi.fn();
const removeAvatarAction = vi.fn();
const changePasswordAction = vi.fn();
const sendPhoneCodeAction = vi.fn();
const confirmPhoneCodeAction = vi.fn();
vi.mock("./actions", () => ({
  updateProfileAction: (...a: unknown[]) => updateProfileAction(...a),
  uploadAvatarAction: (...a: unknown[]) => uploadAvatarAction(...a),
  removeAvatarAction: (...a: unknown[]) => removeAvatarAction(...a),
  changePasswordAction: (...a: unknown[]) => changePasswordAction(...a),
  sendPhoneCodeAction: (...a: unknown[]) => sendPhoneCodeAction(...a),
  confirmPhoneCodeAction: (...a: unknown[]) => confirmPhoneCodeAction(...a),
}));

const revokeMyDeviceAction = vi.fn();
vi.mock("@/features/devices/actions", () => ({
  revokeMyDeviceAction: (...a: unknown[]) => revokeMyDeviceAction(...a),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const PROFILE = {
  id: "m1", email: "me@example.com", name: "Reuben Singh",
  phone: "555-0100", position: "Foreman", address: "12 Main St", avatarPath: null,
  phoneVerifiedAt: null,
};

beforeEach(() => { vi.clearAllMocks(); });

describe("ProfileForm", () => {
  it("shows the member's current details", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe("Reuben Singh");
    expect((screen.getByLabelText(/position/i) as HTMLInputElement).value).toBe("Foreman");
  });

  it("shows the email as read-only, with who to ask", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    const email = screen.getByLabelText(/email/i) as HTMLInputElement;
    expect(email.readOnly).toBe(true);
    expect(document.body.textContent).toMatch(/administrator/i);
  });

  it("hides the password section for a member who signed in with Google or Microsoft", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword={false} />);
    expect(screen.queryByTestId("password-section")).toBeNull();
  });

  it("shows the password section for a member who has a password", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    expect(screen.getByTestId("password-section")).toBeTruthy();
  });

  it("keeps what you typed when saving fails", async () => {
    updateProfileAction.mockResolvedValue({ ok: false, error: "Nope" });
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    const name = screen.getByLabelText(/name/i) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Changed Name" } });
    fireEvent.click(screen.getByTestId("save-details"));
    await waitFor(() => expect(screen.getByText("Nope")).toBeTruthy());
    expect((screen.getByLabelText(/name/i) as HTMLInputElement).value).toBe("Changed Name");
  });

  it("offers Remove only when there is a picture", () => {
    const { rerender } = render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    expect(screen.queryByTestId("remove-avatar")).toBeNull();
    rerender(
      <ProfileForm
        profile={{ ...PROFILE, avatarPath: "m1/avatar" }}
        avatarUrl="https://example.test/a.png"
        hasPassword
      />
    );
    expect(screen.getByTestId("remove-avatar")).toBeTruthy();
  });
});

describe("phone verification", () => {
  it("offers Verify for a number that is not confirmed", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    expect(screen.getByTestId("verify-phone")).toBeTruthy();
    expect(document.body.textContent).toMatch(/not verified/i);
  });

  it("shows neither badge nor button once the number is confirmed", () => {
    render(
      <ProfileForm
        profile={{ ...PROFILE, phoneVerifiedAt: "2026-08-04T12:00:00Z" }}
        avatarUrl={null}
        hasPassword
      />
    );
    expect(screen.queryByTestId("verify-phone")).toBeNull();
    expect(document.body.textContent).toMatch(/verified/i);
  });

  it("offers nothing to verify when there is no number", () => {
    render(<ProfileForm profile={{ ...PROFILE, phone: "" }} avatarUrl={null} hasPassword />);
    expect(screen.queryByTestId("verify-phone")).toBeNull();
  });

  it("asks for the code once one has been sent", async () => {
    sendPhoneCodeAction.mockResolvedValue({ ok: true });
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    fireEvent.click(screen.getByTestId("verify-phone"));
    await waitFor(() => expect(screen.getByTestId("phone-code")).toBeTruthy());
  });

  it("reports it plainly when SMS is not set up, and asks for no code", async () => {
    sendPhoneCodeAction.mockResolvedValue({ ok: false, error: "Text confirmation isn't set up yet. Ask an administrator." });
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword />);
    fireEvent.click(screen.getByTestId("verify-phone"));
    await waitFor(() => expect(screen.getByText(/isn't set up yet/i)).toBeTruthy());
    expect(screen.queryByTestId("phone-code")).toBeNull();
  });
});

describe("Devices", () => {
  const CURRENT = {
    id: "d1", label: "Chrome on Mac", approvedAt: "2026-07-01T00:00:00Z",
    lastSeenAt: "2026-08-01T00:00:00Z", isCurrent: true,
  };
  const OTHER = {
    id: "d2", label: "Firefox on Windows", approvedAt: "2026-06-01T00:00:00Z",
    lastSeenAt: "2026-07-15T00:00:00Z", isCurrent: false,
  };

  it("marks the current device and not any other", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword devices={[CURRENT, OTHER]} />);
    expect(screen.getByTestId("device-row-d1")).toHaveTextContent("this device");
    expect(screen.getByTestId("device-row-d2")).not.toHaveTextContent("this device");
  });

  it("offers a Revoke control on every device, including the current one", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword devices={[CURRENT, OTHER]} />);
    expect(screen.getByTestId("revoke-device-d1")).toBeTruthy();
    expect(screen.getByTestId("revoke-device-d2")).toBeTruthy();
  });

  it("warns plainly that revoking the CURRENT device ends this session", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword devices={[CURRENT]} />);
    fireEvent.click(screen.getByTestId("revoke-device-d1"));
    expect(screen.getByTestId("revoke-device-dialog")).toHaveTextContent(/end your session/i);
  });

  it("gives a different, milder warning for a device that is not the current one", () => {
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword devices={[OTHER]} />);
    fireEvent.click(screen.getByTestId("revoke-device-d2"));
    const dialog = screen.getByTestId("revoke-device-dialog");
    expect(dialog).not.toHaveTextContent(/end your session/i);
    expect(dialog).toHaveTextContent(/no longer be able to access/i);
  });

  it("revokes the device the confirm dialog was opened for", async () => {
    revokeMyDeviceAction.mockResolvedValue({ ok: true });
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword devices={[CURRENT, OTHER]} />);
    fireEvent.click(screen.getByTestId("revoke-device-d2"));
    fireEvent.click(screen.getByTestId("revoke-device-confirm"));
    await waitFor(() => expect(revokeMyDeviceAction).toHaveBeenCalled());
    const sent = revokeMyDeviceAction.mock.calls[0][0] as FormData;
    expect(sent.get("id")).toBe("d2");
  });

  it("keeps the dialog open and shows the error when revoking fails", async () => {
    revokeMyDeviceAction.mockResolvedValue({ ok: false, error: "That device is no longer listed." });
    render(<ProfileForm profile={PROFILE} avatarUrl={null} hasPassword devices={[OTHER]} />);
    fireEvent.click(screen.getByTestId("revoke-device-d2"));
    fireEvent.click(screen.getByTestId("revoke-device-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("revoke-device-error-message")).toHaveTextContent("That device is no longer listed.")
    );
    expect(screen.getByTestId("revoke-device-dialog")).toBeInTheDocument();
  });
});
