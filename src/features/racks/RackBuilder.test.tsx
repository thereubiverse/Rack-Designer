import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { RackBuilder } from "./RackBuilder";
import type { RackRow, RackDeviceRow } from "./repository";
import type { DeviceTypeRow, PickerTemplate } from "@/features/device-library/repository";
import type { Connection } from "./connectionOps";
import type { PortEndpoint } from "./endpointOps";
import type { PortGroup, Face } from "@/domain/faceplate";
import { emptyFace } from "@/domain/faceplate";
import type { SiteScope } from "./siteScope";

// Pure UI-wiring tests: the rack builder must never touch the network/DB. Saves are debounced
// 600ms and mocked out here so a stray timer firing mid-test can't hit a real server action.
vi.mock("./actions", () => ({
  saveRackLayoutAction: vi.fn(),
  saveConnectionsAction: vi.fn(),
  saveEndpointsAction: vi.fn(),
  updateRackAction: vi.fn(),
}));

const g = (id: string): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols: 4, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const face = (gid: string): Face => ({ portGroups: [g(gid)], elements: [] });

const typeId = "type-sw";
const templateId = "tpl-sw";

const deviceType: DeviceTypeRow = {
  id: typeId, organization_id: "org", name: "Switch", created_at: "", category: "rack", code: "SW", is_standard: true,
};

const template: PickerTemplate = {
  id: templateId, name: "Switch 24p", brandId: null, deviceTypeId: typeId,
  rackUnits: 1, widthIn: 19, rackMounted: true,
  frontFace: emptyFace(), backFace: emptyFace(),
  brandName: null,
};

function deviceRow(id: string, code: string, startU: number, groupId: string): RackDeviceRow {
  return {
    id, rack_id: "rack-1", device_template_id: templateId, code, name: null,
    start_u: startU, side: "front", status: "installed",
    manufacturer: null, model_name: null, serial_number: null, purchase_date: null, operation_start: null,
    front_face: face(groupId), back_face: emptyFace(), height_u: 1,
    created_at: "", updated_at: "",
  };
}

const rack: RackRow = { id: "rack-1", room_id: "room-1", code: "RK01", name: "Rack 1", height_u: 12 };

const conn: Connection = {
  id: "c1",
  a: { rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 },
  b: { rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 },
};

const siteScope: SiteScope = { racks: [], switches: [] };

function baseProps() {
  return {
    rack,
    initialDevices: [deviceRow("sw", "SW01", 5, "g-sw"), deviceRow("pp", "PP01", 3, "g-pp")],
    initialConnections: [conn] as Connection[],
    initialEndpoints: [] as PortEndpoint[],
    siteScope,
    floorTypes: [] as DeviceTypeRow[],
    types: [deviceType],
    templatesByType: { [typeId]: [template] },
  };
}

// Real click on the base rack svg (the one with the onClick that clears both selections) —
// distinct from the overlay svg (PatchLayer), which has no click handler of its own.
function clickEmptyCanvas(container: HTMLElement) {
  const svg = container.querySelector("svg")!;
  act(() => { fireEvent.click(svg); });
}

function clickCable(container: HTMLElement, id: string) {
  const cable = container.querySelector(`[data-testid="cable-${id}"]`)!;
  // Real browsers deliver a bubbling click after pointerdown/pointerup; PatchLayer's cable
  // selects on click (see PatchLayer.test.tsx). A raw dispatchEvent (rather than fireEvent)
  // isn't auto-wrapped in act() by RTL, so wrap it explicitly to force the resulting state
  // update to flush before the next assertion.
  act(() => { cable.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}

describe("RackBuilder sidebar selection", () => {
  it("selecting a device then a cable opens ConnectionDetails and hides device settings", () => {
    // Regression for the unwired half of selection exclusion: RackBuilder must pass a setter
    // that clears selectedId when a connection is picked, not the raw setSelectedConnectionId.
    // This test fails against the old `onSelectConnection={setSelectedConnectionId}` wiring,
    // because `selected` stays truthy and the sidebar keeps rendering device settings.
    const { container } = render(<RackBuilder {...baseProps()} />);
    fireEvent.click(screen.getByTestId("rack-dev-ear-l-sw"));
    expect(screen.getByTestId("rack-device-settings")).toBeInTheDocument();

    clickCable(container, "c1");

    expect(screen.getByTestId("connection-details")).toBeInTheDocument();
    expect(screen.queryByTestId("rack-device-settings")).toBeNull();
  });

  it("selecting a cable then a device shows device settings and hides ConnectionDetails", () => {
    const { container } = render(<RackBuilder {...baseProps()} />);
    clickCable(container, "c1");
    expect(screen.getByTestId("connection-details")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rack-dev-ear-l-pp"));

    expect(screen.getByTestId("rack-device-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("connection-details")).toBeNull();
  });

  it("deleting the selected device after it replaced a cable selection falls back to RackSettings", () => {
    // Guards the "earlier strand bug": deleting a device must never leave the sidebar blank or
    // stuck on a stale ConnectionDetails. Mutual exclusion means a device and a cable can never
    // be selected at once post-fix, so this exercises the round-trip immediately before the
    // delete (cable selected -> device selected, replacing it -> device deleted) and checks the
    // sidebar recovers to RackSettings rather than rendering nothing.
    const { container } = render(<RackBuilder {...baseProps()} />);
    clickCable(container, "c1");
    expect(screen.getByTestId("connection-details")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("rack-dev-ear-l-sw"));
    expect(screen.getByTestId("rack-device-settings")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("device-delete"));

    expect(screen.getByTestId("rack-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("rack-device-settings")).toBeNull();
    expect(screen.queryByTestId("connection-details")).toBeNull();
  });

  it("clicking the empty canvas shows RackSettings and clears both selections", () => {
    const { container } = render(<RackBuilder {...baseProps()} />);
    fireEvent.click(screen.getByTestId("rack-dev-ear-l-sw"));
    expect(screen.getByTestId("rack-device-settings")).toBeInTheDocument();

    clickEmptyCanvas(container);

    expect(screen.getByTestId("rack-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("rack-device-settings")).toBeNull();
    expect(screen.queryByTestId("connection-details")).toBeNull();

    // And from a cable selection too.
    clickCable(container, "c1");
    expect(screen.getByTestId("connection-details")).toBeInTheDocument();
    clickEmptyCanvas(container);
    expect(screen.getByTestId("rack-settings")).toBeInTheDocument();
    expect(screen.queryByTestId("connection-details")).toBeNull();
  });
});
