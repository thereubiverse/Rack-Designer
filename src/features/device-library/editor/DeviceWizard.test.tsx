import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeviceWizard } from "./DeviceWizard";

const detected = { groups: [{ media: "copper" as const, connector: "RJ45", count: 24, rows: 2, order: "ltr" as const, bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "high" as const };
const okDetect = vi.fn().mockResolvedValue({ ok: true, face: detected });

const base = { widthIn: 17.5, rackUnits: 1, onApply: vi.fn(), enabled: true, hasKey: true };

describe("DeviceWizard", () => {
  it("renders nothing when the feature is disabled", () => {
    const { container } = render(<DeviceWizard {...base} enabled={false} runDetect={okDetect} />);
    expect(container.querySelector('button[aria-label="Device Wizard"]')).toBeNull();
  });

  it("shows an icon-only button with a tooltip", () => {
    render(<DeviceWizard {...base} runDetect={okDetect} />);
    const btn = screen.getByRole("button", { name: "Device Wizard" });
    expect(btn.textContent).toBe(""); // icon only
    expect(btn).toHaveAttribute("title", "Device Wizard");
  });

  it("clicking the icon turns it into an Upload control", () => {
    render(<DeviceWizard {...base} runDetect={okDetect} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    expect(screen.getByRole("button", { name: "Upload a photo" })).toBeInTheDocument();
  });

  it("clicking the icon with no key shows a Settings prompt (not upload)", () => {
    render(<DeviceWizard {...base} hasKey={false} runDetect={okDetect} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    expect(screen.queryByRole("button", { name: "Upload a photo" })).toBeNull();
    const link = screen.getByRole("link", { name: /settings/i });
    expect(link).toHaveAttribute("href", "/settings");
  });

  it("upload → review → Apply calls onApply with the detected face", async () => {
    const onApply = vi.fn();
    const { container } = render(<DeviceWizard {...base} onApply={onApply} runDetect={okDetect} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "sw.png", { type: "image/png" })] } });
    fireEvent.click(await screen.findByRole("button", { name: /apply/i }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const arg = onApply.mock.calls[0][0];
    expect(arg.detected.groups).toHaveLength(1);
    expect(arg.match).toBeUndefined();
  });

  it("shows an error when detection fails", async () => {
    const failDetect = vi.fn().mockResolvedValue({ ok: false, error: "The vision model is busy right now — please try again in a moment." });
    const { container } = render(<DeviceWizard {...base} onApply={vi.fn()} runDetect={failDetect} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "sw.png", { type: "image/png" })] } });
    expect(await screen.findByText(/vision model is busy/i)).toBeInTheDocument();
  });
});
