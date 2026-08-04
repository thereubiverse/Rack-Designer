import "server-only";
import { getCurrentMember, NOT_A_MEMBER, type Member } from "./members";
import { satisfies, NEEDS_EDITOR, NEEDS_ADMIN, type Role } from "./roles";

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
 * This is the seam the activity log will hook into: it already knows the actor, the action, its
 * arguments and its outcome, which is the whole content of a log entry.
 */
export function withMember<A extends unknown[], R>(
  action: (member: Member, ...args: A) => Promise<R>
): (...args: A) => Promise<R | { ok: false; error: string }> {
  return async (...args: A) => {
    let member: Member | null;
    try {
      member = await getCurrentMember();
    } catch {
      return { ok: false, error: NOT_A_MEMBER };
    }
    if (!member) return { ok: false, error: NOT_A_MEMBER };
    try {
      return await action(member, ...args);
    } catch (e) {
      // Every action in this codebase resolves {ok:false} rather than rejecting; a rejection
      // surfaces as an unhandled error in the calling component instead of a message.
      return { ok: false, error: e instanceof Error ? e.message : "Something went wrong" };
    }
  };
}

/** The same guard as withMember, plus a minimum role. Built on withMember rather than beside it, so
 *  there is still exactly ONE place that resolves the acting member — a second lookup is a second
 *  thing to get wrong. */
function withRole<A extends unknown[], R>(
  required: Role,
  refusal: string,
  action: (member: Member, ...args: A) => Promise<R>
): (...args: A) => Promise<R | { ok: false; error: string }> {
  return withMember(async (member, ...args: A) => {
    // Checked BEFORE the action runs, never after: a guard that refuses once the write has already
    // happened is not a guard.
    if (!satisfies(member.role, required)) return { ok: false as const, error: refusal };
    return action(member, ...args);
  });
}

export function withEditor<A extends unknown[], R>(
  action: (member: Member, ...args: A) => Promise<R>
) {
  return withRole<A, R>("editor", NEEDS_EDITOR, action);
}

export function withAdmin<A extends unknown[], R>(
  action: (member: Member, ...args: A) => Promise<R>
) {
  return withRole<A, R>("admin", NEEDS_ADMIN, action);
}
