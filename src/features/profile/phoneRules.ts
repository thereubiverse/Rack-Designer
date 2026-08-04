/** Phone verification rules, kept PURE so they can be tested without a database, a network or a
 *  clock. Every function that cares about time takes it as an argument. */

import { randomInt } from "node:crypto";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000;

/** E.164 for the carrier. Members type `(718) 555-0142`; Twilio needs `+17185550142`.
 *
 *  Returns null rather than guessing. A wrong guess here means texting a stranger — the exact
 *  failure this feature exists to prevent — so an unconfident conversion becomes a message asking
 *  for the area code. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const explicit = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (explicit) {
    // E.164 allows at most 15 digits including the country code, and no real number is under 8.
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  // No country code given: this company works across New York, so a bare number is assumed +1 —
  // but only once it actually looks like a North American number. Without the NANP check, a UK
  // mobile typed as ten digits (no leading +44) would be texted to whatever US number the digits
  // happen to spell, and a real stranger receives it.
  if (digits.length === 10 && isValidNanp(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && isValidNanp(digits.slice(1))) return `+${digits}`;
  return null;
}

/** NANP structure: NXX-NXX-XXXX, where N is 2-9. Both the area code and the exchange code start
 *  with 2-9 in every real North American number — no area code or exchange starts with 0 or 1.
 *  This is what tells `7700900123` (a UK mobile typed without its +44, exchange "090") apart from
 *  an actual US number, instead of assuming +1 for any ten digits. */
function isValidNanp(tenDigits: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(tenDigits);
}

/** Is this the same number, ignoring how it was typed? Used to decide whether editing the field
 *  costs the member their verification — reformatting should not. */
export function sameNumber(a: string, b: string): boolean {
  const ea = toE164(a);
  const eb = toE164(b);
  if (ea && eb) return ea === eb;
  // Neither converts (or only one does): fall back to comparing what was typed, so two equally
  // unconvertible values are still recognised as unchanged.
  return a.trim() === b.trim();
}

/** Six digits. randomInt is used rather than Math.random because it is free to use here and there
 *  is no reason to reach for the weaker one — not because this code defends anything. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Milliseconds still to wait before another code may be sent. Zero means go ahead. This is what
 *  stops a double-clicked button costing two messages. */
export function cooldownRemainingMs(createdAtMs: number, nowMs: number): number {
  const remaining = createdAtMs + RESEND_COOLDOWN_MS - nowMs;
  return remaining > 0 ? remaining : 0;
}

export type PendingState = "ok" | "expired" | "spent";

/** Expiry is reported ahead of spent-ness: both send the member to "ask for a new code", and the
 *  older reason is the more useful thing to tell them. */
export function pendingState(
  p: { expiresAtMs: number; attempts: number },
  nowMs: number
): PendingState {
  if (nowMs >= p.expiresAtMs) return "expired";
  if (p.attempts >= MAX_ATTEMPTS) return "spent";
  return "ok";
}
