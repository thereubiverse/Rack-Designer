import { redirect } from "next/navigation";
import { createServiceClient } from "@/lib/supabase/server";
import { getCurrentMember } from "@/features/auth/members";
import { listEntries, listActors, type ActivityFilter } from "@/features/activity/repository";
import { ActivityFeed, type ActivityFilterState } from "@/features/activity/ActivityFeed";
import { PAGE_SIZE } from "@/features/activity/constants";

export const dynamic = "force-dynamic";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseOffset(v: string | string[] | undefined): number {
  const n = Number(first(v));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
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
  const memberId = first(sp.member);
  const action = first(sp.action);
  const outcome = first(sp.outcome);
  const from = first(sp.from);
  const to = first(sp.to);
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

  const db = createServiceClient();
  const [{ entries, total }, actors] = await Promise.all([
    listEntries(db, queryFilter),
    listActors(db),
  ]);

  return <ActivityFeed entries={entries} total={total} actors={actors} filter={uiFilter} />;
}
