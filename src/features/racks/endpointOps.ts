// Pure far-end math for rack ports. No React, no I/O (mirrors connectionOps.ts).
// An endpoint belongs to a PORT, so it survives unplugging/re-patching the cable.
import { samePort, type PortRef } from "./connectionOps";

export type OutletPortCount = 1 | 2 | 3 | 4 | 6;
export const OUTLET_PORT_COUNTS: OutletPortCount[] = [1, 2, 3, 4, 6];

export type PortEndpoint =
  | { id: string; port: PortRef; kind: "described"; deviceTypeId: string; name: string;
      portCount: OutletPortCount; landingPortIndex: number; landingPortLabel: string }
  | { id: string; port: PortRef; kind: "device"; targetRackDeviceId: string }
  | { id: string; port: PortRef; kind: "rack"; targetRackId: string };

/** Everything validation needs, with no I/O — the action builds this from fresh rows. */
export interface EndpointContext {
  floorTypeIds: Set<string>;                 // device_types with category='floor'
  portsByDevice: Record<string, PortRef[]>;  // valid ports per device in THIS rack (from snapshots)
  thisRackId: string;
  siteRackIds: Set<string>;                  // OTHER racks on this site
  siteSwitchDeviceIds: Set<string>;          // Switch-type devices in those other racks
}

export function endpointForPort(eps: PortEndpoint[], p: PortRef): PortEndpoint | null {
  return eps.find((e) => samePort(e.port, p)) ?? null;
}

/** One endpoint per port: replace the port's endpoint if it has one, else append. */
export function upsertEndpoint(eps: PortEndpoint[], ep: PortEndpoint): PortEndpoint[] {
  const i = eps.findIndex((e) => samePort(e.port, ep.port));
  if (i === -1) return [...eps, ep];
  const next = [...eps];
  next[i] = ep;
  return next;
}

export function removeEndpoint(eps: PortEndpoint[], id: string): PortEndpoint[] {
  return eps.filter((e) => e.id !== id);
}

/** null = OK to save; otherwise a human-readable reason. */
export function validateEndpoint(ep: PortEndpoint, ctx: EndpointContext): string | null {
  const ports = ctx.portsByDevice[ep.port.rackDeviceId] ?? [];
  if (!ports.some((q) => samePort(q, ep.port))) return "That port no longer exists";

  if (ep.kind === "described") {
    if (!ctx.floorTypeIds.has(ep.deviceTypeId)) return "That endpoint type is not a floor device type";
    if (!OUTLET_PORT_COUNTS.includes(ep.portCount)) return "An outlet must have 1, 2, 3, 4 or 6 ports";
    if (ep.landingPortIndex < 0 || ep.landingPortIndex >= ep.portCount) return "That port is not on the faceplate";
    return null;
  }
  if (ep.kind === "device") {
    // siteSwitchDeviceIds already excludes this rack, so "another rack" holds by construction.
    if (!ctx.siteSwitchDeviceIds.has(ep.targetRackDeviceId)) return "Pick a switch in another rack on this site";
    return null;
  }
  if (ep.targetRackId === ctx.thisRackId) return "An uplink must target a different rack";
  if (!ctx.siteRackIds.has(ep.targetRackId)) return "Pick a rack on this site";
  return null;
}
