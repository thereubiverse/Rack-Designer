import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { VerifyDevice } from "./VerifyDevice";

const startDeviceApprovalAction = vi.fn();
const confirmDeviceAction = vi.fn();
const resendDeviceCodeAction = vi.fn();
vi.mock("./actions", () => ({
  startDeviceApprovalAction: (...a: unknown[]) => startDeviceApprovalAction(...a),
  confirmDeviceAction: (...a: unknown[]) => confirmDeviceAction(...a),
  resendDeviceCodeAction: (...a: unknown[]) => resendDeviceCodeAction(...a),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

beforeEach(() => { vi.clearAllMocks(); });

describe("VerifyDevice", () => {
  // Offering a code input before a code has actually been sent invites someone to type into a
  // field that was never issued anything — worse than the plain "not recognised" message.
  it("shows only Send code up front, no code input", () => {
    render(<VerifyDevice />);
    expect(screen.getByTestId("send-code")).toBeTruthy();
    expect(screen.queryByTestId("verify-device-code")).toBeNull();
    expect(screen.queryByTestId("resend-code")).toBeNull();
  });

  it("reveals the code input and Resend only after a code is actually sent", async () => {
    startDeviceApprovalAction.mockResolvedValue({ ok: true });
    render(<VerifyDevice />);
    fireEvent.click(screen.getByTestId("send-code"));
    await waitFor(() => expect(screen.getByTestId("verify-device-code")).toBeTruthy());
    expect(screen.getByTestId("resend-code")).toBeTruthy();
    expect(screen.queryByTestId("send-code")).toBeNull();
  });

  it("does not reveal the code input when sending fails", async () => {
    startDeviceApprovalAction.mockResolvedValue({ ok: false, error: "Email confirmation isn't set up yet. Ask an administrator." });
    render(<VerifyDevice />);
    fireEvent.click(screen.getByTestId("send-code"));
    await waitFor(() => expect(screen.getByText(/isn't set up yet/i)).toBeTruthy());
    expect(screen.queryByTestId("verify-device-code")).toBeNull();
  });

  it("surfaces the resend cooldown message returned by the server", async () => {
    startDeviceApprovalAction.mockResolvedValue({ ok: true });
    resendDeviceCodeAction.mockResolvedValue({ ok: false, error: "Wait 42 more seconds before asking for another code." });
    render(<VerifyDevice />);
    fireEvent.click(screen.getByTestId("send-code"));
    await waitFor(() => expect(screen.getByTestId("resend-code")).toBeTruthy());

    fireEvent.click(screen.getByTestId("resend-code"));
    await waitFor(() => expect(screen.getByText(/wait 42 more seconds/i)).toBeTruthy());
    // The code input stays up — a cooldown is not a reason to hide what was already sent.
    expect(screen.getByTestId("verify-device-code")).toBeTruthy();
  });

  it("submits the entered code and moves on when it is accepted", async () => {
    startDeviceApprovalAction.mockResolvedValue({ ok: true });
    confirmDeviceAction.mockResolvedValue({ ok: true });
    render(<VerifyDevice />);
    fireEvent.click(screen.getByTestId("send-code"));
    await waitFor(() => expect(screen.getByTestId("verify-device-code")).toBeTruthy());

    fireEvent.change(screen.getByTestId("verify-device-code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => expect(confirmDeviceAction).toHaveBeenCalled());
    const sent = confirmDeviceAction.mock.calls[0][0] as FormData;
    expect(sent.get("code")).toBe("123456");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/"));
  });

  it("shows the error and keeps the input for a wrong code, without redirecting", async () => {
    startDeviceApprovalAction.mockResolvedValue({ ok: true });
    confirmDeviceAction.mockResolvedValue({ ok: false, error: "That code isn't right." });
    render(<VerifyDevice />);
    fireEvent.click(screen.getByTestId("send-code"));
    await waitFor(() => expect(screen.getByTestId("verify-device-code")).toBeTruthy());

    fireEvent.change(screen.getByTestId("verify-device-code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByText("Confirm"));

    await waitFor(() => expect(screen.getByText("That code isn't right.")).toBeTruthy());
    expect(screen.getByTestId("verify-device-code")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });
});
