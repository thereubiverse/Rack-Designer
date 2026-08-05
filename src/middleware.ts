import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Mirrors deviceRules.ts's DEVICE_COOKIE. NOT imported: that module's top-level `import ... from
 *  "node:crypto"` (for hashDeviceToken, used by the server actions in actions.ts) makes `next build`
 *  fail with "Node.js module ... not supported in the Edge Runtime" the moment ANYTHING in this file
 *  is imported here, even a single unrelated string constant — Turbopack bundles the whole module,
 *  not just the referenced export. Same trade as normaliseEmail below, and the same risk: if the
 *  cookie name ever changes in deviceRules.ts, this must change with it. */
const DEVICE_COOKIE = "ndp_device";

/** The one page a member with no trusted device yet is allowed to reach: it is what LETS them
 *  approve a device. Deliberately NOT part of `isPublicPath` — an unauthenticated visitor must still
 *  be sent to /login first; this only exempts an already-authenticated, active member from the
 *  DEVICE check below. Get the two confused and either the redirect loops forever (exempt from
 *  nothing) or a stranger with no session reaches the verification page (exempt from the member
 *  check too). */
const VERIFY_DEVICE_PATH = "/verify-device";

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

function redirectToVerifyDevice(request: NextRequest, pathname: string): NextResponse {
  const to = request.nextUrl.clone();
  to.pathname = VERIFY_DEVICE_PATH;
  to.searchParams.set("next", pathname);
  return NextResponse.redirect(to);
}

/** SHA-256 hex digest of a device token, computed with the Web Crypto API rather than
 *  `deviceRules.ts`'s `hashDeviceToken` (which uses `node:crypto`'s `createHash`). `next build` flags
 *  `node:crypto` with "Node.js module ... which is not supported in the Edge Runtime" the moment
 *  anything imports it — and this file genuinely runs there, unlike deviceRules.ts's other callers
 *  (actions.ts), which are plain server actions. `crypto.subtle` is the Web Crypto API, which IS
 *  supported on the Edge runtime, and produces byte-for-byte the same digest as `createHash("sha256")`
 *  — verified directly against `hashDeviceToken`'s output. The two must never drift: this is the same
 *  hash `hashDeviceToken` writes when a device cookie is first minted in actions.ts, and the RPC below
 *  compares against that stored value. */
async function hashDeviceTokenEdge(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Asks the one yes/no question the Edge runtime is allowed to ask about a device: `is_device_trusted`
 *  (migration 0030) is a SECURITY DEFINER function, executable by `authenticated` alone, that resolves
 *  the member from `email` itself — this runs on the Edge runtime with the publishable key, which
 *  0027/0028 never gave read access to `members.id`, so the middleware has no member id to pass in
 *  even though `trusted_devices.member_id` is what the table actually keys on.
 *
 *  Returns null (distinct from `false`) when the RPC itself errored, exactly like `isActiveMember`
 *  above — so the caller can fail OPEN on "couldn't find out" without confusing it for "not trusted".
 *  Same trade as the membership check immediately above this one: a database outage must not lock out
 *  the whole company, and writes stay guarded regardless, because `withMember` performs its own checks
 *  (via the service-role client) before any server action runs, outage or not. This does not invent a
 *  second policy — it is the same one, applied to the same failure mode. */
async function isDeviceTrusted(
  supabase: ReturnType<typeof createServerClient>,
  email: string,
  tokenHash: string
): Promise<boolean | null> {
  const { data, error } = await supabase.rpc("is_device_trusted", {
    p_email: email,
    p_token_hash: tokenHash,
  });
  if (error) {
    console.error("middleware: is_device_trusted RPC failed", error);
    return null;
  }
  return data === true;
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

  // THE DEVICE GATE. A valid session and active membership are not enough: a correct password on an
  // unrecognised machine must still grant nothing. Exempt only /verify-device (see its own comment
  // above) — every other path requires a cookie that names an APPROVED device.
  if (pathname !== VERIFY_DEVICE_PATH) {
    const token = request.cookies.get(DEVICE_COOKIE)?.value;
    if (!token) return redirectToVerifyDevice(request, pathname);

    // `active` is `true` here only when data.user.email was truthy (isActiveMember's ternary above),
    // so this is safe.
    const trusted = await isDeviceTrusted(supabase, data.user.email!, await hashDeviceTokenEdge(token));
    if (trusted === false) return redirectToVerifyDevice(request, pathname);
    // trusted === true passes through; trusted === null is the RPC-error fail-open case.
  }

  return response;
}

export const config = {
  // Everything except Next's own assets and the favicon. Images and fonts do not need a session
  // check on every request, and running one would make every page load slower for no gain.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
