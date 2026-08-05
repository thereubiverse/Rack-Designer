/** Shared by the /activity server component and the client feed.
 *
 *  It lives in its own module with NO directive on purpose. It used to be exported from
 *  ActivityFeed.tsx, which carries "use client" — and a server component importing a plain constant
 *  from a client module does not get the constant. Next.js replaces that module with a client
 *  reference, so the import resolves to a proxy rather than 50, `limit` arrived as NaN, and the
 *  query asked PostgREST for the range 0-NaN. That returns zero rows while still reporting an exact
 *  count, so the page rendered "No activity yet" underneath a pager reading "1-0 of 3".
 *
 *  Nothing warned about it: the types were satisfied, no error was thrown, and every test passed
 *  because they all supply the value directly. Keep shared constants out of "use client" modules. */
export const PAGE_SIZE = 50;

/** What the client feed is allowed to see. The full `ActivityEntry` carries `details` and `error`
 *  — raw database error text, and the details of every admin action including `member.setRole` and
 *  `member.invite` — and `ActivityFeed` is a "use client" component, so passing it whole entries
 *  serialises all of that into the page payload for any signed-in member to read, whether or not
 *  the table ever renders it. The table only ever renders when/who/summary/outcome, so that is all
 *  a row carries: `summarise()` runs on the SERVER (see src/app/activity/page.tsx), and `details`/
 *  `error` never leave it.
 *
 *  Lives here, not in ActivityFeed.tsx: that module carries "use client", and the server page needs
 *  this type too — see the PAGE_SIZE note above for why a client module is the wrong home for
 *  anything a server component must import. */
export interface FeedRow {
  id: string;
  actorName: string;
  actorEmail: string;
  summary: string;
  outcome: "ok" | "refused" | "failed";
  createdAt: string;
}
