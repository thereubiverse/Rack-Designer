import { redirect } from "next/navigation";
import { createTenantClient } from "@/lib/supabase/tenant";
import { getCurrentMember } from "@/features/auth/members";
import { listEntries, listActors, type ActivityFilter } from "@/features/activity/repository";
import { ActivityFeed, type ActivityFilterState } from "@/features/activity/ActivityFeed";
import { PAGE_SIZE, type FeedRow } from "@/features/activity/constants";
import { summarise } from "@/features/activity/summarise";

export const dynamic = "force-dynamic";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseOffset(v: string | string[] | undefined): number {
  const n = Number(first(v));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A filter value arrives from the URL — `?member=...`, `?from=...` — and is therefore untrusted
// input. `member_id` is a `uuid` column: passing anything else to `.eq("member_id", ...)` raises
// Postgres error 22P02 and throws out of listEntries, taking the whole server component down with
// it. An unparseable value must narrow to "no filter", not reach the database.
function parseUuid(v: string | string[] | undefined): string | undefined {
  const s = first(v);
  return s !== undefined && UUID_RE.test(s) ? s : undefined;
}

// Same reasoning as parseUuid: `from`/`to` are compared against `created_at` (a timestamp column),
// and a crafted value like "notadate" must not reach the query.
function parseDate(v: string | string[] | undefined): string | undefined {
  const s = first(v);
  return s !== undefined && DATE_RE.test(s) && Number.isFinite(Date.parse(s)) ? s : undefined;
}

/** The /activity screen: every signed-in member reads it, no role check — a foreman checking what
 *  a technician changed on site is the main use case, and gating this behind admin (like /users)
 *  would break exactly that. Middleware already turns away a visitor with no session at all; the
 *  redirect below only covers the gap where a session survives past membership being revoked.
 *
 *  Filters and pagination are read from `searchParams`, not client state, so the server does the
 *  filtering and a filtered/paginated view is a plain shareable link — see ActivityFeed. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await getCurrentMember();
  if (!member) redirect("/login");

  const sp = await searchParams;
  const memberId = parseUuid(sp.member);
  const action = first(sp.action);
  const outcome = first(sp.outcome);
  const from = parseDate(sp.from);
  const to = parseDate(sp.to);
  const offset = parseOffset(sp.offset);

  const uiFilter: ActivityFilterState = { memberId, action, outcome, from, to, offset };
  // `to` marks a calendar day in the UI (an <input type="date">); extend it to the end of that day
  // so the filter includes everything logged on it, not just entries logged at exactly midnight.
  const queryFilter: ActivityFilter = {
    memberId,
    action,
    outcome,
    from,
    to: to ? `${to}T23:59:59.999Z` : undefined,
    offset,
    limit: PAGE_SIZE,
  };

  const db = createTenantClient(member);
  const [{ entries, total }, actors] = await Promise.all([
    listEntries(db, queryFilter),
    listActors(db),
  ]);

  // summarise() runs here, on the server, so its inputs — `details` and `error`, which can carry
  // raw database error text and the details of admin actions like member.setRole — never reach the
  // "use client" ActivityFeed and are never serialised into the page payload. See FeedRow.
  const rows: FeedRow[] = entries.map((e) => ({
    id: e.id,
    actorName: e.actorName,
    actorEmail: e.actorEmail,
    summary: summarise(e),
    outcome: e.outcome,
    createdAt: e.createdAt,
  }));

  return <ActivityFeed entries={rows} total={total} actors={actors} filter={uiFilter} />;
}
