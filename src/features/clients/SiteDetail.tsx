"use client";

import { useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ROOM_TYPES } from "@/domain/hierarchy";
import type { ClientRow, SiteRow, FloorRow, RoomRow, FloorDeviceRow, FloorPlanRow } from "@/lib/supabase/types";
import type { DeviceTypeRow } from "@/features/device-library/repository";
import type { SiteRackRow } from "./repository";
import { createRackInSiteAction } from "@/features/locations/actions";
import {
  deleteRackAction,
  createFloorAction,
  renameFloorAction,
  deleteFloorAction,
  deleteFloorPlanAction,
} from "./actions";
import { normaliseCode, type CascadeCounts } from "./validation";
import { partitionPlacement } from "./floorPlanOps";
import { DeleteDialog } from "./DeleteDialog";
import { IconButton } from "./IconButton";
import { FloorTabs } from "./FloorTabs";
import { FloorDevicesPanel, type FloorDevicesPanelHandle } from "./FloorDevicesPanel";
import { FloorPlanCanvas, type FloorPlanCanvasHandle } from "./FloorPlanCanvas";
import { PlanBottomSheet, type PlanBottomSheetHandle } from "./PlanBottomSheet";
import { PlanUploadZone } from "./PlanUploadZone";

const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";

interface RackGroup {
  floorCode: string;
  roomCode: string;
  racks: SiteRackRow[];
}

/** Groups racks by `${floorCode} · ${roomCode}`, preserving the order each group was first seen
 *  in (the racks arrive pre-sorted by code from listRacksForSite, not by floor/room). */
function groupRacks(racks: SiteRackRow[]): RackGroup[] {
  const groups = new Map<string, RackGroup>();
  for (const r of racks) {
    const key = `${r.floorCode} · ${r.roomCode}`;
    let group = groups.get(key);
    if (!group) {
      group = { floorCode: r.floorCode, roomCode: r.roomCode, racks: [] };
      groups.set(key, group);
    }
    group.racks.push(r);
  }
  return [...groups.values()];
}

/** One site's floors, rooms, devices and racks. The active floor comes from `?floor=` (normalised,
 *  falling back to the first floor whenever the param is missing or doesn't match any floor's
 *  code — a deep link never 404s). Rooms/devices/racks are all site-wide props, sliced down to the
 *  active floor here before being handed to `FloorDevicesPanel`; `SiteRackRow` carries
 *  `floorCode`/`roomCode` (not ids), so racks are matched to the active floor by code and rooms are
 *  matched to racks by code too. Rack groups (the existing table view) are filtered the same way.
 *  Floor add/rename/delete all live here, right alongside `FloorTabs`; the delete confirmation's
 *  counts are computed from these same sliced props, exactly like the existing rack delete. */
export function SiteDetail({
  client,
  site,
  racks,
  floors,
  rooms,
  devices,
  deviceTypes,
  plans,
  planUrls,
}: {
  client: ClientRow;
  site: SiteRow;
  racks: SiteRackRow[];
  floors: FloorRow[];
  rooms: RoomRow[];
  devices: FloorDeviceRow[];
  deviceTypes: DeviceTypeRow[];
  plans: FloorPlanRow[];
  planUrls: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The create-by-geometry flow spans three components: the canvas runs the trace/place gesture,
  // the panel owns the details modal, the sheet gets out of the way. SiteDetail holds the refs that
  // connect them, plus the device type the user picked before placing.
  const panelRef = useRef<FloorDevicesPanelHandle>(null);
  const canvasRef = useRef<FloorPlanCanvasHandle>(null);
  const sheetRef = useRef<PlanBottomSheetHandle>(null);
  const pendingDeviceType = useRef<string | null>(null);
  const [deviceMenuOpen, setDeviceMenuOpen] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SiteRackRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [addFloorOpen, setAddFloorOpen] = useState(false);
  const [addFloorError, setAddFloorError] = useState<string | null>(null);
  const [renameFloorOpen, setRenameFloorOpen] = useState(false);
  const [renameFloorError, setRenameFloorError] = useState<string | null>(null);
  const [deleteFloorOpen, setDeleteFloorOpen] = useState(false);
  const [deleteFloorError, setDeleteFloorError] = useState<string | null>(null);

  const [deletePlanOpen, setDeletePlanOpen] = useState(false);
  const [deletePlanError, setDeletePlanError] = useState<string | null>(null);

  const rawFloorParam = searchParams.get("floor");
  const normalisedFloorParam = rawFloorParam ? normaliseCode(rawFloorParam) : null;
  const activeFloor = floors.find((f) => f.code === normalisedFloorParam) ?? floors[0];
  const activeCode = activeFloor?.code ?? "";

  const activeFloorRooms = activeFloor ? rooms.filter((r) => r.floor_id === activeFloor.id) : [];
  const activeFloorDevices = activeFloor ? devices.filter((d) => d.floor_id === activeFloor.id) : [];
  const activeFloorRacks = activeFloor ? racks.filter((r) => r.floorCode === activeFloor.code) : [];
  const allSiteDeviceCodes = devices.map((d) => d.code);

  // planUrls is keyed by floor_id (not plan id) — see the page loader's comment.
  const activeFloorPlan = activeFloor ? plans.find((p) => p.floor_id === activeFloor.id) : undefined;
  const activePlanUrl = activeFloorPlan ? planUrls[activeFloorPlan.floor_id] : undefined;

  // Nothing is actually destroyed by deleting a plan (devices/rooms survive, only their
  // placement clears) — these counts feed the dialog's NOTE, never its typed-confirm gate.
  const { placed: activeFloorPlacedDevices } = partitionPlacement(activeFloorDevices);
  const activeFloorOutlineCount = activeFloorRooms.filter((r) => r.plan_polygon != null).length;
  const deletePlanNote = `${activeFloorPlacedDevices.length} device ${activeFloorPlacedDevices.length === 1 ? "pin" : "pins"} and ${activeFloorOutlineCount} room ${activeFloorOutlineCount === 1 ? "outline" : "outlines"} will be cleared.`;

  const rackCountByRoomId: Record<string, number> = {};
  for (const room of activeFloorRooms) {
    rackCountByRoomId[room.id] = activeFloorRacks.filter((r) => r.roomCode === room.code).length;
  }

  const floorDeleteCounts: CascadeCounts = {
    rooms: activeFloorRooms.length,
    racks: activeFloorRacks.length,
    devices: activeFloorDevices.length + activeFloorRacks.reduce((sum, r) => sum + r.deviceCount, 0),
  };

  const groups = groupRacks(activeFloorRacks);
  const floorOptions = [...new Set(racks.map((r) => r.floorCode))];
  const roomOptions = [...new Set(racks.map((r) => r.roomCode))];

  function handleSelectFloor(code: string) {
    router.replace(`${pathname}?floor=${encodeURIComponent(code)}`, { scroll: false });
  }

  async function handleCreate(formData: FormData) {
    setCreateError(null);
    formData.set("siteId", site.id);
    const res = await createRackInSiteAction(formData);
    if (!res.ok) { setCreateError(res.error ?? "Failed"); return; }
    setCreateOpen(false);
    router.refresh();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    const formData = new FormData();
    formData.set("rackId", deleteTarget.id);
    const res = await deleteRackAction(formData);
    if (!res.ok) { setDeleteError(res.error ?? "Delete failed"); return; }
    setDeleteTarget(null);
    router.refresh();
  }

  async function handleAddFloor(formData: FormData) {
    setAddFloorError(null);
    formData.set("siteId", site.id);
    const res = await createFloorAction(formData);
    if (!res.ok) { setAddFloorError(res.error ?? "Failed"); return; }
    setAddFloorOpen(false);
    router.refresh();
  }

  async function handleRenameFloor(formData: FormData) {
    if (!activeFloor) return;
    setRenameFloorError(null);
    const oldCode = activeFloor.code;
    const newCode = normaliseCode(String(formData.get("code") ?? ""));
    formData.set("id", activeFloor.id);
    const res = await renameFloorAction(formData);
    if (!res.ok) { setRenameFloorError(res.error ?? "Failed"); return; }
    setRenameFloorOpen(false);
    // The renamed floor is always the active one here (this form only ever edits activeFloor), so
    // keep the ?floor= param pointed at it under its new code — otherwise a stale code matches no
    // floor after refresh and the user gets silently bounced to floors[0].
    if (newCode && newCode !== oldCode) {
      router.replace(`${pathname}?floor=${encodeURIComponent(newCode)}`, { scroll: false });
    }
    router.refresh();
  }

  async function handleDeleteFloor() {
    if (!activeFloor) return;
    setDeleteFloorError(null);
    const formData = new FormData();
    formData.set("id", activeFloor.id);
    const res = await deleteFloorAction(formData);
    if (!res.ok) { setDeleteFloorError(res.error ?? "Delete failed"); return; }
    setDeleteFloorOpen(false);
    router.refresh();
  }

  async function handleDeletePlan() {
    if (!activeFloor) return;
    setDeletePlanError(null);
    const formData = new FormData();
    formData.set("floorId", activeFloor.id);
    const res = await deleteFloorPlanAction(formData);
    if (!res.ok) { setDeletePlanError(res.error ?? "Delete failed"); return; }
    setDeletePlanOpen(false);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <nav className="text-sm text-neutral-500">
        <Link href="/clients" className="hover:underline">Clients</Link>
        {" / "}
        <Link href={`/clients/${encodeURIComponent(client.code)}`} className="hover:underline">{client.name}</Link>
        {" / "}
        <span className="text-neutral-900">{site.name}</span>
      </nav>

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">{site.name}</h2>
        <IconButton
          data-testid="table-create"
          icon="tabler:plus"
          tip="Add rack"
          variant="primary"
          onClick={() => setCreateOpen(true)}
        />
      </div>

      <div className="flex items-center justify-between">
        <FloorTabs
          floors={floors}
          activeCode={activeCode}
          onSelect={handleSelectFloor}
          onAdd={() => { setAddFloorError(null); setAddFloorOpen(true); }}
        />
        {activeFloor && (
          <div className="flex items-center gap-1 pb-2">
            <IconButton
              data-testid="rename-floor"
              icon="tabler:pencil"
              tip="Rename floor"
              onClick={() => { setRenameFloorError(null); setRenameFloorOpen(true); }}
            />
            <IconButton
              data-testid="delete-floor"
              icon="tabler:trash"
              tip="Delete floor"
              variant="danger"
              onClick={() => { setDeleteFloorError(null); setDeleteFloorOpen(true); }}
            />
          </div>
        )}
      </div>

      {floors.length === 0 ? (
        <div className="rounded-2xl border border-neutral-200 bg-white px-5 py-14 text-center text-sm text-neutral-400 shadow-sm">
          No floors yet
        </div>
      ) : (
        <>
          {activeFloor && (() => {
            // ref + showAddButtons vary by context: inside the sheet the toolbar's geometry-first
            // flow owns creation (ref wired, header buttons hidden); the no-plan fallback shows the
            // detail-first header buttons and needs no ref.
            const roomsDevicesPanel = (withRef: boolean) => (
              <FloorDevicesPanel
                ref={withRef ? panelRef : undefined}
                showAddButtons={!withRef}
                floor={activeFloor}
                rooms={activeFloorRooms}
                devices={activeFloorDevices}
                deviceTypes={deviceTypes}
                allSiteDeviceCodes={allSiteDeviceCodes}
                rackCountByRoomId={rackCountByRoomId}
              />
            );

            const startAddRoom = () => {
              setDeviceMenuOpen(false);
              sheetRef.current?.collapse();
              canvasRef.current?.startTraceRoom();
            };
            const startAddDevice = (typeId: string) => {
              pendingDeviceType.current = typeId;
              setDeviceMenuOpen(false);
              sheetRef.current?.collapse();
              canvasRef.current?.startPlaceDevice();
            };

            const racksContent =
              groups.length === 0 ? (
                <div className="rounded-2xl border border-neutral-200 bg-white px-5 py-14 text-center text-sm text-neutral-400 shadow-sm">
                  No racks yet
                </div>
              ) : (
                <div className="space-y-4">
                  {groups.map((g) => (
                    <section key={`${g.floorCode}-${g.roomCode}`} className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
                      <h3
                        data-testid={`rack-group-${g.floorCode}-${g.roomCode}`}
                        className="border-b border-neutral-200 bg-neutral-50 px-5 py-2.5 text-sm font-semibold text-neutral-700"
                      >
                        {g.floorCode} · {g.roomCode}
                      </h3>
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-neutral-100">
                            <th className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Rack</th>
                            <th className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Height</th>
                            <th className="px-5 py-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Devices</th>
                            <th className="px-5 py-2 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.racks.map((r) => (
                            <tr key={r.id} className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50">
                              <td className="px-5 py-3 font-medium">
                                <Link href={`/racks/${r.id}`} className="text-blue-700 hover:underline">{r.code}</Link>
                              </td>
                              <td className="px-5 py-3 text-neutral-600">{r.heightU} U</td>
                              <td className="px-5 py-3 text-neutral-600">{r.deviceCount}</td>
                              <td className="px-5 py-3">
                                <div className="flex justify-end">
                                  <IconButton
                                    data-testid={`delete-rack-${r.id}`}
                                    icon="tabler:trash"
                                    tip="Delete rack"
                                    variant="danger"
                                    onClick={() => { setDeleteError(null); setDeleteTarget(r); }}
                                  />
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </section>
                  ))}
                </div>
              );

            // Plan-level controls injected into the canvas's top-left toolbar. Add room starts a
            // trace; Add device opens a type menu, then starts placement — both finish in the
            // panel's modal via the canvas callbacks below.
            const planTools = (
              <>
                <IconButton
                  data-testid="plan-add-room"
                  icon="tabler:square-plus"
                  tip="Add room"
                  tipSide="right"
                  variant="floating"
                  onClick={startAddRoom}
                />
                <div className="relative">
                  <IconButton
                    data-testid="plan-add-device"
                    icon="tabler:circle-plus"
                    tip="Add device"
                    tipSide="right"
                    variant={deviceMenuOpen ? "floatingActive" : "floating"}
                    aria-pressed={deviceMenuOpen}
                    onClick={() => setDeviceMenuOpen((o) => !o)}
                  />
                  {deviceMenuOpen && (
                    <div
                      data-testid="device-type-menu"
                      className="absolute left-full top-0 z-40 ml-2 max-h-64 w-56 overflow-y-auto rounded-lg border border-neutral-200 bg-white p-1 shadow-lg"
                    >
                      <p className="px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                        Pick a device to place
                      </p>
                      {deviceTypes.length === 0 ? (
                        <p className="px-3 py-2 text-sm text-neutral-400">No device types available</p>
                      ) : (
                        deviceTypes.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            data-testid={`device-type-${t.id}`}
                            onClick={() => startAddDevice(t.id)}
                            className="block w-full rounded-md px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-100"
                          >
                            {t.name}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
                <PlanUploadZone floorId={activeFloor.id} hasPlan variant="icon" />
                <IconButton
                  data-testid="delete-plan"
                  icon="tabler:trash"
                  tip="Delete plan"
                  tipSide="right"
                  variant="floatingDanger"
                  onClick={() => { setDeletePlanError(null); setDeletePlanOpen(true); }}
                />
              </>
            );

            // Has a plan: the plan is the focus, with a slide-up sheet (Rooms & Devices / Racks)
            // overlaying its lower edge.
            if (activeFloorPlan && activePlanUrl) {
              return (
                <div className="relative overflow-hidden rounded-2xl">
                  <FloorPlanCanvas
                    key={activeFloor.id}
                    ref={canvasRef}
                    plan={activeFloorPlan}
                    planUrl={activePlanUrl}
                    rooms={activeFloorRooms}
                    devices={activeFloorDevices}
                    racks={activeFloorRacks}
                    deviceTypes={deviceTypes}
                    editable
                    planTools={planTools}
                    onRoomTraced={(polygon) => panelRef.current?.openAddRoomWithPolygon(polygon)}
                    onDevicePlaced={(point) => {
                      const typeId = pendingDeviceType.current;
                      pendingDeviceType.current = null;
                      if (typeId) panelRef.current?.openAddDeviceWithPlacement(typeId, point);
                    }}
                  />
                  <PlanBottomSheet
                    ref={sheetRef}
                    tabs={[
                      { id: "rooms", label: "Rooms & Devices", content: roomsDevicesPanel(true) },
                      { id: "racks", label: "Racks", content: racksContent },
                    ]}
                  />
                </div>
              );
            }

            // No usable plan (failed to load, or none uploaded yet): fall back to the stacked
            // layout — there's no plan to overlay a sheet onto.
            return (
              <div className="space-y-4">
                {activeFloorPlan ? (
                  <div
                    data-testid="plan-unavailable"
                    className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4"
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold text-amber-800">
                        The floor plan couldn&apos;t be loaded — try reloading the page.
                      </p>
                      <div className="flex items-center gap-2">
                        <PlanUploadZone floorId={activeFloor.id} hasPlan variant="icon" />
                        <IconButton
                          data-testid="delete-plan"
                          icon="tabler:trash"
                          tip="Delete plan"
                          variant="floatingDanger"
                          onClick={() => { setDeletePlanError(null); setDeletePlanOpen(true); }}
                        />
                      </div>
                    </div>
                  </div>
                ) : (
                  <PlanUploadZone floorId={activeFloor.id} hasPlan={false} />
                )}
                {roomsDevicesPanel(false)}
                {racksContent}
              </div>
            );
          })()}
        </>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Add rack">
          <form action={handleCreate} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Add rack</h3>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] font-semibold text-neutral-600">
                Floor *
                <input name="floorCode" list="floor-options" placeholder="GF" required className={input} />
                <datalist id="floor-options">
                  {floorOptions.map((f) => <option key={f} value={f} />)}
                </datalist>
              </label>
              <label className="text-[11px] font-semibold text-neutral-600">
                Room *
                <input name="roomCode" list="room-options" placeholder="MDF" required className={input} />
                <datalist id="room-options">
                  {roomOptions.map((r) => <option key={r} value={r} />)}
                </datalist>
              </label>
              <label className="text-[11px] font-semibold text-neutral-600">
                Room type
                <select name="roomType" defaultValue="other" className={input}>
                  {ROOM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-[11px] font-semibold text-neutral-600">
                Rack code *
                <input name="rackCode" placeholder="RK01" required className={input} />
              </label>
              <label className="text-[11px] font-semibold text-neutral-600">
                Height (U) *
                <input name="heightU" type="number" defaultValue={42} min={1} max={60} required className={input} />
              </label>
            </div>
            {createError && <p className="text-sm text-red-600">{createError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Cancel</button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Create</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <>
          <DeleteDialog
            open
            kind="rack"
            code={deleteTarget.code}
            counts={{ devices: deleteTarget.deviceCount }}
            onConfirm={handleDelete}
            onCancel={() => { setDeleteError(null); setDeleteTarget(null); }}
          />
          {deleteError && (
            <div className="fixed inset-x-0 top-4 z-[80] flex justify-center px-4">
              <p data-testid="delete-error" className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-2xl">
                {deleteError}
              </p>
            </div>
          )}
        </>
      )}

      {addFloorOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Add floor">
          <form action={handleAddFloor} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Add floor</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" placeholder="GF" required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name
              <input name="name" className={input} />
            </label>
            {addFloorError && <p className="text-sm text-red-600">{addFloorError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setAddFloorOpen(false)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Cancel</button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Create</button>
            </div>
          </form>
        </div>
      )}

      {renameFloorOpen && activeFloor && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Rename floor">
          <form action={handleRenameFloor} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Rename floor</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" defaultValue={activeFloor.code} required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name
              <input name="name" defaultValue={activeFloor.name ?? ""} className={input} />
            </label>
            {renameFloorError && <p className="text-sm text-red-600">{renameFloorError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setRenameFloorOpen(false)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Cancel</button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Save</button>
            </div>
          </form>
        </div>
      )}

      {deleteFloorOpen && activeFloor && (
        <>
          <DeleteDialog
            open
            kind="floor"
            code={activeFloor.code}
            counts={floorDeleteCounts}
            onConfirm={handleDeleteFloor}
            onCancel={() => { setDeleteFloorError(null); setDeleteFloorOpen(false); }}
          />
          {deleteFloorError && (
            <div className="fixed inset-x-0 top-4 z-[80] flex justify-center px-4">
              <p data-testid="delete-floor-error" className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-2xl">
                {deleteFloorError}
              </p>
            </div>
          )}
        </>
      )}

      {deletePlanOpen && activeFloor && (
        <>
          <DeleteDialog
            open
            kind="plan"
            code={activeFloor.code}
            counts={{}}
            note={deletePlanNote}
            onConfirm={handleDeletePlan}
            onCancel={() => { setDeletePlanError(null); setDeletePlanOpen(false); }}
          />
          {deletePlanError && (
            <div className="fixed inset-x-0 top-4 z-[80] flex justify-center px-4">
              <p data-testid="delete-plan-error" className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-2xl">
                {deletePlanError}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
