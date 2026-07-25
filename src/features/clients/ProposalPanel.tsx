"use client";

import { Icon } from "@iconify/react";
import { IconButton } from "./IconButton";
import type { DeviceProposal, RoomProposal, Confidence } from "./planDetect";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import { ROOM_TYPES, type RoomType } from "@/domain/hierarchy";

/** The review card for AI proposals: one editable row per proposed room/device, with per-row and
 *  bulk Accept/Dismiss. PURELY presentational — it owns no proposal state and calls no action. The
 *  canvas holds the proposals (it needs them for the ghost overlay and the pointer machinery) and
 *  hands every change back down through these callbacks. */

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-500",
  low: "bg-neutral-300",
};

function ConfidenceDot({ id, confidence }: { id: string; confidence: Confidence }) {
  return (
    <span
      data-testid={`proposal-confidence-${id}`}
      title={`Confidence: ${confidence}`}
      className={`mt-1 h-2 w-2 shrink-0 rounded-full ${CONFIDENCE_COLOR[confidence]}`}
    />
  );
}

const FIELD =
  "min-w-0 flex-1 rounded-lg border border-neutral-200 px-2 py-1 text-xs text-neutral-800 focus:border-blue-500 focus:outline-none";

export interface ProposalPanelProps {
  rooms: RoomProposal[];
  devices: DeviceProposal[];
  /** The device types the type select offers — already filtered to the floor category. */
  deviceTypes: DeviceTypeRow[];
  /** The room proposal whose vertex handles are showing on the plan, or null. */
  editingRoomId: string | null;
  /** True while an accept is in flight, so a second click can't commit the same proposal twice. */
  busy?: boolean;
  onEditDevice: (id: string, patch: Partial<DeviceProposal>) => void;
  onEditRoom: (id: string, patch: Partial<RoomProposal>) => void;
  onToggleRoomOutline: (id: string) => void;
  onAcceptDevice: (dp: DeviceProposal) => void;
  onAcceptRoom: (rp: RoomProposal) => void;
  onDismissDevice: (id: string) => void;
  onDismissRoom: (id: string) => void;
  onAcceptAll: () => void;
  onDismissAll: () => void;
}

export function ProposalPanel({
  rooms,
  devices,
  deviceTypes,
  editingRoomId,
  busy = false,
  onEditDevice,
  onEditRoom,
  onToggleRoomOutline,
  onAcceptDevice,
  onAcceptRoom,
  onDismissDevice,
  onDismissRoom,
  onAcceptAll,
  onDismissAll,
}: ProposalPanelProps) {
  const total = rooms.length + devices.length;
  if (total === 0) return null;

  return (
    <div
      data-testid="proposal-panel"
      className="flex max-h-full w-72 flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-2">
        <Icon icon="tabler:wand" width={15} height={15} className="text-amber-600" />
        <span className="text-xs font-semibold text-neutral-900">
          {total} proposal{total === 1 ? "" : "s"}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            data-testid="accept-all"
            disabled={busy}
            onClick={onAcceptAll}
            className="rounded-lg bg-blue-600 px-2 py-1 text-[11px] font-semibold text-white hover:bg-[#376ad9] disabled:opacity-50"
          >
            Accept all
          </button>
          <button
            type="button"
            data-testid="dismiss-all"
            disabled={busy}
            onClick={onDismissAll}
            className="rounded-lg border border-neutral-200 px-2 py-1 text-[11px] font-semibold text-neutral-600 hover:bg-neutral-50 disabled:opacity-50"
          >
            Dismiss all
          </button>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {rooms.map((rp) => (
          <div
            key={rp.id}
            data-testid={`proposal-item-${rp.id}`}
            className="flex items-start gap-1.5 rounded-xl px-1 py-1.5 hover:bg-neutral-50"
          >
            <ConfidenceDot id={rp.id} confidence={rp.confidence} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                data-testid={`proposal-name-${rp.id}`}
                aria-label="Room name"
                value={rp.name}
                onChange={(e) => onEditRoom(rp.id, { name: e.target.value })}
                className={FIELD}
              />
              <select
                data-testid={`proposal-roomtype-${rp.id}`}
                aria-label="Room type"
                value={rp.roomType}
                onChange={(e) => onEditRoom(rp.id, { roomType: e.target.value as RoomType })}
                className={FIELD}
              >
                {ROOM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <IconButton
              data-testid={`proposal-outline-${rp.id}`}
              icon="tabler:vector"
              tip={editingRoomId === rp.id ? "Done editing outline" : "Edit outline"}
              tipSide="left"
              variant={editingRoomId === rp.id ? "primary" : "default"}
              aria-pressed={editingRoomId === rp.id}
              onClick={() => onToggleRoomOutline(rp.id)}
            />
            <IconButton
              data-testid={`accept-${rp.id}`}
              icon="tabler:check"
              tip="Accept"
              tipSide="left"
              variant="primary"
              disabled={busy}
              onClick={() => onAcceptRoom(rp)}
            />
            <IconButton
              data-testid={`dismiss-${rp.id}`}
              icon="tabler:x"
              tip="Dismiss"
              tipSide="left"
              variant="danger"
              disabled={busy}
              onClick={() => onDismissRoom(rp.id)}
            />
          </div>
        ))}

        {devices.map((dp) => (
          <div
            key={dp.id}
            data-testid={`proposal-item-${dp.id}`}
            className="flex items-start gap-1.5 rounded-xl px-1 py-1.5 hover:bg-neutral-50"
          >
            <ConfidenceDot id={dp.id} confidence={dp.confidence} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <input
                data-testid={`proposal-label-${dp.id}`}
                aria-label="Device label"
                value={dp.label}
                onChange={(e) => onEditDevice(dp.id, { label: e.target.value })}
                className={FIELD}
              />
              <select
                data-testid={`proposal-type-${dp.id}`}
                aria-label="Device type"
                value={dp.typeCode}
                onChange={(e) => onEditDevice(dp.id, { typeCode: e.target.value })}
                className={FIELD}
              >
                {/* The model can propose a type code this site has no device type for. Keep it
                    visible rather than silently blanking the select — accepting it surfaces an
                    explicit "no such device type" error instead of committing a bad type id. */}
                {!deviceTypes.some((t) => t.code === dp.typeCode) && (
                  <option value={dp.typeCode}>{dp.typeCode}</option>
                )}
                {deviceTypes.map((t) => (
                  <option key={t.id} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <IconButton
              data-testid={`accept-${dp.id}`}
              icon="tabler:check"
              tip="Accept"
              tipSide="left"
              variant="primary"
              disabled={busy}
              onClick={() => onAcceptDevice(dp)}
            />
            <IconButton
              data-testid={`dismiss-${dp.id}`}
              icon="tabler:x"
              tip="Dismiss"
              tipSide="left"
              variant="danger"
              disabled={busy}
              onClick={() => onDismissDevice(dp.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
