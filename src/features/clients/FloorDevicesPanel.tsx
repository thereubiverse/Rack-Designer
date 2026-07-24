"use client";

import { useState, forwardRef, useImperativeHandle } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import { deviceTypeIcon, deviceTypeColor } from "@/features/device-library/deviceTypeIcons";
import { ROOM_TYPES } from "@/domain/hierarchy";
import type { FloorRow, RoomRow, FloorDeviceRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import { groupDevicesByRoom, suggestDeviceCode } from "./floorDeviceOps";
import {
  createRoomAction,
  renameRoomAction,
  deleteRoomAction,
  createFloorDeviceAction,
  updateFloorDeviceAction,
  deleteFloorDeviceAction,
  setRoomPolygonAction,
  placeFloorDeviceAction,
} from "./actions";
import type { NormPoint } from "./floorPlanOps";
import { DeleteDialog } from "./DeleteDialog";
import { IconButton } from "./IconButton";

const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";

const STATUS_CHIP: Record<"planned" | "installed", string> = {
  planned: "bg-neutral-100 text-neutral-600",
  installed: "bg-green-50 text-green-700",
};

const ROOM_TYPE_CHIP: Record<string, string> = {
  MDF: "bg-blue-50 text-blue-700",
  IDF: "bg-blue-50 text-blue-700",
};

/** One floor's rooms and their devices: a card per room (rename/delete + a device table), a
 *  trailing "Floor level" card for roomless devices (only when non-empty), and add/edit modals
 *  for rooms and devices. `rooms`/`devices` arrive pre-filtered to this floor by the caller;
 *  `deviceTypes` pre-filtered to floor-category types; `allSiteDeviceCodes` spans the whole site
 *  since device code suggestion must never collide with a code used on a different floor of the
 *  same site. `rackCountByRoomId` lets the room-delete dialog spell out its cascade without this
 *  component fetching anything itself. */
/** Imperative openers for the create-by-geometry flows: the plan toolbar traces/places first, then
 *  opens these modals carrying the geometry. All the modal state + device-code suggestion stay
 *  owned here; on submit the geometry is chained via setRoomPolygon / placeFloorDevice. */
export interface FloorDevicesPanelHandle {
  openAddRoomWithPolygon: (polygon: NormPoint[]) => void;
  openAddDeviceWithPlacement: (deviceTypeId: string, point: NormPoint) => void;
}

interface FloorDevicesPanelProps {
  floor: FloorRow;
  rooms: RoomRow[];
  devices: FloorDeviceRow[];
  deviceTypes: DeviceTypeRow[];
  allSiteDeviceCodes: string[];
  rackCountByRoomId: Record<string, number>;
  /** The header's detail-first Add room / Add device buttons. Hidden inside the plan sheet (the
   *  toolbar's geometry-first flow supersedes them), shown in the no-plan fallback where there's no
   *  plan to trace/place on. */
  showAddButtons?: boolean;
}

export const FloorDevicesPanel = forwardRef<FloorDevicesPanelHandle, FloorDevicesPanelProps>(
  function FloorDevicesPanel(
    { floor, rooms, devices, deviceTypes, allSiteDeviceCodes, rackCountByRoomId, showAddButtons = true },
    ref
  ) {
  const router = useRouter();

  const { sections, floorLevel } = groupDevicesByRoom(rooms, devices);

  const typeName = (id: string) => deviceTypes.find((t) => t.id === id)?.name ?? "—";
  const typeCode = (id: string) => deviceTypes.find((t) => t.id === id)?.code;
  const typeIcon = (id: string) => deviceTypeIcon(typeCode(id));

  // ---- Add room ----
  const [addRoomOpen, setAddRoomOpen] = useState(false);
  const [addRoomError, setAddRoomError] = useState<string | null>(null);
  // Set when the room was traced first (toolbar flow); its outline is saved right after the room
  // is created. Null for a plain detail-first add.
  const [pendingRoomPolygon, setPendingRoomPolygon] = useState<NormPoint[] | null>(null);

  async function handleAddRoom(formData: FormData) {
    setAddRoomError(null);
    formData.set("floorId", floor.id);
    const res = await createRoomAction(formData);
    if (!res.ok) {
      setAddRoomError(res.error ?? "Failed");
      return;
    }
    // Trace-then-name: persist the outline onto the room we just created.
    if (pendingRoomPolygon && res.id) {
      const poly = new FormData();
      poly.set("roomId", res.id);
      poly.set("polygon", JSON.stringify(pendingRoomPolygon));
      const polyRes = await setRoomPolygonAction(poly);
      if (!polyRes.ok) {
        // The room exists; only its outline failed. Surface it but still close — the outline can
        // be redrawn from the tray rather than being stuck in this modal.
        setAddRoomError(polyRes.error ?? "Room created, but saving its outline failed");
      }
    }
    setPendingRoomPolygon(null);
    setAddRoomOpen(false);
    router.refresh();
  }

  // ---- Rename room ----
  const [renameRoomTarget, setRenameRoomTarget] = useState<RoomRow | null>(null);
  const [renameRoomError, setRenameRoomError] = useState<string | null>(null);

  async function handleRenameRoom(formData: FormData) {
    if (!renameRoomTarget) return;
    setRenameRoomError(null);
    formData.set("id", renameRoomTarget.id);
    const res = await renameRoomAction(formData);
    if (!res.ok) {
      setRenameRoomError(res.error ?? "Failed");
      return;
    }
    setRenameRoomTarget(null);
    router.refresh();
  }

  // ---- Delete room ----
  const [deleteRoomTarget, setDeleteRoomTarget] = useState<RoomRow | null>(null);
  const [deleteRoomError, setDeleteRoomError] = useState<string | null>(null);

  async function handleDeleteRoom() {
    if (!deleteRoomTarget) return;
    setDeleteRoomError(null);
    const formData = new FormData();
    formData.set("id", deleteRoomTarget.id);
    const res = await deleteRoomAction(formData);
    if (!res.ok) {
      setDeleteRoomError(res.error ?? "Delete failed");
      return;
    }
    setDeleteRoomTarget(null);
    router.refresh();
  }

  // ---- Add device ----
  const [addDeviceOpen, setAddDeviceOpen] = useState(false);
  const [addDeviceError, setAddDeviceError] = useState<string | null>(null);
  const [addTypeId, setAddTypeId] = useState<string>(deviceTypes[0]?.id ?? "");
  const [addCode, setAddCode] = useState<string>("");
  const [addCodeTouched, setAddCodeTouched] = useState(false);
  // Set when the device was placed first (toolbar flow); it's placed at this point right after the
  // device is created. Null for a plain detail-first add.
  const [pendingDevicePoint, setPendingDevicePoint] = useState<NormPoint | null>(null);

  /** Reset the device form to a chosen type with a fresh suggested code. */
  function primeAddDevice(typeId: string) {
    setAddDeviceError(null);
    const type = deviceTypes.find((t) => t.id === typeId) ?? deviceTypes[0];
    setAddTypeId(type?.id ?? "");
    setAddCode(type ? suggestDeviceCode(type.code, allSiteDeviceCodes) : "");
    setAddCodeTouched(false);
  }

  function openAddDevice() {
    primeAddDevice(deviceTypes[0]?.id ?? "");
    setPendingDevicePoint(null);
    setAddDeviceOpen(true);
  }

  // No deps array: recreated every render so the openers always close over the current
  // deviceTypes / allSiteDeviceCodes (needed for code suggestion).
  useImperativeHandle(ref, () => ({
    openAddRoomWithPolygon: (polygon: NormPoint[]) => {
      setAddRoomError(null);
      setPendingRoomPolygon(polygon);
      setAddRoomOpen(true);
    },
    openAddDeviceWithPlacement: (deviceTypeId: string, point: NormPoint) => {
      primeAddDevice(deviceTypeId);
      setPendingDevicePoint(point);
      setAddDeviceOpen(true);
    },
  }));

  function handleAddTypeChange(id: string) {
    setAddTypeId(id);
    if (!addCodeTouched) {
      const type = deviceTypes.find((t) => t.id === id);
      setAddCode(type ? suggestDeviceCode(type.code, allSiteDeviceCodes) : "");
    }
  }

  function handleAddCodeChange(value: string) {
    setAddCode(value);
    setAddCodeTouched(true);
  }

  async function handleAddDevice(formData: FormData) {
    setAddDeviceError(null);
    formData.set("floorId", floor.id);
    const res = await createFloorDeviceAction(formData);
    if (!res.ok) {
      setAddDeviceError(res.error ?? "Failed");
      return;
    }
    // Place-then-detail: drop the device we just created at the clicked point.
    if (pendingDevicePoint && res.id) {
      const place = new FormData();
      place.set("id", res.id);
      place.set("x", String(pendingDevicePoint[0]));
      place.set("y", String(pendingDevicePoint[1]));
      const placeRes = await placeFloorDeviceAction(place);
      if (!placeRes.ok) {
        setAddDeviceError(placeRes.error ?? "Device created, but placing it failed");
      }
    }
    setPendingDevicePoint(null);
    setAddDeviceOpen(false);
    router.refresh();
  }

  // ---- Edit device ----
  const [editDeviceTarget, setEditDeviceTarget] = useState<FloorDeviceRow | null>(null);
  const [editDeviceError, setEditDeviceError] = useState<string | null>(null);

  async function handleEditDevice(formData: FormData) {
    if (!editDeviceTarget) return;
    setEditDeviceError(null);
    formData.set("id", editDeviceTarget.id);
    formData.set("floorId", floor.id);
    const res = await updateFloorDeviceAction(formData);
    if (!res.ok) {
      setEditDeviceError(res.error ?? "Failed");
      return;
    }
    setEditDeviceTarget(null);
    router.refresh();
  }

  // ---- Delete device ----
  const [deleteDeviceError, setDeleteDeviceError] = useState<string | null>(null);

  async function handleDeleteDevice(id: string) {
    setDeleteDeviceError(null);
    const formData = new FormData();
    formData.set("id", id);
    const res = await deleteFloorDeviceAction(formData);
    if (!res.ok) {
      setDeleteDeviceError(res.error ?? "Delete failed");
      return;
    }
    router.refresh();
  }

  function renderDeviceRow(device: FloorDeviceRow) {
    return (
      <tr key={device.id} className="border-b border-neutral-100 last:border-0">
        <td className="px-4 py-2 font-medium text-neutral-900">{device.code}</td>
        <td className="px-4 py-2 text-neutral-600">
          <span className="inline-flex items-center gap-1.5">
            <Icon icon={typeIcon(device.device_type_id)} width={15} height={15} color={deviceTypeColor(typeCode(device.device_type_id))} className="shrink-0" />
            {typeName(device.device_type_id)}
          </span>
        </td>
        <td className="px-4 py-2 text-neutral-600">{device.name}</td>
        <td className="px-4 py-2">
          <span
            data-testid={`device-status-${device.code}`}
            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_CHIP[device.status]}`}
          >
            {device.status}
          </span>
        </td>
        <td className="px-4 py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <IconButton
              data-testid={`device-edit-${device.code}`}
              icon="tabler:pencil"
              tip="Edit device"
              onClick={() => {
                setEditDeviceError(null);
                setEditDeviceTarget(device);
              }}
            />
            <IconButton
              data-testid={`device-delete-${device.code}`}
              icon="tabler:trash"
              tip="Delete device"
              variant="danger"
              onClick={() => handleDeleteDevice(device.id)}
            />
          </div>
        </td>
      </tr>
    );
  }

  function deviceTable(list: FloorDeviceRow[]) {
    return (
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-100">
            <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Code</th>
            <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Type</th>
            <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Name</th>
            <th className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Status</th>
            <th className="px-4 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Actions</th>
          </tr>
        </thead>
        <tbody>{list.map(renderDeviceRow)}</tbody>
      </table>
    );
  }

  return (
    <div className="space-y-4">
      {/* Only the no-plan fallback shows these (see showAddButtons): with a plan, the toolbar's
          trace/place-first flow supersedes them, and the sheet tab already labels the section. */}
      {showAddButtons && (
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-neutral-900">Rooms &amp; devices</h2>
          <div className="flex items-center gap-1">
            <IconButton
              data-testid="add-room"
              icon="tabler:door"
              tip="Add room"
              onClick={() => {
                setAddRoomError(null);
                setPendingRoomPolygon(null);
                setAddRoomOpen(true);
              }}
            />
            <IconButton
              data-testid="add-device"
              icon="tabler:plus"
              tip="Add device"
              variant="primary"
              onClick={openAddDevice}
            />
          </div>
        </div>
      )}

      {sections.map(({ room, devices: roomDevices }) => (
        <div
          key={room.id}
          data-testid={`room-section-${room.code}`}
          className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm"
        >
          <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-5 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-neutral-900">{room.code}</span>
              <span className="text-sm text-neutral-600">{room.name}</span>
              {room.type !== "other" && (
                <span
                  data-testid={`room-type-${room.code}`}
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${ROOM_TYPE_CHIP[room.type]}`}
                >
                  {room.type}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <IconButton
                data-testid={`room-rename-${room.code}`}
                icon="tabler:pencil"
                tip="Rename room"
                onClick={() => {
                  setRenameRoomError(null);
                  setRenameRoomTarget(room);
                }}
              />
              <IconButton
                data-testid={`room-delete-${room.code}`}
                icon="tabler:trash"
                tip="Delete room"
                variant="danger"
                onClick={() => {
                  setDeleteRoomError(null);
                  setDeleteRoomTarget(room);
                }}
              />
            </div>
          </div>
          {roomDevices.length === 0 ? (
            <p className="px-5 py-6 text-center text-sm text-neutral-400">No devices yet</p>
          ) : (
            deviceTable(roomDevices)
          )}
        </div>
      ))}

      {floorLevel.length > 0 && (
        <div
          data-testid="floor-level-section"
          className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm"
        >
          <div className="border-b border-neutral-200 bg-neutral-50 px-5 py-2.5">
            <span className="text-sm font-semibold text-neutral-900">Floor level</span>
          </div>
          {deviceTable(floorLevel)}
        </div>
      )}

      {addRoomOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Add room">
          <form action={handleAddRoom} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Add room</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" placeholder="MDF" required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name
              <input name="name" className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Type
              <select name="type" defaultValue="other" className={input}>
                {ROOM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {addRoomError && <p className="text-sm text-red-600">{addRoomError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => { setAddRoomOpen(false); setPendingRoomPolygon(null); }} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {renameRoomTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Rename room">
          <form action={handleRenameRoom} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Rename room</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" defaultValue={renameRoomTarget.code} required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name
              <input name="name" defaultValue={renameRoomTarget.name ?? ""} className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Type
              <select name="type" defaultValue={renameRoomTarget.type} className={input}>
                {ROOM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {renameRoomError && <p className="text-sm text-red-600">{renameRoomError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setRenameRoomTarget(null)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteRoomTarget &&
        (() => {
          const movedDevices = devices.filter((d) => d.room_id === deleteRoomTarget.id).length;
          return (
            <>
              <DeleteDialog
                open
                kind="room"
                code={deleteRoomTarget.code}
                counts={{ racks: rackCountByRoomId[deleteRoomTarget.id] ?? 0 }}
                note={movedDevices > 0 ? `${movedDevices} ${movedDevices === 1 ? "device" : "devices"} will move to floor level` : undefined}
                onConfirm={handleDeleteRoom}
                onCancel={() => {
                  setDeleteRoomError(null);
                  setDeleteRoomTarget(null);
                }}
              />
              {deleteRoomError && (
                <div className="fixed inset-x-0 top-4 z-[80] flex justify-center px-4">
                  <p data-testid="delete-error" className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-2xl">
                    {deleteRoomError}
                  </p>
                </div>
              )}
            </>
          );
        })()}

      {addDeviceOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Add device">
          <form action={handleAddDevice} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Add device</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Type *
              <select
                name="deviceTypeId"
                value={addTypeId}
                onChange={(e) => handleAddTypeChange(e.target.value)}
                required
                className={input}
              >
                {deviceTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input
                name="code"
                value={addCode}
                onChange={(e) => handleAddCodeChange(e.target.value)}
                required
                className={input}
              />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name
              <input name="name" className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Room
              <select name="roomId" defaultValue="" className={input}>
                <option value="">Floor level</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Status
              <select name="status" defaultValue="planned" className={input}>
                <option value="planned">Planned</option>
                <option value="installed">Installed</option>
              </select>
            </label>
            {addDeviceError && <p className="text-sm text-red-600">{addDeviceError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => { setAddDeviceOpen(false); setPendingDevicePoint(null); }} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {editDeviceTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Edit device">
          <form action={handleEditDevice} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Edit device</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Type *
              <select name="deviceTypeId" defaultValue={editDeviceTarget.device_type_id} required className={input}>
                {deviceTypes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" defaultValue={editDeviceTarget.code} required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name
              <input name="name" defaultValue={editDeviceTarget.name} className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Room
              <select name="roomId" defaultValue={editDeviceTarget.room_id ?? ""} className={input}>
                <option value="">Floor level</option>
                {rooms.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.code}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Status
              <select name="status" defaultValue={editDeviceTarget.status} className={input}>
                <option value="planned">Planned</option>
                <option value="installed">Installed</option>
              </select>
            </label>
            {editDeviceError && <p className="text-sm text-red-600">{editDeviceError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditDeviceTarget(null)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">
                Save
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteDeviceError && (
        <div className="fixed inset-x-0 top-4 z-[80] flex justify-center px-4">
          <p data-testid="delete-device-error" className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-2xl">
            {deleteDeviceError}
          </p>
        </div>
      )}
    </div>
  );
});
