import "server-only";
import { createClient } from "@supabase/supabase-js";

/** Supabase's admin invite, behind one thin wrapper so the action tests can fake it.
 *
 *  Locally the message lands in Inbucket, which this stack already runs. In production it needs SMTP,
 *  which is not configured — so this NEVER throws: it reports whether it sent, and the caller treats
 *  a failure as a warning rather than a failed invite. The members row is what grants access; the
 *  email is only a convenience for setting a password. */
export async function inviteUserByEmail(email: string): Promise<{ sent: boolean; reason?: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return { sent: false, reason: "Supabase admin credentials are not configured" };
  try {
    const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await admin.auth.admin.inviteUserByEmail(email);
    if (error) return { sent: false, reason: error.message };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : "unknown" };
  }
}
