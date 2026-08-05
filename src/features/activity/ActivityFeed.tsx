"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { actionLabel } from "./summarise";
import { LOGGED_FIELDS } from "./redact";
import { useHeaderTitle } from "@/features/shell/headerTitle";
import type { FeedRow } from "./constants";

const input = "h-9 w-full rounded-lg border border-neutral-200 px-3 text-sm focus:border-neutral-400 focus:outline-none";
const selectSm = `${input} bg-white`;

/** Every action key the platform can log, alphabetised by its human label rather than its raw key
 *  — the same allowlist redact.ts uses, reused here as the filter dropdown's contents so an action
 *  added later shows up automatically instead of needing a second list kept in sync. */
const ACTIONS = Object.keys(LOGGED_FIELDS).sort((a, b) => actionLabel(a).localeCompare(actionLabel(b)));

const OUTCOMES = ["ok", "refused", "failed"] as const;

/** How many rows the page asks the repository for. Exported so the page passes the exact same
 *  number to `listEntries({ limit })` — the two must agree, or "Next" either skips rows or repeats
 *  them. */
import { PAGE_SIZE } from "./constants";

const OUTCOME_LABEL: Record<FeedRow["outcome"], string> = {
  ok: "Succeeded",
  refused: "Refused",
  failed: "Failed",
};

// Refused reads muted on purpose — present for the record, not competing with a real (ok) change
// for attention. Failed is a genuine system error, so unlike refused it keeps a warning color.
const OUTCOME_BADGE: Record<FeedRow["outcome"], string> = {
  ok: "bg-green-50 text-green-700",
  refused: "bg-neutral-100 text-neutral-400",
  failed: "bg-red-50 text-red-700",
};

const ROW_TEXT: Record<FeedRow["outcome"], string> = {
  ok: "text-neutral-900",
  refused: "text-neutral-400",
  failed: "text-neutral-900",
};

export interface ActivityFilterState {
  memberId?: string;
  action?: string;
  outcome?: string;
  from?: string;
  to?: string;
  offset: number;
}

/** Builds the `/activity` URL for a given filter/page state. The only place that knows the query
 *  param names, so the page (which parses them back out) and every link/push here always agree. */
function buildHref(filter: ActivityFilterState): string {
  const params = new URLSearchParams();
  if (filter.memberId) params.set("member", filter.memberId);
  if (filter.action) params.set("action", filter.action);
  if (filter.outcome) params.set("outcome", filter.outcome);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.offset) params.set("offset", String(filter.offset));
  const qs = params.toString();
  return qs ? `/activity?${qs}` : "/activity";
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** The /activity screen: one row per logged action, newest first. Every signed-in member can read
 *  it — no role check, deliberately (see the page this is rendered from) — so a foreman can check
 *  what a technician changed on site without needing admin access.
 *
 *  Filters (member, action, outcome, date range) and pagination (`offset`) live entirely in the
 *  URL via `filter`, never in component state: `entries`/`total` arrive already filtered by the
 *  server, and every control here just navigates to a new `/activity?...` — so a filtered view is
 *  a link that can be copied and shared, and reloading never loses it. Changing any filter other
 *  than the page itself resets `offset` back to 0 — otherwise "page 3 of Jane's actions" could
 *  land past the end of a much shorter filtered list and render nothing. */
export function ActivityFeed({
  entries,
  total,
  actors,
  filter,
}: {
  entries: FeedRow[];
  total: number;
  actors: { id: string; name: string; email: string }[];
  filter: ActivityFilterState;
}) {
  useHeaderTitle("Activity");
  const router = useRouter();

  function setFilter(partial: Partial<Omit<ActivityFilterState, "offset">>) {
    router.push(buildHref({ ...filter, ...partial, offset: 0 }));
  }

  const hasFilters = Boolean(filter.memberId || filter.action || filter.outcome || filter.from || filter.to);
  const rangeStart = total === 0 ? 0 : filter.offset + 1;
  const rangeEnd = Math.min(filter.offset + entries.length, total);
  const hasPrev = filter.offset > 0;
  const hasNext = filter.offset + entries.length < total;

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-lg font-bold text-neutral-900">Activity</h2>
          {hasFilters && (
            <Link
              href="/activity"
              data-testid="clear-filters"
              className="text-sm font-semibold text-blue-700 hover:underline"
            >
              Clear filters
            </Link>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3 border-b border-neutral-200 bg-neutral-50/60 px-5 py-3">
          <label className="block text-[11px] font-semibold text-neutral-600">
            Member
            <select
              data-testid="filter-member"
              aria-label="Filter by member"
              value={filter.memberId ?? ""}
              onChange={(e) => setFilter({ memberId: e.target.value || undefined })}
              className={`${selectSm} mt-1 block`}
            >
              <option value="">All members</option>
              {actors.map((a) => (
                <option key={a.id} value={a.id}>{a.name || a.email}</option>
              ))}
            </select>
          </label>

          <label className="block text-[11px] font-semibold text-neutral-600">
            Action
            <select
              data-testid="filter-action"
              aria-label="Filter by action"
              value={filter.action ?? ""}
              onChange={(e) => setFilter({ action: e.target.value || undefined })}
              className={`${selectSm} mt-1 block`}
            >
              <option value="">All actions</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>{actionLabel(a)}</option>
              ))}
            </select>
          </label>

          <label className="block text-[11px] font-semibold text-neutral-600">
            Outcome
            <select
              data-testid="filter-outcome"
              aria-label="Filter by outcome"
              value={filter.outcome ?? ""}
              onChange={(e) => setFilter({ outcome: e.target.value || undefined })}
              className={`${selectSm} mt-1 block`}
            >
              <option value="">All outcomes</option>
              {OUTCOMES.map((o) => (
                <option key={o} value={o}>{OUTCOME_LABEL[o]}</option>
              ))}
            </select>
          </label>

          <label className="block text-[11px] font-semibold text-neutral-600">
            From
            <input
              type="date"
              data-testid="filter-from"
              aria-label="From date"
              value={filter.from ?? ""}
              onChange={(e) => setFilter({ from: e.target.value || undefined })}
              className={`${input} mt-1`}
            />
          </label>

          <label className="block text-[11px] font-semibold text-neutral-600">
            To
            <input
              type="date"
              data-testid="filter-to"
              aria-label="To date"
              value={filter.to ?? ""}
              onChange={(e) => setFilter({ to: e.target.value || undefined })}
              className={`${input} mt-1`}
            />
          </label>
        </div>

        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-y border-neutral-200 bg-neutral-50">
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">When</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Who</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">What</th>
              <th className="px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((row) => (
              <tr
                key={row.id}
                data-testid={`activity-row-${row.id}`}
                className="border-b border-neutral-100 transition-colors last:border-0 hover:bg-neutral-50"
              >
                <td className={`px-5 py-3 ${ROW_TEXT[row.outcome]}`}>{formatWhen(row.createdAt)}</td>
                <td className={`px-5 py-3 ${ROW_TEXT[row.outcome]}`}>{row.actorName || row.actorEmail}</td>
                <td className={`px-5 py-3 ${ROW_TEXT[row.outcome]}`}>{row.summary}</td>
                <td className="px-5 py-3">
                  <span
                    data-testid={`outcome-badge-${row.id}`}
                    className={`rounded-full px-2 py-0.5 text-xs font-semibold ${OUTCOME_BADGE[row.outcome]}`}
                  >
                    {OUTCOME_LABEL[row.outcome]}
                  </span>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td data-testid="activity-empty" colSpan={4} className="px-5 py-14 text-center text-sm text-neutral-400">
                  {hasFilters ? "No activity matches these filters" : "No activity yet"}
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-sm text-neutral-500">
            {total === 0 ? "0 results" : `${rangeStart}–${rangeEnd} of ${total}`}
          </span>
          <div className="flex gap-2">
            {hasPrev ? (
              <Link
                data-testid="page-prev"
                href={buildHref({ ...filter, offset: Math.max(0, filter.offset - PAGE_SIZE) })}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-semibold hover:bg-neutral-100"
              >
                Previous
              </Link>
            ) : (
              <span className="rounded-lg border border-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-300">
                Previous
              </span>
            )}
            {hasNext ? (
              <Link
                data-testid="page-next"
                href={buildHref({ ...filter, offset: filter.offset + PAGE_SIZE })}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-semibold hover:bg-neutral-100"
              >
                Next
              </Link>
            ) : (
              <span className="rounded-lg border border-neutral-100 px-3 py-1.5 text-sm font-semibold text-neutral-300">
                Next
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
