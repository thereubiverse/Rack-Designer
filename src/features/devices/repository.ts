import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** A device row as the application sees it. `tokenHash` never leaves this layer for a device the
 *  caller does not already hold — actions resolve devices by hash, never hand the hash back out. */
export interface TrustedDevice {
  id: string;
  memberId: string;
  tokenHash: string;
  label: string;
  approvedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface DeviceChallenge {
  deviceId: string;
  code: string;
  attempts: number;
  expiresAt: string;
  createdAt: string;
}

function toDevice(data: Record<string, unknown>): TrustedDevice {
  return {
    id: String(data.id),
    memberId: String(data.member_id),
    tokenHash: String(data.token_hash),
    label: String(data.label ?? ""),
    approvedAt: data.approved_at === null ? null : String(data.approved_at),
    lastSeenAt: data.last_seen_at === null ? null : String(data.last_seen_at),
    createdAt: String(data.created_at),
  };
}

function toChallenge(data: Record<string, unknown>): DeviceChallenge {
  return {
    deviceId: String(data.device_id),
    code: String(data.code),
    attempts: Number(data.attempts ?? 0),
    expiresAt: String(data.expires_at),
    createdAt: String(data.created_at),
  };
}

/** Resolves a device from a cookie's hash. This is the ONLY lookup that matters for "which device is
 *  this" — nothing here or in callers ever trusts a device id supplied by the caller instead. */
export async function findDeviceByHash(db: SupabaseClient, tokenHash: string): Promise<TrustedDevice | null> {
  const { data, error } = await db
    .from("trusted_devices")
    .select("id, member_id, token_hash, label, approved_at, last_seen_at, created_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new Error(`findDeviceByHash: ${error.message}`);
  if (!data) return null;
  return toDevice(data);
}

/** Creates a new, unapproved device for a member. `approved_at` stays null until a code is
 *  confirmed — a row here grants nothing by itself. */
export async function insertPendingDevice(
  db: SupabaseClient, memberId: string, tokenHash: string, label: string
): Promise<TrustedDevice> {
  const { data, error } = await db
    .from("trusted_devices")
    .insert({ member_id: memberId, token_hash: tokenHash, label })
    .select("id, member_id, token_hash, label, approved_at, last_seen_at, created_at")
    .single();
  if (error) throw new Error(`insertPendingDevice: ${error.message}`);
  return toDevice(data);
}

export async function approveDevice(db: SupabaseClient, deviceId: string): Promise<void> {
  const { error } = await db
    .from("trusted_devices")
    .update({ approved_at: new Date().toISOString() })
    .eq("id", deviceId);
  if (error) throw new Error(`approveDevice: ${error.message}`);
}

export async function listDevicesForMember(db: SupabaseClient, memberId: string): Promise<TrustedDevice[]> {
  const { data, error } = await db
    .from("trusted_devices")
    .select("id, member_id, token_hash, label, approved_at, last_seen_at, created_at")
    .eq("member_id", memberId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listDevicesForMember: ${error.message}`);
  return (data ?? []).map(toDevice);
}

/** Every device across every member still waiting on approval — the admin queue, not a single
 *  member's list. Oldest first: the longest-waiting request is the one that most wants attention. */
export async function listPendingDevices(db: SupabaseClient): Promise<TrustedDevice[]> {
  const { data, error } = await db
    .from("trusted_devices")
    .select("id, member_id, token_hash, label, approved_at, last_seen_at, created_at")
    .is("approved_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`listPendingDevices: ${error.message}`);
  return (data ?? []).map(toDevice);
}

/** Deletes a device outright. `device_challenges` cascades (FK `on delete cascade`), so there is
 *  nothing left in flight for it afterward. */
export async function deleteDevice(db: SupabaseClient, deviceId: string): Promise<void> {
  const { error } = await db.from("trusted_devices").delete().eq("id", deviceId);
  if (error) throw new Error(`deleteDevice: ${error.message}`);
}

export async function readChallenge(db: SupabaseClient, deviceId: string): Promise<DeviceChallenge | null> {
  const { data, error } = await db
    .from("device_challenges")
    .select("device_id, code, attempts, expires_at, created_at")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (error) throw new Error(`readChallenge: ${error.message}`);
  if (!data) return null;
  return toChallenge(data);
}

/** Upsert on the primary key (`device_id`): asking for a new code REPLACES any code already in
 *  flight for this device, the same shape as `writePendingVerification` for phone. Attempts reset to
 *  0 and `created_at` moves forward, which is also what starts the resend cooldown over. */
export async function writeChallenge(
  db: SupabaseClient, deviceId: string, code: string, expiresAtIso: string
): Promise<void> {
  const { error } = await db.from("device_challenges").upsert({
    device_id: deviceId,
    code,
    attempts: 0,
    expires_at: expiresAtIso,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error(`writeChallenge: ${error.message}`);
}

export async function bumpChallengeAttempts(db: SupabaseClient, deviceId: string, attempts: number): Promise<void> {
  const { error } = await db
    .from("device_challenges").update({ attempts }).eq("device_id", deviceId);
  if (error) throw new Error(`bumpChallengeAttempts: ${error.message}`);
}

export async function clearChallenge(db: SupabaseClient, deviceId: string): Promise<void> {
  const { error } = await db.from("device_challenges").delete().eq("device_id", deviceId);
  if (error) throw new Error(`clearChallenge: ${error.message}`);
}
