import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeviceWizard } from "./DeviceWizard";

const detected = { groups: [{ media: "copper" as const, connector: "RJ45", count: 24, rows: 2, order: "ltr" as const, bbox: { x: 0, y: 0, w: 1, h: 1 } }], confidence: "high" as const };
const okDetect = vi.fn().mockResolvedValue({ ok: true, face: detected });
const okIdentify = vi.fn().mockResolvedValue({ ok: true, match: { name: "Cisco Catalyst 9200", brand: "Cisco", widthIn: 17.5, rackUnits: 1, imageUrl: "http://img/x.png", source: "duckduckgo" }, imageBase64: "AAAA", mimeType: "image/png" });

const base = { widthIn: 17.5, rackUnits: 1, onApply: vi.fn() };

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

  it("search → detect → Apply calls onApply with a laid-out face", async () => {
    const onApply = vi.fn();
    render(<DeviceWizard {...base} onApply={onApply} runDetect={okDetect} runIdentify={okIdentify} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    fireEvent.change(screen.getByPlaceholderText(/model/i), { target: { value: "C9200-24T" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    // candidate → confirm
    await screen.findByRole("button", { name: /confirm/i });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    // review → apply
    await screen.findByRole("button", { name: /apply/i });
    fireEvent.click(screen.getByRole("button", { name: /apply/i }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const arg = onApply.mock.calls[0][0];
    expect(arg.face.portGroups).toHaveLength(1);
    expect(arg.match.brand).toBe("Cisco");
  });

  it("shows an error when detection fails", async () => {
    const failDetect = vi.fn().mockResolvedValue({ ok: false, error: "Couldn't read a device from this image." });
    render(<DeviceWizard {...base} onApply={vi.fn()} runDetect={failDetect} runIdentify={okIdentify} />);
    fireEvent.click(screen.getByRole("button", { name: "Device Wizard" }));
    fireEvent.change(screen.getByPlaceholderText(/model/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /search/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm/i }));
    expect(await screen.findByText(/couldn't read a device/i)).toBeInTheDocument();
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
    resolveIdentify!({ ok: true, match: { name: "X", brand: "Cisco", widthIn: 17.5, rackUnits: 1, imageUrl: "", source: "duckduckgo" }, imageBase64: "AAAA", mimeType: "image/png" });
    await screen.findByRole("button", { name: /confirm/i });
  });
});
