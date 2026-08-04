"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@iconify/react";
import {
  restoreClientAction,
  restoreSiteAction,
  restoreFloorAction,
} from "@/features/clients/actions";
import type { ArchiveTree } from "@/features/clients/archiveOps";

/** Settings → Archive: everything that has been archived, nested under whatever it belongs to.
 *
 *  There is deliberately NO permanent delete here. That is Slice G2, and it arrives only once this
 *  restore path has been used in anger — a destructive control on a page whose recovery path is
 *  untested is exactly what the two-slice split exists to avoid. */

/** ISO timestamp -> "27 Jul 2026". Fixed locale so the rendering does not drift between the server
 *  and the browser, which would trip React's hydration check. */
function archivedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function Row({
  testId,
  title,
  subtitle,
  parent,
  archivedAt,
  onRestore,
  busy,
}: {
  testId: string;
  title: string;
  subtitle: string;
  parent?: string;
  archivedAt: string;
  onRestore: () => void;
  busy: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className="flex items-center gap-3 border-b border-neutral-100 px-4 py-3 last:border-0"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-neutral-900">{title}</p>
        <p className="truncate text-xs text-neutral-500">
          {subtitle}
          {parent ? ` · in ${parent}` : ""}
        </p>
      </div>
      <span className="shrink-0 text-xs text-neutral-400">Archived {archivedOn(archivedAt)}</span>
      <button
        type="button"
        data-testid={`restore-${testId.replace("archived-", "")}`}
        disabled={busy}
        onClick={onRestore}
        // Every row's visible label is "Restore" — the aria-label disambiguates them for
        // screen-reader users tabbing through multiple rows, while sighted users keep the terse text.
        aria-label={`Restore ${title}`}
        className="shrink-0 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
      >
        Restore
      </button>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <h3 className="border-b border-neutral-100 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function ArchivePanel({ tree }: { tree: ArchiveTree }) {
  const router = useRouter();
  // The id currently being restored, not a plain boolean — a boolean would disable every row's
  // button while any one restore is in flight, which makes the whole list look stuck for a
  // single row's request. Tracking the id lets only that row's button disable.
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const total = tree.clients.length + tree.sites.length + tree.floors.length;

  async function run(action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, id: string) {
    setRestoringId(id);
    setError(null);
    const fd = new FormData();
    fd.set("id", id);
    const res = await action(fd);
    setRestoringId(null);
    if (!res.ok) {
      setError(res.error ?? "Restore failed");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-neutral-900">Archive</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Archived records are hidden from the app but keep all of their data. Restore one to bring
          it back exactly as it was.
        </p>
      </div>

      {error && (
        <p
          data-testid="archive-error"
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </p>
      )}

      {total === 0 ? (
        <div
          data-testid="archive-empty"
          className="rounded-2xl border border-dashed border-neutral-200 bg-white px-6 py-14 text-center"
        >
          <Icon icon="tabler:archive" width={22} height={22} className="mx-auto text-neutral-300" />
          <p className="mt-2 text-sm font-medium text-neutral-900">Nothing archived</p>
          <p className="mt-1 text-sm text-neutral-500">
            Deleting a client, site or floor archives it here instead of destroying it.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {tree.clients.length > 0 && (
            <Group title="Clients">
              {tree.clients.map((c) => (
                <Row
                  key={c.id}
                  testId={`archived-client-${c.id}`}
                  title={c.name}
                  subtitle={c.code}
                  archivedAt={c.archivedAt}
                  busy={restoringId === c.id}
                  onRestore={() => void run(restoreClientAction, c.id)}
                />
              ))}
            </Group>
          )}

          {tree.sites.length > 0 && (
            <Group title="Sites">
              {tree.sites.map((s) => (
                <Row
                  key={s.site.id}
                  testId={`archived-site-${s.site.id}`}
                  title={s.site.name}
                  subtitle={s.site.code}
                  parent={s.clientName}
                  archivedAt={s.site.archivedAt}
                  busy={restoringId === s.site.id}
                  onRestore={() => void run(restoreSiteAction, s.site.id)}
                />
              ))}
            </Group>
          )}

          {tree.floors.length > 0 && (
            <Group title="Floors">
              {tree.floors.map((f) => (
                <Row
                  key={f.floor.id}
                  testId={`archived-floor-${f.floor.id}`}
                  title={f.floor.name || f.floor.code}
                  subtitle={f.floor.code}
                  parent={`${f.siteName} · ${f.clientCode}`}
                  archivedAt={f.floor.archivedAt}
                  busy={restoringId === f.floor.id}
                  onRestore={() => void run(restoreFloorAction, f.floor.id)}
                />
              ))}
            </Group>
          )}
        </div>
      )}
    </div>
  );
}
