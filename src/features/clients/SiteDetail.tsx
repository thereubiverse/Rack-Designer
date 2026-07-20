"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ROOM_TYPES } from "@/domain/hierarchy";
import type { ClientRow, SiteRow } from "@/lib/supabase/types";
import type { SiteRackRow } from "./repository";
import { createRackInSiteAction } from "@/features/locations/actions";
import { deleteRackAction } from "./actions";
import { DeleteDialog } from "./DeleteDialog";

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

/** One site's racks, grouped by floor · room. Each rack links to its /racks/<id> permalink
 *  (rack codes repeat across rooms, so only the id identifies a rack uniquely). "+ Add rack"
 *  posts createRackInSiteAction; the floor/room inputs are datalist-backed from the racks
 *  already on this site so an existing floor/room is picked rather than retyped. */
export function SiteDetail({ client, site, racks }: { client: ClientRow; site: SiteRow; racks: SiteRackRow[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SiteRackRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const groups = groupRacks(racks);
  const floorOptions = [...new Set(racks.map((r) => r.floorCode))];
  const roomOptions = [...new Set(racks.map((r) => r.roomCode))];

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
        <button
          type="button"
          data-testid="table-create"
          onClick={() => setCreateOpen(true)}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9]"
        >
          + Add rack
        </button>
      </div>

      {groups.length === 0 && (
        <div className="rounded-2xl border border-neutral-200 bg-white px-5 py-14 text-center text-sm text-neutral-400 shadow-sm">
          No racks yet
        </div>
      )}

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
                  <td className="px-5 py-3 text-right">
                    <button
                      type="button"
                      data-testid={`delete-rack-${r.id}`}
                      onClick={() => { setDeleteError(null); setDeleteTarget(r); }}
                      className="text-sm font-semibold text-neutral-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

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
    </div>
  );
}
