import "server-only";
import { getCurrentMember, NOT_A_MEMBER, type Member } from "./members";

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
