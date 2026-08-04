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
