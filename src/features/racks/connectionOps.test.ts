import { describe, it, expect } from "vitest";
import type { Face, PortGroup } from "@/domain/faceplate";
import {
  samePort, portsOf, portConnection, isConnected, portState,
  validatePatch, addConnection, removeConnection, type PortRef,
} from "./connectionOps";

const grp = (id: string, cols: number): PortGroup => ({
  id, media: "copper", connectorType: "RJ45", idPrefix: "P", countingDirection: "ltr",
  rows: 1, cols, gridX: 0, gridY: 0, colSpacing: 0, rowSpacing: 0, portOverrides: {},
});
const face = (groups: PortGroup[]): Face => ({ portGroups: groups, elements: [] });
const ref = (d: string, g: string, i: number): PortRef =>
  ({ rackDeviceId: d, side: "front", groupId: g, portIndex: i });

const swFace = face([grp("g-sw", 24)]);
const ppFace = face([grp("g-pp", 24)]);
const portsByDevice = {
  sw: portsOf(swFace, "sw", "front"),
  pp: portsOf(ppFace, "pp", "front"),
};

describe("portsOf", () => {
  it("enumerates one PortRef per port cell", () => {
    expect(portsOf(swFace, "sw", "front")).toHaveLength(24);
    expect(portsOf(swFace, "sw", "front")[0]).toEqual(ref("sw", "g-sw", 0));
  });
});

describe("samePort", () => {
  it("is identity equality over all four fields", () => {
    expect(samePort(ref("sw", "g-sw", 0), ref("sw", "g-sw", 0))).toBe(true);
    expect(samePort(ref("sw", "g-sw", 0), ref("sw", "g-sw", 1))).toBe(false);
    expect(samePort(ref("sw", "g-sw", 0), ref("pp", "g-sw", 0))).toBe(false);
  });
});

describe("validatePatch", () => {
  it("accepts two distinct free ports that exist", () => {
    expect(validatePatch([], portsByDevice, ref("sw", "g-sw", 0), ref("pp", "g-pp", 0))).toBeNull();
  });
  it("rejects patching a port to itself", () => {
    expect(validatePatch([], portsByDevice, ref("sw", "g-sw", 0), ref("sw", "g-sw", 0)))
      .toMatch(/same port/i);
  });
  it("rejects a port that is already connected", () => {
    const conns = addConnection([], ref("sw", "g-sw", 0), ref("pp", "g-pp", 0), "c1");
    expect(validatePatch(conns, portsByDevice, ref("sw", "g-sw", 0), ref("pp", "g-pp", 1)))
      .toMatch(/already connected/i);
    expect(validatePatch(conns, portsByDevice, ref("sw", "g-sw", 1), ref("pp", "g-pp", 0)))
      .toMatch(/already connected/i);
  });
  it("rejects a port absent from the snapshot", () => {
    expect(validatePatch([], portsByDevice, ref("sw", "g-sw", 99), ref("pp", "g-pp", 0)))
      .toMatch(/no longer exists|does not exist/i);
  });
});

describe("add / remove / query", () => {
  it("addConnection appends with a generated id and is queryable", () => {
    const conns = addConnection([], ref("sw", "g-sw", 0), ref("pp", "g-pp", 0));
    expect(conns).toHaveLength(1);
    expect(conns[0].id).toBeTruthy();
    expect(isConnected(conns, ref("sw", "g-sw", 0))).toBe(true);
    expect(isConnected(conns, ref("pp", "g-pp", 0))).toBe(true);
    expect(isConnected(conns, ref("sw", "g-sw", 1))).toBe(false);
    expect(portConnection(conns, ref("pp", "g-pp", 0))?.id).toBe(conns[0].id);
    expect(portState(conns, ref("sw", "g-sw", 0))).toBe("connected");
    expect(portState(conns, ref("sw", "g-sw", 1))).toBe("unconnected");
  });
  it("removeConnection drops by id", () => {
    const conns = addConnection([], ref("sw", "g-sw", 0), ref("pp", "g-pp", 0), "c1");
    expect(removeConnection(conns, "c1")).toHaveLength(0);
    expect(removeConnection(conns, "nope")).toHaveLength(1);
  });
});
