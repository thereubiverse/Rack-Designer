import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Routes an unauthenticated visitor may reach. Exact matches and one prefix, NOT startsWith on
 *  "/login" — that would also admit "/loginish". */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname === "/auth/callback" || pathname.startsWith("/auth/");
}

/** Closes the app. Every route except the sign-in routes requires a session, and the intended
 *  destination is preserved so a redirected visitor lands where they were going.
 *
 *  This checks the SESSION only, not membership: the session cannot exist without having passed the
 *  membership gate at sign-in, and hitting the database on every request for every asset would be a
 *  poor trade. Server actions re-check membership properly via withMember. */
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
  if (!data.user) {
    const to = request.nextUrl.clone();
    to.pathname = "/login";
    to.searchParams.set("next", pathname);
    return NextResponse.redirect(to);
  }
  return response;
}

export const config = {
  // Everything except Next's own assets and the favicon. Images and fonts do not need a session
  // check on every request, and running one would make every page load slower for no gain.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
