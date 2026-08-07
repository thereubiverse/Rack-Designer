import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import type { Member } from "@/features/auth/members";

/** Seconds of validity. PostgREST allows 30 seconds of leeway past `exp` — bisected in the spike:
 *  expired by 30s is accepted, by 31s returns PGRST303 — so the real window is 90 seconds. Long
 *  enough to outlast any single request; short enough that a token in a log is useless. */
const TOKEN_TTL_SECONDS = 60;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/** Mints the token that IS the tenant boundary.
 *
 *  This is the one place the organisation reaches the database, which is the entire point of the
 *  design: the risk moves from "each of 141 actions remembers its filter" to "this function is
 *  correct". Policies read `org_id` from these claims via current_org_id().
 *
 *  `nowSeconds` is injectable so the expiry can be asserted without freezing the clock. */
export function mintTenantToken(orgId: string, nowSeconds?: number): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("Missing SUPABASE_JWT_SECRET — cannot mint a tenant token");
  // A token with no org_id reads NOTHING, by design. That would surface as an application with no
  // data in it rather than as an error, so refuse here where the cause is still visible.
  if (!orgId) throw new Error("mintTenantToken: refusing to mint without an organisation");

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = b64url({ alg: "HS256", typ: "JWT" });
  const payload = b64url({ role: "app_tenant", org_id: orgId, iat: now, exp: now + TOKEN_TTL_SECONDS });
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

/** A Supabase client scoped to one organisation, enforced by Postgres rather than by this code.
 *
 *  Use this everywhere `createServiceClient()` was used, except the four paths that genuinely run
 *  before an organisation is known — see src/lib/supabase/serviceRoleAllowlist.test.ts, which fails
 *  if anything else imports the service client.
 *
 *  Takes only `orgId` (via `Pick`, not the full `Member`) so a caller that has an organisation but
 *  no resolved Member — settings/store.ts receives `orgId` as an explicit parameter from its own
 *  callers, not a Member — can build a token without fabricating one. Every real Member already
 *  satisfies this. */
export function createTenantClient(member: Pick<Member, "orgId">): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");

  const token = mintTenantToken(member.orgId);
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
