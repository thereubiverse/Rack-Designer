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
