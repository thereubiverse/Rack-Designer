import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface ActivityEntry {
  id: string;
  actorEmail: string;
  actorName: string;
  action: string;
  memberId: string | null;
  outcome: "ok" | "refused" | "failed";
  details: Record<string, string>;
  error: string | null;
  createdAt: string;
}

export interface ActivityFilter {
  memberId?: string;
  action?: string;
  outcome?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
// A crafted request (limit: 100000) must not be able to pull the whole table in one response.
const MAX_LIMIT = 200;

function toEntry(row: {
  id: unknown;
  actor_email: unknown;
  actor_name: unknown;
  action: unknown;
  member_id: unknown;
  outcome: unknown;
  details: unknown;
  error: unknown;
  created_at: unknown;
}): ActivityEntry {
  const details =
    typeof row.details === "object" && row.details !== null && !Array.isArray(row.details)
      ? (row.details as Record<string, string>)
      : {};
  return {
    id: String(row.id),
    actorEmail: String(row.actor_email),
    actorName: String(row.actor_name ?? ""),
    action: String(row.action),
    memberId: row.member_id === null || row.member_id === undefined ? null : String(row.member_id),
    outcome: row.outcome as ActivityEntry["outcome"],
    details,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    createdAt: String(row.created_at),
  };
}

/** Written by `withMember` after every action resolves — see migration 0026. `details` must
 *  already be redacted (see redact.ts); this function does not filter it. */
export async function writeEntry(
  db: SupabaseClient, e: Omit<ActivityEntry, "id" | "createdAt">
): Promise<void> {
  const { error } = await db.from("activity_log").insert({
    member_id: e.memberId,
    actor_email: e.actorEmail,
    actor_name: e.actorName,
    action: e.action,
    outcome: e.outcome,
    details: e.details,
    error: e.error,
  });
  if (error) throw new Error(`writeEntry: ${error.message}`);
}

/** Applies only the filters actually present in `f` — an absent filter is not the same as
 *  "match everything for that column" being spelled out, it is simply not applied. Always ordered
 *  newest first, matching the `created_at desc` indexes migration 0026 created for this screen.
 *  `limit` defaults to 50 and is capped at `MAX_LIMIT` regardless of what is requested, so a
 *  crafted filter cannot pull the whole table in one response. */
export async function listEntries(
  db: SupabaseClient, f: ActivityFilter
): Promise<{ entries: ActivityEntry[]; total: number }> {
  // Number.isFinite, not `?? DEFAULT`: a NaN limit is not null or undefined, so `??` passes it
  // straight through, every Math.min/max keeps it NaN, and `.range(0, NaN)` returns ZERO rows while
  // PostgREST still reports an exact count. That renders an empty feed under a pager reading
  // "1-0 of 3" and raises no error anywhere. It happened — see constants.ts.
  const limit = Number.isFinite(f.limit)
    ? Math.min(Math.max(Math.floor(f.limit as number), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(f.offset) ? Math.max(Math.floor(f.offset as number), 0) : 0;

  let query = db.from("activity_log").select("*", { count: "exact" });
  if (f.memberId !== undefined) query = query.eq("member_id", f.memberId);
  if (f.action !== undefined) query = query.eq("action", f.action);
  if (f.outcome !== undefined) query = query.eq("outcome", f.outcome);
  if (f.from !== undefined) query = query.gte("created_at", f.from);
  if (f.to !== undefined) query = query.lte("created_at", f.to);

  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`listEntries: ${error.message}`);

  return { entries: (data ?? []).map(toEntry), total: count ?? 0 };
}

/** Distinct actors for the filter dropdown, newest-active first. Keyed by `member_id` so a member
 *  who was renamed still collapses to one entry.
 *
 *  An entry whose `member_id` is NULL (the member has since been hard-deleted — migration 0026's FK
 *  is ON DELETE SET NULL) is dropped from the dropdown rather than offered under its `actor_email`:
 *  `member_id` is a `uuid` column, so selecting an email-keyed option would send `?member=<email>`
 *  back to listEntries, which reaches `.eq("member_id", <email>)` and throws (Postgres 22P02). An
 *  option that cannot be filtered on must not be offered — the entries themselves still show up in
 *  the unfiltered feed, which is what matters.
 *
 *  Capped at a generous recent window rather than scanning the whole table — the dropdown needs
 *  "who has been active", not full historical membership. */
export async function listActors(
  db: SupabaseClient
): Promise<{ id: string; name: string; email: string }[]> {
  const RECENT_WINDOW = 5000;
  const { data, error } = await db
    .from("activity_log")
    .select("member_id, actor_name, actor_email")
    .order("created_at", { ascending: false })
    .limit(RECENT_WINDOW);
  if (error) throw new Error(`listActors: ${error.message}`);

  const seen = new Map<string, { id: string; name: string; email: string }>();
  for (const row of data ?? []) {
    if (row.member_id === null || row.member_id === undefined) continue;
    const id = String(row.member_id);
    if (!seen.has(id)) {
      seen.set(id, { id, name: String(row.actor_name ?? ""), email: String(row.actor_email) });
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email)
  );
}
