import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ConnectionDetails } from "./ConnectionDetails";
import type { Connection, PortRef } from "./connectionOps";
import type { PortEndpoint } from "./endpointOps";
import type { SiteScope } from "./siteScope";
import type { DeviceTypeRow } from "@/features/device-library/repository";

const a: PortRef = { rackDeviceId: "sw", side: "front", groupId: "g-sw", portIndex: 0 };
const b: PortRef = { rackDeviceId: "pp", side: "front", groupId: "g-pp", portIndex: 0 };
const conn: Connection = { id: "c1", a, b };

const t = (id: string, code: string, name: string): DeviceTypeRow => ({
  id, name, created_at: "", category: "floor", code, is_standard: true,
});
const floorTypes = [t("cam", "CAM", "Camera"), t("to", "TO", "Telecommunications Outlet"), t("rk", "RK", "Rack")];
const siteScope = {
  racks: [{ id: "rack-2", code: "RK02" }],
  switches: [{ id: "sw-2", code: "SW01", rackId: "rack-2", rackCode: "RK02", frontFace: null, heightU: 1 }],
};
const base = {
  connection: conn, endpoints: [] as PortEndpoint[], floorTypes, siteScope,
  portLabel: (p: PortRef) => `${p.rackDeviceId.toUpperCase()}/${p.portIndex + 1}`,
  onChange: vi.fn(), onRemove: vi.fn(),
};

describe("ConnectionDetails", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the run and one editor per end", () => {
    render(<ConnectionDetails {...base} />);
    expect(screen.getByText("SW/1 ↔ PP/1")).toBeTruthy();
    expect(screen.getByTestId("endpoint-editor-sw-front-g-sw-0")).toBeTruthy();
    expect(screen.getByTestId("endpoint-editor-pp-front-g-pp-0")).toBeTruthy();
  });

  it("omits the RK floor type from the select (an uplink is a real reference instead)", () => {
    render(<ConnectionDetails {...base} />);
    const sel = screen.getByTestId("endpoint-type-pp-front-g-pp-0") as HTMLSelectElement;
    const values = [...sel.options].map((o) => o.value);
    expect(values).toContain("described:cam");
    expect(values).not.toContain("described:rk");
    expect(values).toContain("device");
    expect(values).toContain("rack");
  });

  it("choosing a described type emits a described endpoint", () => {
    const onChange = vi.fn();
    render(<ConnectionDetails {...base} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-type-pp-front-g-pp-0"), { target: { value: "described:cam" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    expect(ep.kind).toBe("described");
    expect(ep.port).toEqual(b);
    if (ep.kind === "described") expect(ep.deviceTypeId).toBe("cam");
  });

  it("shows the port-count select for an outlet only", () => {
    const outlet: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "to",
      name: "OUT-12", portCount: 4, landingPortIndex: 1, landingPortLabel: "Desk A" };
    const { rerender } = render(<ConnectionDetails {...base} endpoints={[outlet]} />);
    expect(screen.queryByTestId("endpoint-portcount-pp-front-g-pp-0")).toBeTruthy();

    const cam: PortEndpoint = { ...outlet, deviceTypeId: "cam", portCount: 1, landingPortIndex: 0 };
    rerender(<ConnectionDetails {...base} endpoints={[cam]} />);
    expect(screen.queryByTestId("endpoint-portcount-pp-front-g-pp-0")).toBeNull();
  });

  it("editing the device name emits the updated endpoint", () => {
    const onChange = vi.fn();
    const cam: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "cam",
      name: "", portCount: 1, landingPortIndex: 0, landingPortLabel: "" };
    render(<ConnectionDetails {...base} endpoints={[cam]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-name-pp-front-g-pp-0"), { target: { value: "CAM01" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    if (ep.kind === "described") expect(ep.name).toBe("CAM01");
  });

  it("a switch endpoint lists site switches and emits a device endpoint", () => {
    const onChange = vi.fn();
    render(<ConnectionDetails {...base} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-type-pp-front-g-pp-0"), { target: { value: "device" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    expect(ep.kind).toBe("device");
    if (ep.kind === "device") expect(ep.targetRackDeviceId).toBe("sw-2");
  });

  it("renders a face for a set endpoint and removes on click", () => {
    const onRemove = vi.fn();
    const cam: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "cam",
      name: "CAM01", portCount: 1, landingPortIndex: 0, landingPortLabel: "" };
    render(<ConnectionDetails {...base} endpoints={[cam]} onRemove={onRemove} />);
    expect(screen.getAllByTestId("endpoint-face").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("endpoint-remove-pp-front-g-pp-0"));
    expect(onRemove).toHaveBeenCalledWith("e1");
  });

  it("a rack endpoint lists site racks, emits a rack endpoint, and renders a face", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ConnectionDetails {...base} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-type-pp-front-g-pp-0"), { target: { value: "rack" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    expect(ep.kind).toBe("rack");
    if (ep.kind === "rack") expect(ep.targetRackId).toBe("rack-2");

    const rack: PortEndpoint = { id: "e1", port: b, kind: "rack", targetRackId: "rack-2" };
    rerender(<ConnectionDetails {...base} endpoints={[rack]} />);
    expect(screen.getByTestId("endpoint-rack-pp-front-g-pp-0")).toBeTruthy();
    expect(screen.getAllByTestId("endpoint-face").length).toBeGreaterThan(0);
  });

  it("shrinking the port count clamps landingPortIndex to stay on the faceplate", () => {
    const onChange = vi.fn();
    const outlet: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "to",
      name: "OUT-12", portCount: 4, landingPortIndex: 3, landingPortLabel: "Desk A" };
    render(<ConnectionDetails {...base} endpoints={[outlet]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-portcount-pp-front-g-pp-0"), { target: { value: "2" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    if (ep.kind === "described") {
      expect(ep.portCount).toBe(2);
      expect(ep.landingPortIndex).toBe(1);
    }
  });

  it("choosing No endpoint on a set endpoint calls onRemove with that endpoint's id", () => {
    const onRemove = vi.fn();
    const onChange = vi.fn();
    const cam: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "cam",
      name: "CAM01", portCount: 1, landingPortIndex: 0, landingPortLabel: "" };
    render(<ConnectionDetails {...base} endpoints={[cam]} onRemove={onRemove} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-type-pp-front-g-pp-0"), { target: { value: "" } });
    expect(onRemove).toHaveBeenCalledWith("e1");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("changing the landing port select emits the new landingPortIndex", () => {
    const onChange = vi.fn();
    const outlet: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "to",
      name: "OUT-12", portCount: 4, landingPortIndex: 1, landingPortLabel: "Desk A" };
    render(<ConnectionDetails {...base} endpoints={[outlet]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-landing-pp-front-g-pp-0"), { target: { value: "3" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    expect(ep.kind).toBe("described");
    if (ep.kind === "described") expect(ep.landingPortIndex).toBe(3);
  });

  it("editing the endpoint label emits the new landingPortLabel (editable for every described type)", () => {
    const onChange = vi.fn();
    const cam: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "cam",
      name: "CAM01", portCount: 1, landingPortIndex: 0, landingPortLabel: "" };
    render(<ConnectionDetails {...base} endpoints={[cam]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-label-pp-front-g-pp-0"), { target: { value: "Lobby" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    expect(ep.kind).toBe("described");
    if (ep.kind === "described") expect(ep.landingPortLabel).toBe("Lobby");
  });

  it("switching between described types preserves the typed name and label", () => {
    const onChange = vi.fn();
    const cam: PortEndpoint = { id: "e1", port: b, kind: "described", deviceTypeId: "cam",
      name: "CAM01", portCount: 1, landingPortIndex: 0, landingPortLabel: "Lobby" };
    render(<ConnectionDetails {...base} endpoints={[cam]} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("endpoint-type-pp-front-g-pp-0"), { target: { value: "described:to" } });
    const ep = onChange.mock.calls[0][0] as PortEndpoint;
    expect(ep.kind).toBe("described");
    if (ep.kind === "described") {
      expect(ep.name).toBe("CAM01");
      expect(ep.landingPortLabel).toBe("Lobby");
      expect(ep.portCount).toBe(1);
      expect(ep.landingPortIndex).toBe(0);
    }
  });

  it("disables the switch and rack options when the site has none to offer", () => {
    const emptyScope = { racks: [] as SiteScope["racks"], switches: [] as SiteScope["switches"] };
    render(<ConnectionDetails {...base} siteScope={emptyScope} />);
    const sel = screen.getByTestId("endpoint-type-pp-front-g-pp-0") as HTMLSelectElement;
    const deviceOption = [...sel.options].find((o) => o.value === "device")!;
    const rackOption = [...sel.options].find((o) => o.value === "rack")!;
    expect(deviceOption.disabled).toBe(true);
    expect(rackOption.disabled).toBe(true);
  });
});
