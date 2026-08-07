import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The ANON-key client, backed by the request's cookies. Used ONLY to read and manage the session.
 *
 *  It is NOT a data client and must not become one. That sentence used to read "every data query in
 *  this app still goes through createServiceClient", which was true when this file was written and
 *  is not true now: slice 2 moved data access to `createTenantClient` (src/lib/supabase/tenant.ts),
 *  and the service client is down to the short, enforced allowlist in serviceRoleAllowlist.test.ts.
 *
 *  What has not changed is why this client is separate from both of them. It reaches PostgREST as
 *  `authenticated`, which holds almost nothing: `select (email, disabled_at) on members`, scoped by
 *  the `members_self` policy to the caller's own row (migration 0044 — this is what makes signing
 *  in work), and `execute` on `is_device_trusted`. Pointing a data read at this client would return
 *  nothing rather than erroring, which is the failure mode this whole slice is built around. */
export async function createSessionClient(): Promise<SupabaseClient> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        // Server COMPONENTS cannot set cookies; only actions and route handlers can. Supabase calls
        // this on token refresh from both, so a throw here would crash otherwise-fine page renders.
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          /* read-only context — the middleware refreshes the session instead */
        }
      },
    },
  });
}

export async function getSessionEmail(): Promise<string | null> {
  const db = await createSessionClient();
  const { data } = await db.auth.getUser();
  return data.user?.email ?? null;
}

export async function getSessionUserId(): Promise<string | null> {
  const db = await createSessionClient();
  const { data } = await db.auth.getUser();
  return data.user?.id ?? null;
}
