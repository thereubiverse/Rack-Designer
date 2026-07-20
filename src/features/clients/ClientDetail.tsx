"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ClientRow } from "@/lib/supabase/types";
import type { SiteSummary } from "./repository";
import { createSiteAction, renameSiteAction, deleteSiteAction } from "./actions";
import { DeleteDialog } from "./DeleteDialog";

const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";

/** One client's sites: breadcrumb back to /clients, a card table of sites (address + rack
 *  count), "+ Add site" and per-row rename/delete — same shape as ClientsTable one level down. */
export function ClientDetail({ client, sites }: { client: ClientRow; sites: SiteSummary[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<SiteSummary | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SiteSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleCreate(formData: FormData) {
    setCreateError(null);
    const res = await createSiteAction(formData);
    if (!res.ok) { setCreateError(res.error ?? "Failed"); return; }
    setCreateOpen(false);
    router.refresh();
  }

  async function handleRename(formData: FormData) {
    setRenameError(null);
    const res = await renameSiteAction(formData);
    if (!res.ok) { setRenameError(res.error ?? "Failed"); return; }
    setRenameTarget(null);
    router.refresh();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteError(null);
    const formData = new FormData();
    formData.set("id", deleteTarget.id);
    const res = await deleteSiteAction(formData);
    if (!res.ok) { setDeleteError(res.error ?? "Delete failed"); return; }
    setDeleteTarget(null);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <nav className="text-sm text-neutral-500">
        <Link href="/clients" className="hover:underline">Clients</Link>
        {" / "}
        <span className="text-neutral-900">{client.name}</span>
      </nav>

      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-lg font-bold text-neutral-900">Sites</h2>
          <button
            type="button"
            data-testid="table-create"
            onClick={() => setCreateOpen(true)}
            className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9]"
          >
            + Add site
          </button>
        </div>

        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-neutral-200 bg-neutral-50">
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Site</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Code</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Address</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Racks</th>
              <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((s) => (
              <tr
                key={s.id}
                data-testid={`site-row-${s.code}`}
                className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50"
              >
                <td className="px-5 py-3 font-medium text-neutral-900">
                  <Link href={`/clients/${encodeURIComponent(client.code)}/${encodeURIComponent(s.code)}`} className="text-blue-700 hover:underline">
                    {s.name}
                  </Link>
                </td>
                <td className="px-5 py-3 text-neutral-600">{s.code}</td>
                <td className="px-5 py-3 text-neutral-600">{s.address ?? "—"}</td>
                <td className="px-5 py-3 text-neutral-600">{s.rackCount}</td>
                <td className="px-5 py-3 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      type="button"
                      data-testid={`edit-site-${s.code}`}
                      onClick={() => setRenameTarget(s)}
                      className="text-sm font-semibold text-neutral-500 hover:text-neutral-800"
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      data-testid={`delete-site-${s.code}`}
                      onClick={() => { setDeleteError(null); setDeleteTarget(s); }}
                      className="text-sm font-semibold text-neutral-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {sites.length === 0 && (
              <tr>
                <td colSpan={5} className="px-5 py-14 text-center text-sm text-neutral-400">No sites yet</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Add site">
          <form action={handleCreate} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <input type="hidden" name="clientId" value={client.id} />
            <h3 className="text-base font-bold">Add site</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" placeholder="HQ" required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name *
              <input name="name" placeholder="Headquarters" required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Address
              <input name="address" className={input} />
            </label>
            {createError && <p className="text-sm text-red-600">{createError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setCreateOpen(false)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Cancel</button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Create</button>
            </div>
          </form>
        </div>
      )}

      {renameTarget && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Rename site">
          <form action={handleRename} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <input type="hidden" name="id" value={renameTarget.id} />
            <h3 className="text-base font-bold">Rename site</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" defaultValue={renameTarget.code} required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name *
              <input name="name" defaultValue={renameTarget.name} required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Address
              <input name="address" defaultValue={renameTarget.address ?? ""} className={input} />
            </label>
            {renameError && <p className="text-sm text-red-600">{renameError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setRenameTarget(null)} className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100">Cancel</button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-[#376ad9]">Save</button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <>
          <DeleteDialog
            open
            kind="site"
            code={deleteTarget.code}
            counts={{ racks: deleteTarget.rackCount, devices: deleteTarget.deviceCount }}
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
