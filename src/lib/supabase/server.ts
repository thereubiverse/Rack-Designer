import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The service role bypasses RLS and every membership check. Auth now exists (see
// src/features/auth/), and every write path goes through withMember before it ever calls this —
// this client is the deliberate server-side escape hatch that sits behind that gate, not a
// leftover from a pre-auth phase. The `server-only` import above is a compile-time guard: it makes
// this module (and the service-role key it reaches) a build error if anything ever tries to pull it
// into a client bundle.
export function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
