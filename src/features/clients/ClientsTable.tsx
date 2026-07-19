"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ClientSummary } from "./repository";
import { createClientAction, renameClientAction, deleteClientAction } from "./actions";
import { DeleteDialog } from "./DeleteDialog";

const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";

/** The /clients directory: one row per client with its site/rack counts, matching the
 *  RackDeviceTable card layout. "+ Add client" opens a create form; each row can be renamed or
 *  deleted (delete reuses the shared DeleteDialog, gated on the client's own cascade counts). */
export function ClientsTable({ clients }: { clients: ClientSummary[] }) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<ClientSummary | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ClientSummary | null>(null);

  async function handleCreate(formData: FormData) {
    setCreateError(null);
    const res = await createClientAction(formData);
    if (!res.ok) { setCreateError(res.error ?? "Failed"); return; }
    setCreateOpen(false);
    router.refresh();
  }

  async function handleRename(formData: FormData) {
    setRenameError(null);
    const res = await renameClientAction(formData);
    if (!res.ok) { setRenameError(res.error ?? "Failed"); return; }
    setRenameTarget(null);
    router.refresh();
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    const formData = new FormData();
    formData.set("id", deleteTarget.id);
    await deleteClientAction(formData);
    setDeleteTarget(null);
    router.refresh();
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-center justify-between px-5 py-4">
        <h2 className="text-lg font-bold text-neutral-900">Clients</h2>
        <button
          type="button"
          data-testid="table-create"
          onClick={() => setCreateOpen(true)}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-[#376ad9]"
        >
          + Add client
        </button>
      </div>

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-y border-neutral-200 bg-neutral-50">
            <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Client</th>
            <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Code</th>
            <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Sites</th>
            <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Racks</th>
            <th className="px-5 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Actions</th>
          </tr>
        </thead>
        <tbody>
          {clients.map((c) => (
            <tr
              key={c.id}
              data-testid={`client-row-${c.code}`}
              className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50"
            >
              <td className="px-5 py-3 font-medium text-neutral-900">
                <Link href={`/clients/${encodeURIComponent(c.code)}`} className="text-blue-700 hover:underline">
                  {c.name}
                </Link>
              </td>
              <td className="px-5 py-3 text-neutral-600">{c.code}</td>
              <td className="px-5 py-3 text-neutral-600">{c.siteCount}</td>
              <td className="px-5 py-3 text-neutral-600">{c.rackCount}</td>
              <td className="px-5 py-3 text-right">
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid={`edit-client-${c.code}`}
                    onClick={() => setRenameTarget(c)}
                    className="text-sm font-semibold text-neutral-500 hover:text-neutral-800"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    data-testid={`delete-client-${c.code}`}
                    onClick={() => setDeleteTarget(c)}
                    className="text-sm font-semibold text-neutral-400 hover:text-red-600"
                  >
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {clients.length === 0 && (
            <tr>
              <td colSpan={5} className="px-5 py-14 text-center text-sm text-neutral-400">No clients yet</td>
            </tr>
          )}
        </tbody>
      </table>

      {createOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Add client">
          <form action={handleCreate} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold">Add client</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" placeholder="ACME" required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name *
              <input name="name" placeholder="Acme Corp" required className={input} />
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
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label="Rename client">
          <form action={handleRename} className="w-full max-w-sm space-y-3 rounded-2xl bg-white p-6 shadow-2xl">
            <input type="hidden" name="id" value={renameTarget.id} />
            <h3 className="text-base font-bold">Rename client</h3>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Code *
              <input name="code" defaultValue={renameTarget.code} required className={input} />
            </label>
            <label className="block text-[11px] font-semibold text-neutral-600">
              Name *
              <input name="name" defaultValue={renameTarget.name} required className={input} />
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
        <DeleteDialog
          open
          kind="client"
          code={deleteTarget.code}
          counts={{ sites: deleteTarget.siteCount, racks: deleteTarget.rackCount }}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
