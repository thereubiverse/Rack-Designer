"use client";
// Right panel for a selected connection: one far-end editor per end. Presentational — every edit
// is emitted upward; RackBuilder owns the state, history and autosave.
import type { Connection, PortRef } from "./connectionOps";
import { endpointForPort, OUTLET_PORT_COUNTS, type OutletPortCount, type PortEndpoint } from "./endpointOps";
import { OUTLET_TYPE_CODE } from "./endpointFaces";
import type { SiteScope } from "./siteScope";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import { EndpointFaceView } from "./EndpointFaceView";

const keyOf = (p: PortRef) => `${p.rackDeviceId}-${p.side}-${p.groupId}-${p.portIndex}`;
/** An uplink is a real rack reference, so the RK floor type never appears as a described type. */
const RACK_TYPE_CODE = "RK";

export function ConnectionDetails(props: {
  connection: Connection;
  endpoints: PortEndpoint[];
  floorTypes: DeviceTypeRow[];
  siteScope: SiteScope;
  portLabel: (p: PortRef) => string;
  onChange: (ep: PortEndpoint) => void;
  onRemove: (id: string) => void;
}) {
  const { connection, portLabel } = props;
  return (
    <div data-testid="connection-details">
      <h3 className="text-sm font-semibold text-neutral-900">Connection</h3>
      <p className="mt-1 text-xs text-neutral-500">{portLabel(connection.a)} ↔ {portLabel(connection.b)}</p>
      {[connection.a, connection.b].map((port) => (
        <EndpointEditor key={keyOf(port)} port={port} {...props} />
      ))}
    </div>
  );
}

function EndpointEditor({ port, endpoints, floorTypes, siteScope, portLabel, onChange, onRemove }: {
  port: PortRef;
  endpoints: PortEndpoint[];
  floorTypes: DeviceTypeRow[];
  siteScope: SiteScope;
  portLabel: (p: PortRef) => string;
  onChange: (ep: PortEndpoint) => void;
  onRemove: (id: string) => void;
}) {
  const k = keyOf(port);
  const ep = endpointForPort(endpoints, port);
  const describedTypes = floorTypes.filter((t) => t.code !== RACK_TYPE_CODE);
  const typeById = Object.fromEntries(floorTypes.map((t) => [t.id, t]));
  const selectValue = !ep ? "" : ep.kind === "described" ? `described:${ep.deviceTypeId}` : ep.kind;

  function pickKind(value: string) {
    const id = ep?.id ?? crypto.randomUUID();
    if (value === "") { if (ep) onRemove(ep.id); return; }
    if (value === "device") {
      const first = siteScope.switches[0];
      if (!first) return;
      onChange({ id, port, kind: "device", targetRackDeviceId: first.id });
      return;
    }
    if (value === "rack") {
      const first = siteScope.racks[0];
      if (!first) return;
      onChange({ id, port, kind: "rack", targetRackId: first.id });
      return;
    }
    const deviceTypeId = value.slice("described:".length);
    onChange({ id, port, kind: "described", deviceTypeId, name: "",
      portCount: 1, landingPortIndex: 0, landingPortLabel: "" });
  }

  const isOutlet = ep?.kind === "described" && typeById[ep.deviceTypeId]?.code === OUTLET_TYPE_CODE;

  return (
    <div data-testid={`endpoint-editor-${k}`} className="mt-3 rounded-lg border border-neutral-200 p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-900">{portLabel(port)}</span>
        {ep && (
          <button type="button" data-testid={`endpoint-remove-${k}`} className="text-xs text-red-600"
            onClick={() => onRemove(ep.id)}>Remove</button>
        )}
      </div>

      <select data-testid={`endpoint-type-${k}`} value={selectValue}
        onChange={(e) => pickKind(e.target.value)}
        className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm">
        <option value="">No endpoint</option>
        {describedTypes.map((t) => <option key={t.id} value={`described:${t.id}`}>{t.name}</option>)}
        <option value="device" disabled={siteScope.switches.length === 0}
          title={siteScope.switches.length === 0 ? "No switches in other racks on this site" : undefined}>
          Switch (another rack)
        </option>
        <option value="rack" disabled={siteScope.racks.length === 0}
          title={siteScope.racks.length === 0 ? "No other racks on this site" : undefined}>
          Rack uplink
        </option>
      </select>

      {ep?.kind === "described" && (
        <>
          <input data-testid={`endpoint-name-${k}`} value={ep.name} placeholder="Device name"
            onChange={(e) => onChange({ ...ep, name: e.target.value })}
            className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm" />
          {isOutlet && (
            <div className="mt-2 flex gap-2">
              <select data-testid={`endpoint-portcount-${k}`} value={ep.portCount}
                onChange={(e) => {
                  const portCount = Number(e.target.value) as OutletPortCount;
                  onChange({ ...ep, portCount, landingPortIndex: Math.min(ep.landingPortIndex, portCount - 1) });
                }}
                className="w-1/2 rounded-md border border-neutral-300 px-2 py-1 text-sm">
                {OUTLET_PORT_COUNTS.map((n) => <option key={n} value={n}>{n} port</option>)}
              </select>
              <select data-testid={`endpoint-landing-${k}`} value={ep.landingPortIndex}
                onChange={(e) => onChange({ ...ep, landingPortIndex: Number(e.target.value) })}
                className="w-1/2 rounded-md border border-neutral-300 px-2 py-1 text-sm">
                {Array.from({ length: ep.portCount }, (_, i) => <option key={i} value={i}>Port {i + 1}</option>)}
              </select>
            </div>
          )}
          <input data-testid={`endpoint-label-${k}`} value={ep.landingPortLabel} placeholder="Endpoint label"
            onChange={(e) => onChange({ ...ep, landingPortLabel: e.target.value })}
            className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm" />
        </>
      )}

      {ep?.kind === "device" && (
        <select data-testid={`endpoint-switch-${k}`} value={ep.targetRackDeviceId}
          onChange={(e) => onChange({ ...ep, targetRackDeviceId: e.target.value })}
          className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm">
          {siteScope.switches.map((s) => <option key={s.id} value={s.id}>{s.rackCode}/{s.code}</option>)}
        </select>
      )}

      {ep?.kind === "rack" && (
        <select data-testid={`endpoint-rack-${k}`} value={ep.targetRackId}
          onChange={(e) => onChange({ ...ep, targetRackId: e.target.value })}
          className="mt-2 w-full rounded-md border border-neutral-300 px-2 py-1 text-sm">
          {siteScope.racks.map((r) => <option key={r.id} value={r.id}>{r.code}</option>)}
        </select>
      )}

      {ep && (
        <div className="mt-3 rounded-md border border-neutral-200 bg-neutral-50 p-2">
          {ep.kind === "described" && (
            <EndpointFaceView kind="described" typeCode={typeById[ep.deviceTypeId]?.code ?? ""}
              portCount={ep.portCount} landingPortIndex={ep.landingPortIndex} landingPortLabel={ep.landingPortLabel} />
          )}
          {ep.kind === "device" && (() => {
            const target = siteScope.switches.find((s) => s.id === ep.targetRackDeviceId);
            return target ? <EndpointFaceView kind="device" target={target} /> : null;
          })()}
          {ep.kind === "rack" && (() => {
            const target = siteScope.racks.find((r) => r.id === ep.targetRackId);
            return target ? <EndpointFaceView kind="rack" rackCode={target.code} /> : null;
          })()}
        </div>
      )}
    </div>
  );
}
