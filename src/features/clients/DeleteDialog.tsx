"use client";

import { useState } from "react";
import { describeCascade, requiresTypedConfirm, type CascadeCounts } from "./validation";

const KIND_LABEL: Record<"client" | "site" | "rack" | "floor" | "room", string> = {
  client: "client",
  site: "site",
  rack: "rack",
  floor: "floor",
  room: "room",
};

/** Confirm dialog for destructive client/site/rack deletes. Spells out the cascade in plain
 *  language and, when the delete would actually destroy something, gates the destructive button
 *  behind typing the code exactly (case-sensitive) — cheap deletes (nothing cascades) skip the
 *  typing gate entirely. */
export function DeleteDialog({
  open,
  kind,
  code,
  counts,
  note,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  kind: "client" | "site" | "rack" | "floor" | "room";
  code: string;
  counts: CascadeCounts;
  note?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");

  if (!open) return null;

  const gated = requiresTypedConfirm(counts);
  const canConfirm = !gated || typed === code;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" role="dialog" aria-label={`Delete ${KIND_LABEL[kind]}`}>
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-base font-bold">Delete {KIND_LABEL[kind]} &ldquo;{code}&rdquo;?</h3>
        <p data-testid="delete-cascade" className="mt-2 text-sm text-neutral-600">
          This will permanently delete {describeCascade(counts)}.
        </p>

        {note && (
          <p data-testid="delete-note" className="mt-2 text-sm text-neutral-500">
            {note}
          </p>
        )}

        {gated && (
          <div className="mt-4">
            <label htmlFor="delete-code-input" className="block text-sm font-medium text-neutral-700">
              Type <span className="font-semibold">{code}</span> to confirm
            </label>
            <input
              id="delete-code-input"
              data-testid="delete-code-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none"
              autoComplete="off"
            />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="delete-cancel"
            onClick={onCancel}
            className="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-semibold text-neutral-700 hover:bg-neutral-50"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="delete-confirm"
            disabled={!canConfirm}
            onClick={onConfirm}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
