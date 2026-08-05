import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Routes an unauthenticated visitor may reach. Exact match on "/login", NOT startsWith — that would
 *  also admit "/loginish" — plus one prefix for the OAuth flow.
 *
 *  WARNING: the "/auth/" prefix means ANY future route created under /auth/ is public by default.
 *  That is deliberate — the OAuth callback needs to be reachable with no session — but it is a
 *  load-bearing property of this file, not an accident: do not add anything under /auth/ that needs
 *  to be gated. */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/auth/");
}

/** Mirrors members.ts's normaliseEmail. That file carries a `server-only` import (it reaches
 *  createServiceClient) and cannot be imported here — this middleware runs on the Edge runtime. Keep
 *  these two IN STEP: if one changes how it normalises, the other must change too, or a real member
 *  with unusual email capitalisation could be wrongly treated as inactive. */
function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Looks up the signed-in email in `members`, using the SAME publishable-key client already built in
 *  `middleware` — no service-role key, which could not be used here anyway: this runs on the Edge
 *  runtime, where the `server-only` service client cannot be imported.
 *
 *  This is the ONLY thing either public role can reach in schema `public`. Migration 0027 revoked
 *  everything else and 0028 narrowed what remains to `select (email, disabled_at) on members`, for
 *  `authenticated` alone — which is the role this query runs as, because it is only ever called
 *  after `getUser()` has found a user, so the request always carries a JWT.
 *  `src/lib/supabase/grants.test.ts` fails if that ever widens.
 *
 *  Returns null (distinct from `false`) when the query itself errored, so the caller can tell "no
 *  active member" apart from "couldn't find out" and fail open on the latter. That fail-open is why
 *  a broken grant here is dangerous rather than merely annoying: the app would keep serving pages
 *  with the gate silently off, which is what the live check in the plan's Task 4 exists to catch. */
async function isActiveMember(
  supabase: ReturnType<typeof createServerClient>,
  email: string
): Promise<boolean | null> {
  const { data, error } = await supabase
    .from("members")
    .select("disabled_at")
    .eq("email", normaliseEmail(email))
    .maybeSingle();
  if (error) {
    console.error("middleware: members query failed", error);
    return null;
  }
  return data !== null && data.disabled_at === null;
}

function redirectToLogin(request: NextRequest, pathname: string): NextResponse {
  const to = request.nextUrl.clone();
  to.pathname = "/login";
  to.searchParams.set("next", pathname);
  return NextResponse.redirect(to);
}

/** Closes the app. Every route except the sign-in routes requires a session, and the intended
 *  destination is preserved so a redirected visitor lands where they were going.
 *
 *  This checks the session AND membership. A session surviving token refresh is NOT proof of current
 *  membership: revoking someone sets `members.disabled_at` but does not touch their row in
 *  `auth.users`, so `getUser()` below keeps succeeding for a revoked person forever — token refresh
 *  has nothing to do with the `members` table at all. Without the membership check that follows, a
 *  revoked person would keep loading every page indefinitely; `withMember` re-checks membership too,
 *  but it only wraps server ACTIONS, so it never runs for a plain page render. This is what actually
 *  enforces revocation for reads. */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          // Refreshed tokens have to be written onto a NEW response or they are dropped.
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    }
  );

  const { data } = await supabase.auth.getUser();
  if (!data.user) return redirectToLogin(request, pathname);

  const active = data.user.email ? await isActiveMember(supabase, data.user.email) : false;
  if (active === null) {
    // The membership query itself errored (database unreachable, misconfiguration, etc). Do NOT
    // treat that as "revoked" — allow the request through instead of locking out the entire company
    // over a transient outage. A revoked person keeping read access for the length of the outage is
    // a far smaller failure than every member being unable to read anything, and writes stay guarded
    // regardless: `withMember` performs this same check (via the service-role client) before any
    // server action runs, outage or not.
    return response;
  }
  if (!active) return redirectToLogin(request, pathname);
  return response;
}

export const config = {
  // Everything except Next's own assets and the favicon. Images and fonts do not need a session
  // check on every request, and running one would make every page load slower for no gain.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
