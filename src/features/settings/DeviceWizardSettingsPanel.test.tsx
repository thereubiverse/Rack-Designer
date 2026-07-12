import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DeviceWizardSettingsPanel } from "./DeviceWizardSettingsPanel";

const okSave = () => vi.fn().mockResolvedValue({ ok: true });

describe("DeviceWizardSettingsPanel", () => {
  it("toggling enabled calls save with the new value", async () => {
    const save = okSave();
    render(<DeviceWizardSettingsPanel initial={{ enabled: false, hasKey: false }} save={save} />);
    fireEvent.click(screen.getByRole("switch", { name: /show the device wizard/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ enabled: true }));
  });

  it("shows a 'key is set' state and a Remove action when a key exists", () => {
    render(<DeviceWizardSettingsPanel initial={{ enabled: true, hasKey: true }} save={okSave()} />);
    expect(screen.getByText(/key is set/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove key/i })).toBeInTheDocument();
  });

  it("saving a typed key calls save with apiKey and flips to the set state", async () => {
    const save = okSave();
    render(<DeviceWizardSettingsPanel initial={{ enabled: true, hasKey: false }} save={save} />);
    fireEvent.change(screen.getByLabelText(/gemini api key/i), { target: { value: "sk-123" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ apiKey: "sk-123" }));
    expect(await screen.findByText(/key is set/i)).toBeInTheDocument();
  });

  it("Remove calls save with an empty apiKey", async () => {
    const save = okSave();
    render(<DeviceWizardSettingsPanel initial={{ enabled: true, hasKey: true }} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: /remove key/i }));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ apiKey: "" }));
  });
});
