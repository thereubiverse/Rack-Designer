// Pure patch-cable math for the rack builder. No React, no I/O (mirrors rackOps.ts).
// A port is identified against a device's SNAPSHOT face by (rackDeviceId, side, groupId, portIndex).
import type { Face } from "@/domain/faceplate";

export type PortRef = { rackDeviceId: string; side: "front" | "back"; groupId: string; portIndex: number };
export type Connection = { id: string; a: PortRef; b: PortRef };

export function samePort(x: PortRef, y: PortRef): boolean {
  return x.rackDeviceId === y.rackDeviceId && x.side === y.side
    && x.groupId === y.groupId && x.portIndex === y.portIndex;
}

/** Every patchable port on one face of one placed device, in index order per group. */
export function portsOf(face: Face, rackDeviceId: string, side: "front" | "back"): PortRef[] {
  const out: PortRef[] = [];
  for (const g of face.portGroups) {
    const count = g.rows * g.cols;
    for (let i = 0; i < count; i++) out.push({ rackDeviceId, side, groupId: g.id, portIndex: i });
  }
  return out;
}

export function portConnection(conns: Connection[], p: PortRef): Connection | null {
  return conns.find((c) => samePort(c.a, p) || samePort(c.b, p)) ?? null;
}

export function isConnected(conns: Connection[], p: PortRef): boolean {
  return portConnection(conns, p) !== null;
}

export function portState(conns: Connection[], p: PortRef): "connected" | "unconnected" {
  return isConnected(conns, p) ? "connected" : "unconnected";
}

const exists = (portsByDevice: Record<string, PortRef[]>, p: PortRef): boolean =>
  (portsByDevice[p.rackDeviceId] ?? []).some((q) => samePort(q, p));

/** null = OK to patch; otherwise a human-readable reason. */
export function validatePatch(
  conns: Connection[], portsByDevice: Record<string, PortRef[]>, a: PortRef, b: PortRef,
): string | null {
  if (samePort(a, b)) return "Cannot patch a port to the same port";
  if (!exists(portsByDevice, a) || !exists(portsByDevice, b)) return "That port no longer exists";
  if (isConnected(conns, a) || isConnected(conns, b)) return "That port is already connected";
  return null;
}

export function addConnection(conns: Connection[], a: PortRef, b: PortRef, id?: string): Connection[] {
  return [...conns, { id: id ?? crypto.randomUUID(), a, b }];
}

export function removeConnection(conns: Connection[], id: string): Connection[] {
  return conns.filter((c) => c.id !== id);
}
