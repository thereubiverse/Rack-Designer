"use server";

import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { withMember, withAdmin } from "@/features/auth/withMember";
import type { Member } from "@/features/auth/members";
import { emailConfigured, sendEmail } from "@/lib/email";
import {
  DEVICE_COOKIE, DEVICE_COOKIE_MAX_AGE_S, CODE_TTL_MS,
  generateDeviceToken, hashDeviceToken, generateCode, deviceLabel,
  challengeState, cooldownRemainingMs,
} from "./deviceRules";
import {
  findDeviceByHash, insertPendingDevice, approveDevice, listDevicesForMember,
  deleteDevice, readChallenge, writeChallenge, bumpChallengeAttempts, clearChallenge,
  type TrustedDevice,
} from "./repository";

/** ONE refusal message everywhere a device cannot be resolved from the caller's own cookie — no
 *  detail about WHY (no cookie vs. unknown hash vs. somebody else's device), for the same reason
 *  NOT_A_MEMBER is uniform: distinguishing the cases would tell a prober which devices/ids exist. */
const NO_DEVICE = "No device to approve. Ask for a new code.";

const COOKIE_OPTS = {
  httpOnly: true as const,
  secure: true as const,
  sameSite: "lax" as const,
  maxAge: DEVICE_COOKIE_MAX_AGE_S,
  path: "/" as const,
};

/** Resolves a device the caller actually holds: from the SESSION COOKIE, never from an id read out
 *  of a form. This is the load-bearing check for the whole feature — a device id typed or guessed
 *  by an attacker resolves to nothing here, because nothing here ever looks at one. Also refuses a
 *  cookie that happens to hash to another member's device (a stale cookie, a shared machine) rather
 *  than silently acting on it. */
async function deviceFromCookie(db: SupabaseClient, memberId: string): Promise<TrustedDevice | null> {
  const jar = await cookies();
  const token = jar.get(DEVICE_COOKIE)?.value;
  if (!token) return null;
  const device = await findDeviceByHash(db, hashDeviceToken(token));
  if (!device || device.memberId !== memberId) return null;
  return device;
}

/** Sends (or resends) a challenge code for a device already confirmed to belong to `member`.
 *  Refuses inside the resend cooldown; otherwise overwrites any code in flight (writeChallenge is an
 *  upsert on the device's primary key, so this also resets attempts to 0). Shared by
 *  `startDeviceApprovalAction`, which may have just created the device, and `resendDeviceCodeAction`,
 *  which never does. */
async function issueChallenge(db: SupabaseClient, member: Member, device: TrustedDevice) {
  if (!emailConfigured()) {
    return { ok: false, error: "Email confirmation isn't set up yet. Ask an administrator." };
  }

  const existing = await readChallenge(db, device.id);
  if (existing) {
    const remaining = cooldownRemainingMs(Date.parse(existing.createdAt), Date.now());
    if (remaining > 0) {
      const secs = Math.max(1, Math.ceil(remaining / 1000));
      return { ok: false, error: `Wait ${secs} more second${secs === 1 ? "" : "s"} before asking for another code.` };
    }
  }

  const code = generateCode();
  const expiresAtIso = new Date(Date.now() + CODE_TTL_MS).toISOString();
  await writeChallenge(db, device.id, code, expiresAtIso);
  await sendEmail(member.email, "Approve this device", `Your device approval code is ${code}.`);
  return { ok: true };
}

export const startDeviceApprovalAction = withMember("device.challenge", async (member) => {
  const db = createServiceClient();
  const jar = await cookies();
  const existingToken = jar.get(DEVICE_COOKIE)?.value;

  let device: TrustedDevice | null = null;
  if (existingToken) {
    const found = await findDeviceByHash(db, hashDeviceToken(existingToken));
    // A cookie resolving to somebody ELSE's device must not silently attach a fresh challenge to
    // that other member's row — fall through and issue this member their own, new device instead.
    if (found && found.memberId === member.id) device = found;
  }

  if (!device) {
    const token = generateDeviceToken();
    const hdrs = await headers();
    const label = deviceLabel(hdrs.get("user-agent"));
    device = await insertPendingDevice(db, member.id, hashDeviceToken(token), label);
    // Set the cookie ONLY when a device was actually created here. Reusing an existing, still-valid
    // cookie must not reset its year-long expiry or rewrite an unrelated Set-Cookie header on every
    // retry — that would make "ask again" a way to keep a device alive forever by accident.
    jar.set(DEVICE_COOKIE, token, COOKIE_OPTS);
  }

  return issueChallenge(db, member, device);
});

export const resendDeviceCodeAction = withMember("device.challenge", async (member) => {
  const db = createServiceClient();
  const device = await deviceFromCookie(db, member.id);
  if (!device) return { ok: false, error: NO_DEVICE };
  return issueChallenge(db, member, device);
});

export const confirmDeviceAction = withMember("device.approve", async (member, formData: FormData) => {
  const entered = String(formData.get("code") ?? "").trim();
  const db = createServiceClient();

  // Rule 1: the device comes from the cookie, and only from the cookie. deviceFromCookie already
  // refuses a device that does not belong to `member` — nothing below ever sees one that isn't
  // both the caller's cookie AND the caller's own row.
  const device = await deviceFromCookie(db, member.id);
  if (!device) return { ok: false, error: NO_DEVICE };

  const chal = await readChallenge(db, device.id);
  if (!chal) return { ok: false, error: "Ask for a new code." };

  const state = challengeState({ expiresAtMs: Date.parse(chal.expiresAt), attempts: chal.attempts }, Date.now());
  if (state === "expired") {
    await clearChallenge(db, device.id);
    return { ok: false, error: "That code has expired. Ask for a new one." };
  }
  if (state === "spent") {
    return { ok: false, error: "Too many attempts. Ask for a new code." };
  }

  if (entered !== chal.code) {
    await bumpChallengeAttempts(db, device.id, chal.attempts + 1);
    return { ok: false, error: "That code isn't right." };
  }

  await approveDevice(db, device.id);
  // Deleted AFTER approving, not before: if approveDevice were to throw, the challenge (and its
  // attempt count) survives for a retry instead of vanishing while nothing was actually approved.
  // On the success path this also closes the replay: the code that just worked no longer exists.
  await clearChallenge(db, device.id);
  revalidatePath("/devices");
  return { ok: true as const };
});

export const revokeMyDeviceAction = withMember("device.revoke", async (member, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  const db = createServiceClient();

  // Ownership check against the DATABASE, not against an id trusted at face value — the same
  // reasoning as setMemberRoleAction reading the target member fresh rather than trusting the form.
  const mine = await listDevicesForMember(db, member.id);
  const target = mine.find((d) => d.id === id);
  if (!target) return { ok: false, error: "That device is no longer listed." };

  await deleteDevice(db, target.id);

  // If the browser's OWN cookie names the device just revoked, drop it too. Otherwise the browser
  // keeps presenting a token for a device that no longer exists — harmless (is_device_trusted finds
  // no row and refuses), but there is no reason to leave a dead cookie lying around.
  const jar = await cookies();
  const token = jar.get(DEVICE_COOKIE)?.value;
  if (token && hashDeviceToken(token) === target.tokenHash) {
    jar.delete(DEVICE_COOKIE);
  }

  revalidatePath("/devices");
  return { ok: true as const };
});

export const adminApproveDeviceAction = withAdmin("device.adminApprove", async (_admin, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "No device specified." };
  const db = createServiceClient();
  await approveDevice(db, id);
  revalidatePath("/devices");
  return { ok: true as const };
});

export const adminRevokeDeviceAction = withAdmin("device.adminRevoke", async (_admin, formData: FormData) => {
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "No device specified." };
  const db = createServiceClient();
  await deleteDevice(db, id);
  revalidatePath("/devices");
  return { ok: true as const };
});
