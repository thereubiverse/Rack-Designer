import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeviceWizard } from "./DeviceWizard";

const detected = { groups: [{ media: "copper" as const, connector: "RJ45", count: 24, rows: 2, order: "ltr" as const, bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "high" as const };
const okDetect = vi.fn().mockResolvedValue({ ok: true, face: detected });
const okIdentify = vi.fn().mockResolvedValue({ ok: true, face: detected });

const base = { widthIn: 17.5, rackUnits: 1, onApply: vi.fn(), enabled: true, hasKey: true };

describe("DeviceWizard", () => {
  it("has an icon button with a tooltip and no text label", () => {
    render(<DeviceWizard {...base} runDetect={okDetect} runIdentify={okIdentify} />);
    const btn = screen.getByRole("button", { name: "Device Wizard" });
    expect(btn.textContent).toBe(""); // icon only
  });

  it("reveals the search + upload controls when the icon is clicked", () => {
    render(<DeviceWizard {...base} runDetect={okDetect} runIdentify={okIdentify} />);
    expect(screen.queryByPlaceholderText(/model/i)).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    expect(screen.getByPlaceholderText(/model/i)).toBeVisible();
    expect(screen.getByTestId("wizard-upload")).toBeInTheDocument();
  });

  it("search → review → Apply calls onApply with the detected face", async () => {
    const onApply = vi.fn();
    render(<DeviceWizard {...base} onApply={onApply} runDetect={okDetect} runIdentify={okIdentify} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    fireEvent.change(screen.getByPlaceholderText(/model/i), { target: { value: "C9200-24T" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    // straight to review — no image candidate step
    await screen.findByRole("button", { name: /apply/i });
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const arg = onApply.mock.calls[0][0];
    expect(arg.detected.groups).toHaveLength(1);
    expect(arg.match).toBeUndefined();
  });

  it("shows an error when the lookup fails", async () => {
    const failIdentify = vi.fn().mockResolvedValue({ ok: false, error: "Couldn't identify this model — try a different name or upload a photo." });
    render(<DeviceWizard {...base} onApply={vi.fn()} runDetect={okDetect} runIdentify={failIdentify} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    fireEvent.change(screen.getByPlaceholderText(/model/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    expect(await screen.findByText(/couldn't identify this model/i)).toBeInTheDocument();
  });

  it("disables search + upload while a request is in flight", async () => {
    let resolveIdentify: (v: unknown) => void;
    const slowIdentify = vi.fn().mockReturnValue(new Promise((r) => { resolveIdentify = r; }));
    render(<DeviceWizard {...base} runDetect={okDetect} runIdentify={slowIdentify} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    fireEvent.change(screen.getByPlaceholderText(/model/i), { target: { value: "C9200-24T" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    // now in "detecting" — controls disabled
    expect(screen.getByRole("button", { name: /search/i })).toBeDisabled();
    expect(screen.getByTestId("wizard-upload")).toBeDisabled();
    // resolve so the test doesn't leak a pending promise
    resolveIdentify!({ ok: true, face: detected });
    await screen.findByRole("button", { name: /apply/i });
  });

  it("renders nothing when the feature is disabled", () => {
    const { container } = render(<DeviceWizard {...base} enabled={false} hasKey={true} runDetect={okDetect} runIdentify={okIdentify} />);
    expect(container.querySelector('button[aria-label="Device Wizard"]')).toBeNull();
  });

  it("shows a Settings prompt (not search/upload) when enabled without a key", () => {
    render(<DeviceWizard {...base} enabled={true} hasKey={false} runDetect={okDetect} runIdentify={okIdentify} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    expect(screen.queryByPlaceholderText(/model/i)).toBeNull();
    const link = screen.getByRole("link", { name: /settings/i });
    expect(link).toHaveAttribute("href", "/settings");
  });
});
