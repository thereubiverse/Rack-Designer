import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

/** The ANON-key client, backed by the request's cookies. Used ONLY to read and manage the session.
 *
 *  Every data query in this app still goes through createServiceClient — this slice gates the door,
 *  it does not move the database behind row-level security. Mixing the two up would silently change
 *  what 54 server actions can read. */
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
