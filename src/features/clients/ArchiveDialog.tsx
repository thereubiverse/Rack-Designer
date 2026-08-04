"use client";

/** Confirmation for archiving a client, site or floor.
 *
 *  Separate from DeleteDialog on purpose. DeleteDialog still serves racks, rooms and plans, which
 *  really are destroyed, and its copy and typed-code gate belong to that. Archiving is reversible,
 *  so it neither threatens nor gates: a confirmation that costs as much as a destructive one just
 *  teaches people to type through both. */

const KIND_LABEL: Record<"client" | "site" | "floor", string> = {
  client: "client",
  site: "site",
  floor: "floor",
};

export interface ArchiveDialogProps {
  kind: "client" | "site" | "floor";
  code: string;
  error: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ArchiveDialog({ kind, code, error, busy, onConfirm, onCancel }: ArchiveDialogProps) {
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4"
      role="dialog"
      aria-label={`Archive ${KIND_LABEL[kind]}`}
    >
      <div data-testid="archive-dialog" className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-base font-bold">
          Archive {KIND_LABEL[kind]} &ldquo;{code}&rdquo;?
        </h3>
        <p className="mt-2 text-sm text-neutral-600">
          It stops appearing in the app but keeps all of its data, and can be restored from Settings
          → Archive.
        </p>
        {error && (
          <p data-testid="archive-error-message" className="mt-3 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="archive-cancel"
            disabled={busy}
            onClick={onCancel}
            className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold hover:bg-neutral-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="archive-confirm"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            Archive
          </button>
        </div>
      </div>
    </div>
  );
}
