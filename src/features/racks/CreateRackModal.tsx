"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ROOM_TYPES } from "@/domain/hierarchy";
import { createRackInSiteAction, findSiteIdByCodeAction } from "@/features/locations/actions";

/** The Phase-1 create flow (site/floor/room/rack codes + height) restyled into a light modal. */
export function CreateRackModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function action(formData: FormData) {
    setError(null);
    const siteCode = String(formData.get("siteCode") ?? "");
    const site = await findSiteIdByCodeAction(siteCode);
    if (!site) { setError("Unknown site — create it first"); return; }
    formData.set("siteId", site.id);
    const res = await createRackInSiteAction(formData);
    if (!res.ok) { setError(res.error ?? "Failed"); return; }
    setOpen(false);
    router.refresh();
  }

  const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";
  return (
    <>
      <button type="button" data-testid="rack-create" onClick={() => setOpen(true)}
        className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9]">
        + Create rack
      </button>
      {open && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Create rack">
          <form action={action} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Create rack</h3>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] font-semibold text-neutral-600">Site *<input name="siteCode" placeholder="HQ" required className={input} /></label>
              <label className="text-[11px] font-semibold text-neutral-600">Floor *<input name="floorCode" placeholder="28" required className={input} /></label>
              <label className="text-[11px] font-semibold text-neutral-600">Room *<input name="roomCode" placeholder="SL" required className={input} /></label>
              <label className="text-[11px] font-semibold text-neutral-600">Room type
                <select name="roomType" defaultValue="other" className={input}>
                  {ROOM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-[11px] font-semibold text-neutral-600">Rack code *<input name="rackCode" placeholder="RK001" required className={input} /></label>
              <label className="text-[11px] font-semibold text-neutral-600">Height (U) *<input name="heightU" type="number" defaultValue={42} min={1} max={60} required className={input} /></label>
            </div>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Cancel</button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Create</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
