import Link from "next/link";
import { Icon } from "@iconify/react";
import type { ClientSummary } from "@/features/clients/repository";

/** The landing page: one card per client with the three numbers that say how much of that client is
 *  documented. Read-only on purpose — every action lives on the client's own page, and a dashboard
 *  that can delete things is a dashboard people are afraid to click on.
 *
 *  A SERVER component. It renders counts `listClients` already computes, so there is no state, no
 *  effect and no client bundle for what is essentially a list of links. */

/** "Devices" means every device documented for the client — the ones mounted in racks AND the ones
 *  placed on floor plans. They live in different tables and are counted separately upstream; showing
 *  only the rack ones under a plain "Devices" heading would badly understate a client whose work so
 *  far has been floor plans. */
const deviceTotal = (c: ClientSummary) => c.deviceCount + c.floorDeviceCount;

const STATS: { label: string; icon: string; of: (c: ClientSummary) => number }[] = [
  { label: "Sites", icon: "tabler:building-community", of: (c) => c.siteCount },
  { label: "Racks", icon: "tabler:server-2", of: (c) => c.rackCount },
  { label: "Devices", icon: "tabler:device-desktop", of: deviceTotal },
];

/** "1 site", "2 sites" — a dashboard that says "1 racks" looks unfinished. */
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function StatCell({ icon, label, value }: { icon: string; label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        <Icon icon={icon} width={13} height={13} />
        {label}
      </span>
      {/* Tabular figures so the three columns line up across cards however big the numbers get. */}
      <span className="text-2xl font-bold tabular-nums text-neutral-900">{value}</span>
    </div>
  );
}

export function Dashboard({ clients }: { clients: ClientSummary[] }) {
  const totals = clients.reduce(
    (t, c) => ({
      sites: t.sites + c.siteCount,
      racks: t.racks + c.rackCount,
      devices: t.devices + deviceTotal(c),
    }),
    { sites: 0, racks: 0, devices: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold text-neutral-900">Dashboard</h1>
        {clients.length > 0 && (
          <p data-testid="dashboard-totals" className="text-sm text-neutral-500">
            {plural(clients.length, "client")} · {plural(totals.sites, "site")} ·{" "}
            {plural(totals.racks, "rack")} · {plural(totals.devices, "device")}
          </p>
        )}
      </div>

      {clients.length === 0 ? (
        <div
          data-testid="dashboard-empty"
          className="rounded-2xl border border-dashed border-neutral-200 bg-white px-6 py-16 text-center"
        >
          <p className="text-sm font-medium text-neutral-900">No clients yet</p>
          <p className="mt-1 text-sm text-neutral-500">
            Add your first client to start documenting its sites and racks.
          </p>
          <Link
            href="/clients"
            className="mt-4 inline-flex h-9 items-center rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-[#376ad9]"
          >
            Go to Clients
          </Link>
        </div>
      ) : (
        <div
          data-testid="dashboard-grid"
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
        >
          {clients.map((c) => (
            // The whole card is the link — a card with one small link inside makes people hunt for
            // the hit area.
            <Link
              key={c.id}
              href={`/clients/${encodeURIComponent(c.code)}`}
              data-testid={`dashboard-client-${c.code}`}
              className="group flex flex-col gap-4 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm transition-colors hover:border-neutral-300 hover:bg-neutral-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-bold text-neutral-900">{c.name}</p>
                  <p className="mt-0.5 text-xs font-semibold uppercase tracking-wide text-neutral-400">
                    {c.code}
                  </p>
                </div>
                <Icon
                  icon="tabler:chevron-right"
                  width={18}
                  height={18}
                  className="shrink-0 text-neutral-300 transition-colors group-hover:text-neutral-500"
                />
              </div>
              <div className="grid grid-cols-3 gap-3 border-t border-neutral-100 pt-4">
                {STATS.map((s) => (
                  <StatCell key={s.label} icon={s.icon} label={s.label} value={s.of(c)} />
                ))}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
