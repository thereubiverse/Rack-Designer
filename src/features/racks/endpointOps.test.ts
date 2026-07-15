import { describe, it, expect } from "vitest";
import {
  endpointForPort, upsertEndpoint, removeEndpoint, validateEndpoint,
  type PortEndpoint, type EndpointContext, type OutletPortCount,
} from "./endpointOps";
import type { PortRef } from "./connectionOps";

const p = (i: number): PortRef => ({ rackDeviceId: "pp", side: "front", groupId: "g", portIndex: i });
const described = (id: string, port: PortRef, over: Partial<Extract<PortEndpoint, { kind: "described" }>> = {}): PortEndpoint => ({
  id, port, kind: "described", deviceTypeId: "cam", name: "CAM01",
  portCount: 1, landingPortIndex: 0, landingPortLabel: "", ...over,
});

const ctx: EndpointContext = {
  floorTypeIds: new Set(["cam", "to"]),
  portsByDevice: { pp: [p(0), p(1), p(2)] },
  thisRackId: "rack-1",
  siteRackIds: new Set(["rack-2"]),          // OTHER racks on this site
  siteSwitchDeviceIds: new Set(["sw-in-rack-2"]),
};

describe("endpointOps", () => {
  it("finds an endpoint by its port", () => {
    const eps = [described("e1", p(0)), described("e2", p(1))];
    expect(endpointForPort(eps, p(1))?.id).toBe("e2");
    expect(endpointForPort(eps, p(2))).toBeNull();
  });

  it("upsert replaces the endpoint on a port rather than duplicating it", () => {
    const eps = upsertEndpoint([described("e1", p(0))], described("e2", p(0), { name: "CAM02" }));
    expect(eps).toHaveLength(1);
    expect(eps[0].id).toBe("e2");
  });

  it("upsert appends when the port has no endpoint yet", () => {
    expect(upsertEndpoint([described("e1", p(0))], described("e2", p(1)))).toHaveLength(2);
  });

  it("removes by id", () => {
    expect(removeEndpoint([described("e1", p(0)), described("e2", p(1))], "e1").map((e) => e.id)).toEqual(["e2"]);
  });

  it("rejects an endpoint on a port that does not exist", () => {
    expect(validateEndpoint(described("e", p(9)), ctx)).toBe("That port no longer exists");
  });

  it("rejects a described endpoint whose type is not a floor type", () => {
    expect(validateEndpoint(described("e", p(0), { deviceTypeId: "rack-switch" }), ctx))
      .toBe("That endpoint type is not a floor device type");
  });

  it("rejects a landing port off the faceplate", () => {
    expect(validateEndpoint(described("e", p(0), { deviceTypeId: "to", portCount: 4, landingPortIndex: 4 }), ctx))
      .toBe("That port is not on the faceplate");
  });

  it("accepts a valid described endpoint", () => {
    expect(validateEndpoint(described("e", p(0), { deviceTypeId: "to", portCount: 4, landingPortIndex: 3 }), ctx)).toBeNull();
  });

  // portCount is typed as OutletPortCount, but it arrives over the wire as arbitrary JSON, so this
  // guard is a real runtime check, not dead code.
  it("rejects an outlet with an invalid port count", () => {
    const ep = described("e", p(0), { deviceTypeId: "to", portCount: 5 as unknown as OutletPortCount });
    expect(validateEndpoint(ep, ctx)).toBe("An outlet must have 0, 1, 2, 3, 4 or 6 ports");
  });

  it("accepts a blank (0-port) plate, which has no landing port", () => {
    const ep = described("e", p(0), { deviceTypeId: "to", portCount: 0, landingPortIndex: 0 });
    expect(validateEndpoint(ep, ctx)).toBeNull();
  });

  it("rejects a blank plate that claims a landing port", () => {
    const ep = described("e", p(0), { deviceTypeId: "to", portCount: 0, landingPortIndex: 1 });
    expect(validateEndpoint(ep, ctx)).toBe("A blank plate has no ports to land on");
  });

  it("rejects a device endpoint that is not a switch on this site", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "device", targetRackDeviceId: "sw-elsewhere" };
    expect(validateEndpoint(ep, ctx)).toBe("Pick a switch in another rack on this site");
  });

  it("accepts a device endpoint targeting a site switch", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "device", targetRackDeviceId: "sw-in-rack-2" };
    expect(validateEndpoint(ep, ctx)).toBeNull();
  });

  it("rejects a rack uplink to this same rack", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "rack", targetRackId: "rack-1" };
    expect(validateEndpoint(ep, ctx)).toBe("An uplink must target a different rack");
  });

  it("rejects a rack uplink off this site", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "rack", targetRackId: "rack-99" };
    expect(validateEndpoint(ep, ctx)).toBe("Pick a rack on this site");
  });

  it("accepts a rack uplink to another rack on this site", () => {
    const ep: PortEndpoint = { id: "e", port: p(0), kind: "rack", targetRackId: "rack-2" };
    expect(validateEndpoint(ep, ctx)).toBeNull();
  });
});
