import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProposalPanel } from "./ProposalPanel";
import type { DeviceProposal, RoomProposal } from "./planDetect";
import type { DeviceTypeRow } from "@/features/device-library/repository";

const DEVICE_TYPES: DeviceTypeRow[] = [
  { id: "type-cam", name: "Camera", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "CAM", is_standard: true, color: null, icon: null },
  { id: "type-ap", name: "Access point", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "AP", is_standard: true, color: null, icon: null },
  { id: "type-to", name: "Telephone", created_at: "2026-01-01T00:00:00Z", category: "floor", code: "TO", is_standard: true, color: null, icon: null },
];

const ROOM_A: RoomProposal = {
  id: "room-0",
  name: "Comms closet",
  roomType: "other",
  polygon: [
    [0.1, 0.1],
    [0.3, 0.1],
    [0.3, 0.3],
  ],
  confidence: "high",
};
// A NON-first room proposal, so a test that acts on it can't pass by picking "the first row".
const ROOM_B: RoomProposal = {
  id: "room-1",
  name: "Server room",
  roomType: "IDF",
  polygon: [
    [0.5, 0.5],
    [0.7, 0.5],
    [0.7, 0.7],
  ],
  confidence: "low",
};

const DEVICE_A: DeviceProposal = {
  id: "dev-0",
  label: "CAM01",
  typeCode: "CAM",
  point: [0.4, 0.4],
  confidence: "medium",
};
// A NON-first device proposal, for the same reason.
const DEVICE_B: DeviceProposal = {
  id: "dev-1",
  label: "AP02",
  typeCode: "AP",
  point: [0.6, 0.2],
  confidence: "low",
};

function handlers() {
  return {
    onEditDevice: vi.fn(),
    onEditRoom: vi.fn(),
    onToggleRoomOutline: vi.fn(),
    onAcceptDevice: vi.fn(),
    onAcceptRoom: vi.fn(),
    onDismissDevice: vi.fn(),
    onDismissRoom: vi.fn(),
    onAcceptAll: vi.fn(),
    onDismissAll: vi.fn(),
  };
}

function renderPanel(
  over: Partial<React.ComponentProps<typeof ProposalPanel>> = {}
): ReturnType<typeof handlers> {
  const h = handlers();
  render(
    <ProposalPanel
      rooms={[ROOM_A, ROOM_B]}
      devices={[DEVICE_A, DEVICE_B]}
      deviceTypes={DEVICE_TYPES}
      editingRoomId={null}
      {...h}
      {...over}
    />
  );
  return h;
}

describe("ProposalPanel", () => {
  it("renders nothing at all when there are no proposals", () => {
    renderPanel({ rooms: [], devices: [] });
    expect(screen.queryByTestId("proposal-panel")).toBeNull();
  });

  it("renders one row per proposal, room and device alike", () => {
    renderPanel();
    expect(screen.getByTestId("proposal-panel")).toBeInTheDocument();
    for (const id of ["room-0", "room-1", "dev-0", "dev-1"]) {
      expect(screen.getByTestId(`proposal-item-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`accept-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`dismiss-${id}`)).toBeInTheDocument();
    }
  });

  it("binds the device row's label input and type select to the proposal", () => {
    renderPanel();
    expect((screen.getByTestId("proposal-label-dev-1") as HTMLInputElement).value).toBe("AP02");
    const select = screen.getByTestId("proposal-type-dev-1") as HTMLSelectElement;
    expect(select.value).toBe("AP");
    // Every floor-category type the canvas handed down is offered.
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["CAM", "AP", "TO"]);
  });

  it("reports a label edit on the NON-first device row as a patch", () => {
    const h = renderPanel();
    fireEvent.change(screen.getByTestId("proposal-label-dev-1"), { target: { value: "AP07" } });
    expect(h.onEditDevice).toHaveBeenCalledWith("dev-1", { label: "AP07" });
  });

  it("reports a device type change as a typeCode patch", () => {
    const h = renderPanel();
    fireEvent.change(screen.getByTestId("proposal-type-dev-1"), { target: { value: "TO" } });
    expect(h.onEditDevice).toHaveBeenCalledWith("dev-1", { typeCode: "TO" });
  });

  it("binds the room row's name input and type select, and reports their edits", () => {
    const h = renderPanel();
    expect((screen.getByTestId("proposal-name-room-1") as HTMLInputElement).value).toBe("Server room");
    const select = screen.getByTestId("proposal-roomtype-room-1") as HTMLSelectElement;
    expect(select.value).toBe("IDF");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["MDF", "IDF", "other"]);

    fireEvent.change(screen.getByTestId("proposal-name-room-1"), { target: { value: "Hub" } });
    expect(h.onEditRoom).toHaveBeenCalledWith("room-1", { name: "Hub" });
    fireEvent.change(select, { target: { value: "MDF" } });
    expect(h.onEditRoom).toHaveBeenCalledWith("room-1", { roomType: "MDF" });
  });

  it("hands Accept the WHOLE proposal (the canvas needs its geometry) and Dismiss just the id", () => {
    const h = renderPanel();
    fireEvent.click(screen.getByTestId("accept-dev-1"));
    expect(h.onAcceptDevice).toHaveBeenCalledWith(DEVICE_B);
    fireEvent.click(screen.getByTestId("dismiss-dev-1"));
    expect(h.onDismissDevice).toHaveBeenCalledWith("dev-1");

    fireEvent.click(screen.getByTestId("accept-room-1"));
    expect(h.onAcceptRoom).toHaveBeenCalledWith(ROOM_B);
    fireEvent.click(screen.getByTestId("dismiss-room-1"));
    expect(h.onDismissRoom).toHaveBeenCalledWith("room-1");
  });

  it("wires the bulk header buttons", () => {
    const h = renderPanel();
    fireEvent.click(screen.getByTestId("accept-all"));
    expect(h.onAcceptAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("dismiss-all"));
    expect(h.onDismissAll).toHaveBeenCalledTimes(1);
  });

  it("toggles outline editing for the room the canvas is told about", () => {
    const h = renderPanel({ editingRoomId: "room-1" });
    expect(screen.getByTestId("proposal-outline-room-1")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("proposal-outline-room-0")).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByTestId("proposal-outline-room-0"));
    expect(h.onToggleRoomOutline).toHaveBeenCalledWith("room-0");
  });

  it("disables every commit control while an accept is in flight", () => {
    renderPanel({ busy: true });
    expect(screen.getByTestId("accept-dev-1")).toBeDisabled();
    expect(screen.getByTestId("dismiss-dev-1")).toBeDisabled();
    expect(screen.getByTestId("accept-room-1")).toBeDisabled();
    expect(screen.getByTestId("accept-all")).toBeDisabled();
    expect(screen.getByTestId("dismiss-all")).toBeDisabled();
  });

  it("shows each proposal's confidence", () => {
    renderPanel();
    expect(screen.getByTestId("proposal-confidence-room-0")).toHaveAttribute("title", "Confidence: high");
    expect(screen.getByTestId("proposal-confidence-dev-1")).toHaveAttribute("title", "Confidence: low");
  });

  it("still says what the colour means once the dot becomes the reveal control", () => {
    renderPanel({ onFocusDevice: vi.fn() });
    expect(screen.getByTestId("proposal-confidence-dev-1")).toHaveAttribute(
      "title",
      "Show on plan (confidence: low)"
    );
  });

  it("asks to reveal a device on the plan when its dot is clicked", () => {
    const onFocusDevice = vi.fn();
    renderPanel({ onFocusDevice });
    fireEvent.click(screen.getByTestId("proposal-confidence-dev-1"));
    expect(onFocusDevice).toHaveBeenCalledTimes(1);
    // The PROPOSAL, not its id — the caller needs its point to centre on.
    expect(onFocusDevice.mock.calls[0][0]).toMatchObject({ id: "dev-1" });
  });

  it("keeps the dot inert when no focus handler is given", () => {
    renderPanel();
    const dot = screen.getByTestId("proposal-confidence-dev-1");
    expect(dot.tagName).toBe("SPAN");
  });

  it("reaches the reveal control from the keyboard, like every other row control", () => {
    const onFocusDevice = vi.fn();
    renderPanel({ onFocusDevice });
    const dot = screen.getByTestId("proposal-confidence-dev-1");
    expect(dot.tagName).toBe("BUTTON");
    expect(dot).toHaveAttribute("aria-label", "Show on plan");
  });
});
