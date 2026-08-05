import { createServiceClient } from "@/lib/supabase/server";
import { writeEntry } from "./repository";
import { redact } from "./redact";

/** Sign-in and sign-out entries. These four outcomes cannot be captured in withMember: sign-in runs
 *  for somebody who is not a member yet, sign-out ends in a redirect that Next implements by
 *  throwing (the wrapper's catch would swallow it), and the OAuth callback is a route handler that
 *  never passes through the wrapper at all. See the design doc, section 1. */

export const NOT_AN_EMAIL = "(not an email address)";
/** RFC 5321's limit on a whole address. Anything longer is not a typo, it is paste. */
export const MAX_EMAIL_LENGTH = 254;

export type AuthMethod = "password" | "google" | "azure";

/** `activity_log.actor_email` is NOT NULL, and the feed renders it for any entry with no member name
 *  — which is exactly the refused-sign-in-from-an-unknown-address case this slice adds. People type
 *  passwords into email boxes, so recording the submitted value verbatim would eventually write a
 *  live credential into a table every member of the company reads.
 *
 *  So the value is recorded only if it is shaped like an address. Anything else becomes a fixed
 *  placeholder: the entry still says a refused sign-in happened and when, which is the part worth
 *  keeping.
 *
 *  KNOWN RESIDUAL, stated rather than papered over: a password that happens to look like an address
 *  (`P@ssw0rd.1`) passes this check. A shape test cannot tell those apart. It catches the ordinary
 *  cases — no `@`, no dot, whitespace, a bare word — and the alternative of storing arbitrary
 *  submitted text is strictly worse. */
export function safeActorEmail(raw: unknown): string {
  if (typeof raw !== "string") return NOT_AN_EMAIL;
  const value = raw.trim().toLowerCase();
  if (!value || value.length > MAX_EMAIL_LENGTH) return NOT_AN_EMAIL;
  // One @, something either side, a dot in the domain, no whitespace anywhere.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return NOT_AN_EMAIL;
  return value;
}

/** Never throws and never rejects. A failure to record a sign-in must not stop somebody signing in,
 *  and — for sign-out — must not stop the redirect that follows it. Same fail-open reasoning as the
 *  main log's writer. */
export async function logAuthEvent(e: {
  action: "auth.signIn" | "auth.signOut";
  outcome: "ok" | "refused";
  method: AuthMethod;
  email: unknown;
  memberId?: string | null;
  memberName?: string;
  reason?: string;
}): Promise<void> {
  try {
    await writeEntry(createServiceClient(), {
      memberId: e.memberId ?? null,
      actorEmail: safeActorEmail(e.email),
      actorName: e.memberName ?? "",
      action: e.action,
      outcome: e.outcome,
      // Through redact like every other entry, so the allowlist is the single gate on what a log
      // entry may contain — even for a call site that builds its own details.
      details: redact(e.action, { method: e.method }),
      error: e.reason ?? null,
    });
  } catch (err) {
    console.error("logAuthEvent: could not record", e.action, err);
  }
}
