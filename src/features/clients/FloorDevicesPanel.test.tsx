import { describe, it, expect, vi } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { FloorDevicesPanel } from "./FloorDevicesPanel";
import type { FloorRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import {
  createRoomAction,
  renameRoomAction,
  deleteRoomAction,
  createFloorDeviceAction,
  updateFloorDeviceAction,
  deleteFloorDeviceAction,
} from "./actions";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));
vi.mock("./actions", () => ({
  createRoomAction: vi.fn(async () => ({ ok: true })),
  renameRoomAction: vi.fn(async () => ({ ok: true })),
  deleteRoomAction: vi.fn(async () => ({ ok: true })),
  createFloorDeviceAction: vi.fn(async () => ({ ok: true })),
  updateFloorDeviceAction: vi.fn(async () => ({ ok: true })),
  deleteFloorDeviceAction: vi.fn(async () => ({ ok: true })),
}));

const floor: FloorRow = {
  id: "floor-1",
  site_id: "site-1",
  code: "GF",
  name: "Ground Floor",
  sort_order: 0,
  created_at: "2026-01-01",
};

// Given order deliberately differs from sorted-by-code order ("2F" < "CLOSET" < "GF" since digits
// sort before letters in JS) so a component that happened to render rooms in given-array order
// would still have to prove it groups devices under the RIGHT card, not just render in order.
const rooms: RoomRow[] = [
  { id: "room-gf", floor_id: "floor-1", code: "GF", name: "Ground MDF", type: "MDF", created_at: "2026-01-01" },
  { id: "room-2f", floor_id: "floor-1", code: "2F", name: "Second Floor IDF", type: "IDF", created_at: "2026-01-01" },
  { id: "room-closet", floor_id: "floor-1", code: "CLOSET", name: "Storage Closet", type: "other", created_at: "2026-01-01" },
];

const deviceTypes: DeviceTypeRow[] = [
  { id: "type-cam", name: "Camera", category: "floor", code: "CAM", is_standard: true, created_at: "2026-01-01" },
  { id: "type-ap", name: "Access Point", category: "floor", code: "AP", is_standard: true, created_at: "2026-01-01" },
];

// GF gets two devices (for the plural note test); 2F and CLOSET each test a different edge:
// CLOSET has zero devices (note must be absent there); the roomless device lands on the floor
// level bucket.
const devices: FloorDeviceRow[] = [
  { id: "dev-cam01", site_id: "site-1", floor_id: "floor-1", room_id: "room-gf", device_type_id: "type-cam", code: "CAM01", name: "Lobby Cam", status: "planned", created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "dev-cam06", site_id: "site-1", floor_id: "floor-1", room_id: "room-gf", device_type_id: "type-cam", code: "CAM06", name: "Server Room Cam", status: "planned", created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "dev-cam02", site_id: "site-1", floor_id: "floor-1", room_id: "room-2f", device_type_id: "type-cam", code: "CAM02", name: "Stair Cam", status: "installed", created_at: "2026-01-01", updated_at: "2026-01-01" },
  { id: "dev-ap01", site_id: "site-1", floor_id: "floor-1", room_id: null, device_type_id: "type-ap", code: "AP01", name: "Hallway AP", status: "planned", created_at: "2026-01-01", updated_at: "2026-01-01" },
];

// Site-wide codes: includes CAM05 from a DIFFERENT floor of the same site — not present in the
// `devices` prop above at all — to prove suggestion is genuinely site-scoped, not derived from
// the floor's own device list. Gaps for CAM: 1,2,5,6 taken -> next is CAM03. Gaps for AP: 1 taken
// -> next is AP02.
const allSiteDeviceCodes = ["CAM01", "CAM02", "CAM06", "AP01", "CAM05"];

const rackCountByRoomId: Record<string, number> = {
  "room-gf": 2,
  "room-2f": 0,
  "room-closet": 1,
};

function renderPanel(overrides: Partial<React.ComponentProps<typeof FloorDevicesPanel>> = {}) {
  return render(
    <FloorDevicesPanel
      floor={floor}
      rooms={rooms}
      devices={devices}
      deviceTypes={deviceTypes}
      allSiteDeviceCodes={allSiteDeviceCodes}
      rackCountByRoomId={rackCountByRoomId}
      {...overrides}
    />
  );
}

describe("FloorDevicesPanel", () => {
  it("groups devices under the right room card, never bleeding into a neighbour's section", () => {
    renderPanel();
    const gfSection = screen.getByTestId("room-section-GF");
    const section2f = screen.getByTestId("room-section-2F");
    const closetSection = screen.getByTestId("room-section-CLOSET");

    expect(within(gfSection).getByText("CAM01")).toBeInTheDocument();
    expect(within(gfSection).getByText("CAM06")).toBeInTheDocument();
    expect(within(gfSection).queryByText("CAM02")).toBeNull();
    expect(within(gfSection).queryByText("AP01")).toBeNull();

    expect(within(section2f).getByText("CAM02")).toBeInTheDocument();
    expect(within(section2f).queryByText("CAM01")).toBeNull();

    expect(within(closetSection).queryByText("CAM01")).toBeNull();
    expect(within(closetSection).queryByText("CAM02")).toBeNull();
  });

  it("shows the room header code, name, and (for MDF/IDF) a blue type chip", () => {
    renderPanel();
    const gfSection = screen.getByTestId("room-section-GF");
    expect(within(gfSection).getByText("Ground MDF")).toBeInTheDocument();
    const chip = screen.getByTestId("room-type-GF");
    expect(chip).toHaveTextContent("MDF");
    expect(chip.className).toContain("bg-blue-50");
    expect(chip.className).toContain("text-blue-700");

    const idfChip = screen.getByTestId("room-type-2F");
    expect(idfChip).toHaveTextContent("IDF");
    expect(idfChip.className).toContain("bg-blue-50");
    expect(idfChip.className).toContain("text-blue-700");
  });

  it("renders no type chip for an 'other' room", () => {
    renderPanel();
    expect(screen.queryByTestId("room-type-CLOSET")).toBeNull();
  });

  it("shows rename/delete controls for every room, keyed by code", () => {
    renderPanel();
    expect(screen.getByTestId("room-rename-GF")).toBeInTheDocument();
    expect(screen.getByTestId("room-delete-GF")).toBeInTheDocument();
    expect(screen.getByTestId("room-rename-2F")).toBeInTheDocument();
    expect(screen.getByTestId("room-delete-2F")).toBeInTheDocument();
  });

  it("renders a Floor level card when roomless devices exist, listing AP01", () => {
    renderPanel();
    const floorLevel = screen.getByTestId("floor-level-section");
    expect(within(floorLevel).getByText("AP01")).toBeInTheDocument();
    expect(within(floorLevel).getByText("Floor level")).toBeInTheDocument();
  });

  it("renders NO Floor level card when there are no roomless devices (paired absence case)", () => {
    const noRoomless = devices.filter((d) => d.room_id !== null);
    renderPanel({ devices: noRoomless });
    expect(screen.queryByTestId("floor-level-section")).toBeNull();
  });

  it("renders the correct status chip classes for planned and installed devices", () => {
    renderPanel();
    const planned = screen.getByTestId("device-status-CAM01");
    expect(planned).toHaveTextContent("planned");
    expect(planned.className).toContain("bg-neutral-100");
    expect(planned.className).toContain("text-neutral-600");

    const installed = screen.getByTestId("device-status-CAM02");
    expect(installed).toHaveTextContent("installed");
    expect(installed.className).toContain("bg-green-50");
    expect(installed.className).toContain("text-green-700");
  });

  it("shows the device's type name (looked up from deviceTypes) and its own name", () => {
    renderPanel();
    const gfSection = screen.getByTestId("room-section-GF");
    const row = within(gfSection).getByText("CAM01").closest("tr")!;
    expect(within(row).getByText("Camera")).toBeInTheDocument();
    expect(within(row).getByText("Lobby Cam")).toBeInTheDocument();
  });

  describe("add-device modal", () => {
    it("pre-fills the code from suggestDeviceCode for the first device type", () => {
      renderPanel();
      fireEvent.click(screen.getByTestId("add-device"));
      const codeInput = screen.getByLabelText(/Code/i) as HTMLInputElement;
      expect(codeInput.value).toBe("CAM03");
    });

    it("re-suggests the code when the type changes, as long as the user hasn't touched it", () => {
      renderPanel();
      fireEvent.click(screen.getByTestId("add-device"));
      const typeSelect = screen.getByLabelText(/Type/i) as HTMLSelectElement;
      fireEvent.change(typeSelect, { target: { value: "type-ap" } });
      const codeInput = screen.getByLabelText(/Code/i) as HTMLInputElement;
      expect(codeInput.value).toBe("AP02");
    });

    it("never overwrites a code the user has already edited when the type changes", () => {
      renderPanel();
      fireEvent.click(screen.getByTestId("add-device"));
      const codeInput = screen.getByLabelText(/Code/i) as HTMLInputElement;
      fireEvent.change(codeInput, { target: { value: "ZZZ99" } });
      expect(codeInput.value).toBe("ZZZ99");

      const typeSelect = screen.getByLabelText(/Type/i) as HTMLSelectElement;
      fireEvent.change(typeSelect, { target: { value: "type-ap" } });
      expect(codeInput.value).toBe("ZZZ99");
    });

    it("submits createFloorDeviceAction with this floor's id and a NON-first chosen room", async () => {
      const callsBefore = vi.mocked(createFloorDeviceAction).mock.calls.length;
      renderPanel();
      fireEvent.click(screen.getByTestId("add-device"));

      fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "New Camera" } });
      // Rooms render in given-array order [GF, 2F, CLOSET]; CLOSET is the NON-first room option.
      fireEvent.change(screen.getByLabelText(/Room/i), { target: { value: "room-closet" } });
      fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: "installed" } });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });

      expect(createFloorDeviceAction).toHaveBeenCalledTimes(callsBefore + 1);
      const formData = vi.mocked(createFloorDeviceAction).mock.calls[callsBefore][0] as FormData;
      expect(formData.get("floorId")).toBe("floor-1");
      expect(formData.get("roomId")).toBe("room-closet");
      expect(formData.get("deviceTypeId")).toBe("type-cam");
      expect(formData.get("code")).toBe("CAM03");
      expect(formData.get("name")).toBe("New Camera");
      expect(formData.get("status")).toBe("installed");

      expect(refreshMock).toHaveBeenCalled();
      expect(screen.queryByRole("dialog", { name: "Add device" })).toBeNull();
    });

    it("renders the error inline and keeps the modal open when the action fails", async () => {
      vi.mocked(createFloorDeviceAction).mockResolvedValueOnce({ ok: false, error: "Boom" });
      // refreshMock is a module-level mock shared (and never reset) across this file's tests, per
      // this codebase's established idiom (see UnlocatedSites.test.tsx) — so we compare against a
      // baseline rather than asserting it was never called at all.
      const refreshCallsBefore = refreshMock.mock.calls.length;
      renderPanel();
      fireEvent.click(screen.getByTestId("add-device"));

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });

      expect(screen.getByText("Boom")).toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Add device" })).toBeInTheDocument();
      expect(refreshMock).toHaveBeenCalledTimes(refreshCallsBefore);
    });
  });

  describe("edit device modal", () => {
    it("pre-fills every field from the clicked device and submits updateFloorDeviceAction with its id", async () => {
      const callsBefore = vi.mocked(updateFloorDeviceAction).mock.calls.length;
      renderPanel();
      // CAM02 is a non-first device overall (CAM01/CAM06 render before it).
      fireEvent.click(screen.getByTestId("device-edit-CAM02"));

      expect(screen.getByRole("dialog", { name: "Edit device" })).toBeInTheDocument();
      expect((screen.getByLabelText(/Code/i) as HTMLInputElement).value).toBe("CAM02");
      expect((screen.getByLabelText(/Name/i) as HTMLInputElement).value).toBe("Stair Cam");
      expect((screen.getByLabelText(/Room/i) as HTMLSelectElement).value).toBe("room-2f");
      expect((screen.getByLabelText(/Status/i) as HTMLSelectElement).value).toBe("installed");
      expect((screen.getByLabelText(/Type/i) as HTMLSelectElement).value).toBe("type-cam");

      fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "Stairwell Camera" } });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
      });

      expect(updateFloorDeviceAction).toHaveBeenCalledTimes(callsBefore + 1);
      const formData = vi.mocked(updateFloorDeviceAction).mock.calls[callsBefore][0] as FormData;
      expect(formData.get("id")).toBe("dev-cam02");
      expect(formData.get("floorId")).toBe("floor-1");
      expect(formData.get("name")).toBe("Stairwell Camera");
      expect(formData.get("code")).toBe("CAM02");

      expect(refreshMock).toHaveBeenCalled();
    });
  });

  describe("device delete", () => {
    it("fires deleteFloorDeviceAction with the id of a NON-first device row", async () => {
      const callsBefore = vi.mocked(deleteFloorDeviceAction).mock.calls.length;
      renderPanel();

      // CAM06 is the second device in the GF room, not the first.
      await act(async () => {
        fireEvent.click(screen.getByTestId("device-delete-CAM06"));
      });

      expect(deleteFloorDeviceAction).toHaveBeenCalledTimes(callsBefore + 1);
      const formData = vi.mocked(deleteFloorDeviceAction).mock.calls[callsBefore][0] as FormData;
      expect(formData.get("id")).toBe("dev-cam06");
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  describe("room delete", () => {
    it("shows a plural note and NEVER includes devices in counts, when the room has devices", () => {
      renderPanel();
      fireEvent.click(screen.getByTestId("room-delete-GF"));
      expect(screen.getByTestId("delete-note")).toHaveTextContent("2 devices will move to floor level");
      // counts only ever carries racks — the cascade sentence must not mention devices at all.
      expect(screen.getByTestId("delete-cascade")).toHaveTextContent("2 racks");
      expect(screen.getByTestId("delete-cascade")).not.toHaveTextContent("device");
    });

    it("omits the note entirely for a room with zero devices (paired absence case)", () => {
      renderPanel();
      fireEvent.click(screen.getByTestId("room-delete-CLOSET"));
      expect(screen.queryByTestId("delete-note")).toBeNull();
      expect(screen.getByTestId("delete-cascade")).toHaveTextContent("1 rack");
    });

    it("uses the singular form for exactly one moved device", () => {
      renderPanel();
      fireEvent.click(screen.getByTestId("room-delete-2F"));
      expect(screen.getByTestId("delete-note")).toHaveTextContent("1 device will move to floor level");
      expect(screen.getByTestId("delete-note")).not.toHaveTextContent("1 devices");
    });

    it("confirms deleteRoomAction with the id of a NON-first room (2F) once confirmed", async () => {
      const callsBefore = vi.mocked(deleteRoomAction).mock.calls.length;
      renderPanel();
      // 2F has zero racks, so the typed-confirm gate never engages and Delete is enabled directly.
      fireEvent.click(screen.getByTestId("room-delete-2F"));
      await act(async () => {
        fireEvent.click(screen.getByTestId("delete-confirm"));
      });

      expect(deleteRoomAction).toHaveBeenCalledTimes(callsBefore + 1);
      const formData = vi.mocked(deleteRoomAction).mock.calls[callsBefore][0] as FormData;
      expect(formData.get("id")).toBe("room-2f");
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  describe("add-room modal", () => {
    it("opens on click, and submits createRoomAction with this floor's id and chosen fields", async () => {
      const callsBefore = vi.mocked(createRoomAction).mock.calls.length;
      renderPanel();
      fireEvent.click(screen.getByTestId("add-room"));
      expect(screen.getByRole("dialog", { name: "Add room" })).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/Code/i), { target: { value: "MEZZ" } });
      fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "Mezzanine" } });
      fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: "IDF" } });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create" }));
      });

      expect(createRoomAction).toHaveBeenCalledTimes(callsBefore + 1);
      const formData = vi.mocked(createRoomAction).mock.calls[callsBefore][0] as FormData;
      expect(formData.get("floorId")).toBe("floor-1");
      expect(formData.get("code")).toBe("MEZZ");
      expect(formData.get("name")).toBe("Mezzanine");
      expect(formData.get("type")).toBe("IDF");
      expect(refreshMock).toHaveBeenCalled();
    });
  });

  describe("rename-room modal", () => {
    it("pre-fills from the clicked room and submits renameRoomAction with its id", async () => {
      const callsBefore = vi.mocked(renameRoomAction).mock.calls.length;
      renderPanel();
      // 2F is a non-first room.
      fireEvent.click(screen.getByTestId("room-rename-2F"));
      // Scoped to the dialog: the dialog's own aria-label "Rename room" would otherwise be a false
      // match for a loose /Name/i query against the whole document.
      const dialog = within(screen.getByRole("dialog", { name: "Rename room" }));
      expect((dialog.getByLabelText(/Code/i) as HTMLInputElement).value).toBe("2F");
      expect((dialog.getByLabelText(/Name/i) as HTMLInputElement).value).toBe("Second Floor IDF");
      expect((dialog.getByLabelText(/Type/i) as HTMLSelectElement).value).toBe("IDF");

      fireEvent.change(dialog.getByLabelText(/Name/i), { target: { value: "Upper IDF" } });

      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
      });

      expect(renameRoomAction).toHaveBeenCalledTimes(callsBefore + 1);
      const formData = vi.mocked(renameRoomAction).mock.calls[callsBefore][0] as FormData;
      expect(formData.get("id")).toBe("room-2f");
      expect(formData.get("name")).toBe("Upper IDF");
      expect(refreshMock).toHaveBeenCalled();
    });
  });
});
