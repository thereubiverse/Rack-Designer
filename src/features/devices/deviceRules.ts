/** Trusted-device rules, kept PURE so they can be tested without a database, a network or a clock.
 *  Every function that cares about time takes it as an argument.
 *
 *  These deliberately mirror `src/features/profile/phoneRules.ts` rather than importing from it.
 *  The shapes are the same because that shape survived review; the constants belong to different
 *  features and coupling devices to the phone module to save twenty lines would be the worse
 *  trade. */

import { randomBytes, randomInt, createHash } from "node:crypto";

export const DEVICE_COOKIE = "ndp_device";
export const DEVICE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const RESEND_COOLDOWN_MS = 60 * 1000;
/** A member with no cookie can otherwise mint an unbounded number of pending devices — each one a
 *  fresh five-guess budget and a fresh email to them, none of which the resend cooldown catches on
 *  its own (a brand-new device has no prior challenge to be "recent"). Capping how many can be
 *  waiting on approval at once bounds all three. Kept in step with the check in
 *  startDeviceApprovalAction, the same way MAX_ATTEMPTS is kept in step with 0031's SQL. */
export const MAX_PENDING_DEVICES = 3;

/** The value stored in the member's cookie. 32 random bytes, base64url-encoded, so it is long
 *  enough to be unguessable and safe to put straight into a `Set-Cookie` header. */
export function generateDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

/** One-way digest of a device token, for storage. The stored hash is what protects members if the
 *  database is ever dumped: whoever has the dump gets this hash, not the token, and the hash alone
 *  cannot be turned back into a working device cookie. Plain SHA-256 (no per-token salt) is
 *  deliberate here — the input is already a 256-bit random token, not a guessable password, so
 *  there is nothing a salt would buy against a dictionary or rainbow-table attack. */
export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Six digits. randomInt is used rather than Math.random because it is free to use here and there
 *  is no reason to reach for the weaker one — not because this code defends anything. */
export function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const MAX_LABEL_LENGTH = 80;
const FALLBACK_LABEL = "Unknown device";

/** A human-readable guess at "which device is this", e.g. "Chrome on Mac", for a member picking a
 *  device out of a list. This is for HUMAN RECOGNITION ONLY — it is never used to identify or
 *  authenticate a device; the device token is what does that. Parsing is deliberately coarse
 *  (browser family, OS family) rather than a real user-agent parse: a rough guess is the whole
 *  requirement, and pulling in a UA-parsing library for a label nobody security-depends on would be
 *  the wrong trade. */
export function deviceLabel(userAgent: string | null | undefined): string {
  if (!userAgent) return FALLBACK_LABEL;
  const ua = userAgent.trim();
  if (!ua) return FALLBACK_LABEL;

  const browser = guessBrowser(ua);
  const os = guessOs(ua);

  let label: string;
  if (browser && os) label = `${browser} on ${os}`;
  else if (browser) label = browser;
  else if (os) label = os;
  else label = FALLBACK_LABEL;

  return label.length > MAX_LABEL_LENGTH ? label.slice(0, MAX_LABEL_LENGTH) : label;
}

/** Order matters: Edge and Opera embed "Chrome" in their UA strings, and Chrome on iOS embeds
 *  "Safari", so the more specific tokens must be checked first. */
function guessBrowser(ua: string): string | null {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return null;
}

/** Same ordering concern as guessBrowser: iOS UAs contain "Mac OS X" too, so iPhone/iPad must be
 *  checked before the generic Mac match. */
function guessOs(ua: string): string | null {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return null;
}

export type ChallengeState = "ok" | "expired" | "spent";

/** Expiry is reported ahead of spent-ness: both send the member to "ask for a new code", and the
 *  older reason is the more useful thing to tell them. */
export function challengeState(
  c: { expiresAtMs: number; attempts: number },
  nowMs: number
): ChallengeState {
  if (nowMs >= c.expiresAtMs) return "expired";
  if (c.attempts >= MAX_ATTEMPTS) return "spent";
  return "ok";
}

/** Milliseconds still to wait before another code may be sent. Zero means go ahead. This is what
 *  stops a double-clicked button costing two messages. */
export function cooldownRemainingMs(createdAtMs: number, nowMs: number): number {
  const remaining = createdAtMs + RESEND_COOLDOWN_MS - nowMs;
  return remaining > 0 ? remaining : 0;
}
