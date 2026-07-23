import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, act } from "@testing-library/react";
import { SiteDetail } from "./SiteDetail";
import type { ClientRow, SiteRow, FloorRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import type { SiteRackRow } from "./repository";
import { createFloorAction, deleteFloorAction, renameFloorAction } from "./actions";

let mockSearch = "";
const replaceMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
  usePathname: () => "/clients/ACME/HQ",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

vi.mock("@/features/locations/actions", () => ({
  createRackInSiteAction: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./actions", () => ({
  deleteRackAction: vi.fn(async () => ({ ok: true })),
  createFloorAction: vi.fn(async () => ({ ok: true })),
  renameFloorAction: vi.fn(async () => ({ ok: true })),
  deleteFloorAction: vi.fn(async () => ({ ok: true })),
  createRoomAction: vi.fn(async () => ({ ok: true })),
  renameRoomAction: vi.fn(async () => ({ ok: true })),
  deleteRoomAction: vi.fn(async () => ({ ok: true })),
  createFloorDeviceAction: vi.fn(async () => ({ ok: true })),
  updateFloorDeviceAction: vi.fn(async () => ({ ok: true })),
  deleteFloorDeviceAction: vi.fn(async () => ({ ok: true })),
}));

const client: ClientRow = { id: "c1", code: "ACME", name: "Acme Corp", created_at: "2026-01-01" };
const site: SiteRow = {
  id: "s1",
  client_id: "c1",
  code: "HQ",
  name: "Headquarters",
  address: null,
  latitude: null,
  longitude: null,
  geocode_status: "pending",
  geocoded_at: null,
  created_at: "2026-01-01",
};

// Given order deliberately differs from code-sorted order: digits sort before letters, so a naive
// code-sort would put "1F" ahead of "GF". Floors arrive pre-sorted by sort_order from the
// repository though, and GF has sort_order 0 here, so GF is the correct "first floor" fallback
// even though it is NOT first alphabetically — a component that (wrongly) re-sorted by code would
// pick 1F instead and every "default floor" assertion below would catch it.
const floorGF: FloorRow = { id: "floor-gf", site_id: "s1", code: "GF", name: "Ground Floor", sort_order: 0, created_at: "2026-01-01" };
const floor1F: FloorRow = { id: "floor-1f", site_id: "s1", code: "1F", name: "First Floor", sort_order: 1, created_at: "2026-01-01" };
const floors: FloorRow[] = [floorGF, floor1F];

const rooms: RoomRow[] = [
  { id: "room-mdf", floor_id: "floor-gf", code: "MDF", name: "Ground MDF", type: "MDF", created_at: "2026-01-01", plan_polygon: null },
  { id: "room-idf", floor_id: "floor-1f", code: "IDF", name: "First Floor IDF", type: "IDF", created_at: "2026-01-01", plan_polygon: null },
];

const deviceTypes: DeviceTypeRow[] = [
  { id: "type-cam", name: "Camera", category: "floor", code: "CAM", is_standard: true, created_at: "2026-01-01" },
];

const devices: FloorDeviceRow[] = [
  { id: "dev-cam01", site_id: "s1", floor_id: "floor-gf", room_id: "room-mdf", device_type_id: "type-cam", code: "CAM01", name: "Lobby Cam", status: "planned", created_at: "2026-01-01", updated_at: "2026-01-01", x: null, y: null },
  { id: "dev-ap01", site_id: "s1", floor_id: "floor-gf", room_id: null, device_type_id: "type-cam", code: "AP01", name: "Floor AP", status: "planned", created_at: "2026-01-01", updated_at: "2026-01-01", x: null, y: null },
  { id: "dev-cam02", site_id: "s1", floor_id: "floor-1f", room_id: "room-idf", device_type_id: "type-cam", code: "CAM02", name: "Stair Cam", status: "installed", created_at: "2026-01-01", updated_at: "2026-01-01", x: null, y: null },
];

// Racks span TWO floors: GF has two groups (MDF with 2 racks, IDF with 1 — proving first-seen
// grouping order survives the new floor filtering), 1F has one rack in its own IDF room. RK03 is
// used to prove the other floor's rack never leaks into the active floor's view.
const racks: SiteRackRow[] = [
  { id: "r1", code: "RK01", heightU: 20, floorCode: "GF", roomCode: "MDF", roomType: "MDF", deviceCount: 3 },
  { id: "r2", code: "RK02", heightU: 42, floorCode: "GF", roomCode: "MDF", roomType: "MDF", deviceCount: 0 },
  { id: "r4", code: "RK04", heightU: 10, floorCode: "GF", roomCode: "IDF", roomType: "IDF", deviceCount: 2 },
  { id: "r3", code: "RK03", heightU: 12, floorCode: "1F", roomCode: "IDF", roomType: "IDF", deviceCount: 1 },
];

function renderSite(overrides: Partial<React.ComponentProps<typeof SiteDetail>> = {}) {
  return render(
    <SiteDetail
      client={client}
      site={site}
      racks={racks}
      floors={floors}
      rooms={rooms}
      devices={devices}
      deviceTypes={deviceTypes}
      {...overrides}
    />
  );
}

beforeEach(() => {
  mockSearch = "";
});

describe("SiteDetail", () => {
  it("renders floor tabs and shows the FIRST floor's panel and racks by default", () => {
    renderSite();

    expect(screen.getByTestId("floor-tab-GF")).toBeInTheDocument();
    expect(screen.getByTestId("floor-tab-1F")).toBeInTheDocument();
    expect(screen.getByTestId("floor-tab-GF")).toHaveAttribute("aria-current", "page");

    // GF's room/devices are visible ...
    const mdfSection = screen.getByTestId("room-section-MDF");
    expect(within(mdfSection).getByText("CAM01")).toBeInTheDocument();
    // ... 1F's are not.
    expect(screen.queryByTestId("room-section-IDF")).toBeNull();
    expect(screen.queryByText("CAM02")).toBeNull();

    // Rack groups: both of GF's groups render, preserving first-seen order within the floor ...
    const gfMdf = screen.getByTestId("rack-group-GF-MDF").closest("section")!;
    expect(within(gfMdf).getByText("RK01")).toBeInTheDocument();
    expect(within(gfMdf).getByText("RK02")).toBeInTheDocument();
    expect(screen.getByTestId("rack-group-GF-IDF")).toBeInTheDocument();
    // ... 1F's rack group is entirely absent.
    expect(screen.queryByTestId("rack-group-1F-IDF")).toBeNull();
  });

  it("links each rack to its /racks/<id> permalink, not a nested URL", () => {
    renderSite();
    const link = screen.getByRole("link", { name: /RK01/ });
    expect(link).toHaveAttribute("href", "/racks/r1");
  });

  it("shows a 'No racks yet' state when the active floor has no racks", () => {
    renderSite({ racks: [], rooms: [], devices: [] });
    expect(screen.getByText("No racks yet")).toBeInTheDocument();
  });

  it("?floor=1F selects that floor's panel and racks, hiding GF's", () => {
    mockSearch = "floor=1F";
    renderSite();

    expect(screen.getByTestId("floor-tab-1F")).toHaveAttribute("aria-current", "page");

    const idfSection = screen.getByTestId("room-section-IDF");
    expect(within(idfSection).getByText("CAM02")).toBeInTheDocument();
    expect(screen.queryByTestId("room-section-MDF")).toBeNull();
    expect(screen.queryByText("CAM01")).toBeNull();

    const oneFIdf = screen.getByTestId("rack-group-1F-IDF").closest("section")!;
    expect(within(oneFIdf).getByText("RK03")).toBeInTheDocument();
    expect(screen.queryByTestId("rack-group-GF-MDF")).toBeNull();
    expect(screen.queryByTestId("rack-group-GF-IDF")).toBeNull();
  });

  it("falls back to the first floor when ?floor= doesn't match any floor's code", () => {
    mockSearch = "floor=NOPE";
    renderSite();
    expect(screen.getByTestId("room-section-MDF")).toBeInTheDocument();
    expect(screen.queryByTestId("room-section-IDF")).toBeNull();
  });

  it("clicking a NON-first tab replaces the URL with that floor's code", () => {
    renderSite();
    fireEvent.click(screen.getByTestId("floor-tab-1F"));
    expect(replaceMock).toHaveBeenCalledWith("/clients/ACME/HQ?floor=1F", { scroll: false });
  });

  it("shows the 'No floors yet' empty state with an add-floor button when the site has no floors", () => {
    renderSite({ floors: [], rooms: [], devices: [], racks: [] });
    expect(screen.getByText("No floors yet")).toBeInTheDocument();
    expect(screen.getByTestId("add-floor")).toBeInTheDocument();
    expect(screen.queryByText("No racks yet")).toBeNull();
  });

  it("add-floor modal submits createFloorAction with this site's id and the entered fields", async () => {
    const callsBefore = vi.mocked(createFloorAction).mock.calls.length;
    renderSite();
    fireEvent.click(screen.getByTestId("add-floor"));
    expect(screen.getByRole("dialog", { name: "Add floor" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Code/i), { target: { value: "MEZZ" } });
    fireEvent.change(screen.getByLabelText(/Name/i), { target: { value: "Mezzanine" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });

    expect(createFloorAction).toHaveBeenCalledTimes(callsBefore + 1);
    const formData = vi.mocked(createFloorAction).mock.calls[callsBefore][0] as FormData;
    expect(formData.get("siteId")).toBe("s1");
    expect(formData.get("code")).toBe("MEZZ");
    expect(formData.get("name")).toBe("Mezzanine");
    expect(screen.queryByRole("dialog", { name: "Add floor" })).toBeNull();
  });

  it("floor delete shows client-computed, hand-computable counts and submits deleteFloorAction for GF", async () => {
    const callsBefore = vi.mocked(deleteFloorAction).mock.calls.length;
    renderSite();

    fireEvent.click(screen.getByTestId("delete-floor"));
    // GF: 1 room (MDF), 3 racks (RK01, RK02, RK04), devices = 2 floor-scoped rows (CAM01, AP01)
    // + summed rack deviceCounts (3 + 0 + 2 = 5) = 7.
    expect(screen.getByTestId("delete-cascade")).toHaveTextContent("1 room, 3 racks and 7 devices");

    fireEvent.change(screen.getByTestId("delete-code-input"), { target: { value: "GF" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-confirm"));
    });

    expect(deleteFloorAction).toHaveBeenCalledTimes(callsBefore + 1);
    const formData = vi.mocked(deleteFloorAction).mock.calls[callsBefore][0] as FormData;
    expect(formData.get("id")).toBe("floor-gf");
  });

  it("renaming the active NON-first floor's code updates ?floor= to the new normalised code", async () => {
    mockSearch = "floor=1F";
    replaceMock.mockClear();
    const callsBefore = vi.mocked(renameFloorAction).mock.calls.length;
    renderSite();

    fireEvent.click(screen.getByTestId("rename-floor"));
    expect(screen.getByRole("dialog", { name: "Rename floor" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Code/i), { target: { value: "mezz" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(renameFloorAction).toHaveBeenCalledTimes(callsBefore + 1);
    expect(replaceMock).toHaveBeenCalledWith("/clients/ACME/HQ?floor=MEZZ", { scroll: false });
  });

  it("renaming the active floor's name only, without changing its code, does not call router.replace", async () => {
    mockSearch = "floor=1F";
    replaceMock.mockClear();
    const callsBefore = vi.mocked(renameFloorAction).mock.calls.length;
    renderSite();

    fireEvent.click(screen.getByTestId("rename-floor"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "First Floor Renamed" } });
    // Code left as-is: still "1F".

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });

    expect(renameFloorAction).toHaveBeenCalledTimes(callsBefore + 1);
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
