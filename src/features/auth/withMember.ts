import "server-only";
import { getCurrentMember, NOT_A_MEMBER, type Member } from "./members";
import { satisfies, NEEDS_EDITOR, NEEDS_ADMIN, isRefusal, type Role } from "./roles";
import { redact } from "@/features/activity/redact";
import { writeEntry } from "@/features/activity/repository";
import { createTenantClient } from "@/lib/supabase/tenant";

type ActionFn<A extends unknown[], R> = (member: Member, ...args: A) => Promise<R>;
type Guarded<A extends unknown[], R> = (...args: A) => Promise<R | { ok: false; error: string }>;

interface LogOpts {
  /** Defaults to true whenever a key is given. Set false for pure reads — there is nothing to
   *  audit about looking something up, and it saves the write. */
  log?: boolean;
}

/** The first argument is usually FormData. Convert it to a plain object BEFORE redacting, dropping
 *  any value that is not a string or number — an uploaded File must never be stringified into the
 *  log. Anything else (a plain object, a bare id, undefined, ...) passes straight through: redact()
 *  already treats a non-object as "nothing to record". */
function detailsSourceFrom(args: unknown[]): unknown {
  const first = args[0];
  if (typeof FormData !== "undefined" && first instanceof FormData) {
    const out: Record<string, string | number> = {};
    for (const [field, value] of first.entries()) {
      if (typeof value === "string" || typeof value === "number") out[field] = value;
      // Anything else (a File) is dropped here, before redact ever sees it.
    }
    return out;
  }
  return first;
}

function isFailure(result: unknown): result is { ok: false; error: string } {
  return typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === false;
}

type Outcome = "ok" | "refused" | "failed";

async function logResult<A extends unknown[]>(
  key: string,
  member: Member,
  args: A,
  outcome: Outcome,
  error: string | null
): Promise<void> {
  // An outage in the audit trail must not stop a foreman saving their work — this write's failure
  // must never propagate to the caller of the wrapped action.
  try {
    // member is already resolved by the caller (withMember's wrapper) — reuse it rather than
    // resolving the membership a second time just to mint a token.
    const db = createTenantClient(member);
    await writeEntry(db, {
      actorEmail: member.email,
      actorName: member.name,
      action: key,
      memberId: member.id,
      outcome,
      details: redact(key, detailsSourceFrom(args)),
      error,
    });
  } catch (e) {
    console.error("withMember: activity log write failed", { action: key, error: e });
  }
}

/**
 * Wrap a server action so it only runs for an active member, and receives them.
 *
 * ONE wrapper rather than 54 hand-written checks. With the database on the service role, an action
 * that forgets its check is an open door with nothing behind it to catch the mistake — and the 55th
 * action is the one that forgets.
 *
 * It also FAILS CLOSED: if the membership lookup itself throws, the action does not run. A database
 * hiccup must refuse, not admit.
 *
 * This is also the seam the activity log hooks into: passing a stable `key` as the first argument
 * makes the wrapper log the outcome, once the action has resolved, to the one place that already
 * knows the actor. `key` is optional so call sites that have not been migrated yet keep compiling
 * unchanged — they simply run without an audit entry, exactly as before.
 */
export function withMember<A extends unknown[], R>(action: ActionFn<A, R>): Guarded<A, R>;
export function withMember<A extends unknown[], R>(
  key: string,
  action: ActionFn<A, R>,
  opts?: LogOpts
): Guarded<A, R>;
export function withMember<A extends unknown[], R>(
  keyOrAction: string | ActionFn<A, R>,
  maybeAction?: ActionFn<A, R>,
  opts?: LogOpts
): Guarded<A, R> {
  const hasKey = typeof keyOrAction === "string";
  const key = hasKey ? keyOrAction : null;
  const action = hasKey ? (maybeAction as ActionFn<A, R>) : keyOrAction;
  const shouldLog = key !== null && opts?.log !== false;

  return async (...args: A) => {
    let member: Member | null;
    try {
      member = await getCurrentMember();
    } catch {
      return { ok: false, error: NOT_A_MEMBER };
    }
    // No member → no entry. There is nobody to attribute it to, and actor_email is NOT NULL;
    // unattributable pokes are the middleware's business, not this table's.
    if (!member) return { ok: false, error: NOT_A_MEMBER };

    let result: R | { ok: false; error: string };
    let thrown: string | null = null;
    try {
      result = await action(member, ...args);
    } catch (e) {
      // Every action in this codebase resolves {ok:false} rather than rejecting; a rejection
      // surfaces as an unhandled error in the calling component instead of a message.
      thrown = e instanceof Error ? e.message : "Something went wrong";
      result = { ok: false, error: thrown };
    }

    // Logged AFTER the action resolves — the entry records the outcome, so it cannot be written
    // before there is one.
    if (shouldLog && key) {
      let outcome: Outcome;
      let error: string | null;
      if (thrown !== null) {
        outcome = "failed";
        error = thrown;
      } else if (isFailure(result)) {
        outcome = isRefusal(result.error) ? "refused" : "failed";
        error = result.error;
      } else {
        outcome = "ok";
        error = null;
      }
      await logResult(key, member, args, outcome, error);
    }

    return result;
  };
}

/** The same guard as withMember, plus a minimum role. Built on withMember rather than beside it, so
 *  there is still exactly ONE place that resolves the acting member — a second lookup is a second
 *  thing to get wrong. Logging lives there too, for the same reason. */
function withRole<A extends unknown[], R>(
  required: Role,
  refusal: string,
  action: ActionFn<A, R>
): Guarded<A, R>;
function withRole<A extends unknown[], R>(
  required: Role,
  refusal: string,
  key: string,
  action: ActionFn<A, R>,
  opts?: LogOpts
): Guarded<A, R>;
function withRole<A extends unknown[], R>(
  required: Role,
  refusal: string,
  keyOrAction: string | ActionFn<A, R>,
  maybeAction?: ActionFn<A, R>,
  opts?: LogOpts
): Guarded<A, R> {
  const hasKey = typeof keyOrAction === "string";
  const action = hasKey ? (maybeAction as ActionFn<A, R>) : keyOrAction;

  const roleChecked = async (member: Member, ...args: A) => {
    // Checked BEFORE the action runs, never after: a guard that refuses once the write has already
    // happened is not a guard.
    if (!satisfies(member.role, required)) return { ok: false as const, error: refusal };
    return action(member, ...args);
  };

  if (hasKey) return withMember(keyOrAction as string, roleChecked, opts);
  return withMember(roleChecked);
}

export function withEditor<A extends unknown[], R>(action: ActionFn<A, R>): Guarded<A, R>;
export function withEditor<A extends unknown[], R>(
  key: string,
  action: ActionFn<A, R>,
  opts?: LogOpts
): Guarded<A, R>;
export function withEditor<A extends unknown[], R>(
  keyOrAction: string | ActionFn<A, R>,
  maybeAction?: ActionFn<A, R>,
  opts?: LogOpts
): Guarded<A, R> {
  if (typeof keyOrAction === "string") {
    return withRole<A, R>("editor", NEEDS_EDITOR, keyOrAction, maybeAction as ActionFn<A, R>, opts);
  }
  return withRole<A, R>("editor", NEEDS_EDITOR, keyOrAction);
}

export function withAdmin<A extends unknown[], R>(action: ActionFn<A, R>): Guarded<A, R>;
export function withAdmin<A extends unknown[], R>(
  key: string,
  action: ActionFn<A, R>,
  opts?: LogOpts
): Guarded<A, R>;
export function withAdmin<A extends unknown[], R>(
  keyOrAction: string | ActionFn<A, R>,
  maybeAction?: ActionFn<A, R>,
  opts?: LogOpts
): Guarded<A, R> {
  if (typeof keyOrAction === "string") {
    return withRole<A, R>("admin", NEEDS_ADMIN, keyOrAction, maybeAction as ActionFn<A, R>, opts);
  }
  return withRole<A, R>("admin", NEEDS_ADMIN, keyOrAction);
}
