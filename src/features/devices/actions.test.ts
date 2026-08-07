import { describe, it, expect, vi, beforeEach } from "vitest";

const MY_ORG = "org-mine";

const ME = {
  id: "me", email: "me@example.com", name: "Me",
  authUserId: "au-me", disabledAt: null, avatarPath: null, role: "viewer" as const,
  orgId: MY_ORG,
};

// Transparent wrappers injecting OUR member, exactly like users/actions.test.ts and
// phoneActions.test.ts — the guard itself is tested elsewhere; here we test what the actions DO.
vi.mock("@/features/auth/withMember", () => ({
  withMember: (_key: string, fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
  withAdmin: (_key: string, fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
}));

const db = {};
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/email", () => ({
  emailConfigured: vi.fn(),
  sendEmail: vi.fn(),
}));

// A fake cookie jar and header store, built with vi.hoisted so the vi.mock factory (hoisted above
// regular top-level code) can close over them.
const { cookieStore, headerStore } = vi.hoisted(() => {
  const cookies = new Map<string, string>();
  return {
    cookieStore: {
      get: vi.fn((name: string) => {
        const v = cookies.get(name);
        return v === undefined ? undefined : { name, value: v };
      }),
      set: vi.fn((name: string, value: string, _opts?: Record<string, unknown>) => {
        cookies.set(name, value);
      }),
      delete: vi.fn((name: string) => {
        cookies.delete(name);
      }),
      __raw: cookies,
    },
    headerStore: {
      get: vi.fn((_name: string) => null as string | null),
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => headerStore,
}));

vi.mock("./repository", () => ({
  findDeviceByHash: vi.fn(),
  findDeviceInOrg: vi.fn(),
  insertPendingDevice: vi.fn(),
  approveDevice: vi.fn(),
  listDevicesForMember: vi.fn(),
  listPendingDevices: vi.fn(),
  deleteDevice: vi.fn(),
  writeChallenge: vi.fn(),
  clearChallenge: vi.fn(),
  consumeDeviceAttempt: vi.fn(),
  countPendingDevicesForMember: vi.fn(),
  mostRecentChallengeForMember: vi.fn(),
}));

import { emailConfigured, sendEmail } from "@/lib/email";
import {
  findDeviceByHash, findDeviceInOrg, insertPendingDevice, approveDevice, listDevicesForMember,
  deleteDevice, writeChallenge, clearChallenge, consumeDeviceAttempt,
  countPendingDevicesForMember, mostRecentChallengeForMember,
  type TrustedDevice, type ConsumedAttempt,
} from "./repository";
import {
  startDeviceApprovalAction, confirmDeviceAction, resendDeviceCodeAction,
  revokeMyDeviceAction, adminApproveDeviceAction, adminRevokeDeviceAction,
} from "./actions";
import { DEVICE_COOKIE, hashDeviceToken, CODE_TTL_MS, RESEND_COOLDOWN_MS, MAX_PENDING_DEVICES } from "./deviceRules";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const MY_TOKEN = "my-token-value";
const MY_HASH = hashDeviceToken(MY_TOKEN);

function myDevice(over: Partial<TrustedDevice> = {}): TrustedDevice {
  return {
    id: "device-1", memberId: ME.id, tokenHash: MY_HASH, label: "Chrome on Mac",
    approvedAt: null, lastSeenAt: null, createdAt: new Date().toISOString(),
    ...over,
  };
}

/** What `consume_device_attempt` (migration 0031) returns when it DID touch a row: the caller
 *  decides everything from this, never from a separate read. */
function consumedAttempt(over: Partial<ConsumedAttempt> = {}): ConsumedAttempt {
  return {
    code: over.code ?? "123456",
    expiresAt: over.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    attempts: over.attempts ?? 1,
  };
}

/** A member's most-recent challenge, as `mostRecentChallengeForMember` returns it — used only for
 *  the resend cooldown, so `deviceId` may name a device OTHER than the one currently in play. */
function memberChallenge(over: Partial<{ deviceId: string; code: string; attempts: number; expiresAt: string; createdAt: string }> = {}) {
  return {
    deviceId: over.deviceId ?? "device-1",
    code: over.code ?? "123456",
    attempts: over.attempts ?? 0,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    createdAt: over.createdAt ?? new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.__raw.clear();
  headerStore.get.mockReturnValue(null);
  vi.mocked(emailConfigured).mockReturnValue(true);
  vi.mocked(sendEmail).mockResolvedValue({ sent: true });
  vi.mocked(insertPendingDevice).mockResolvedValue(myDevice());
  vi.mocked(approveDevice).mockResolvedValue(undefined);
  vi.mocked(deleteDevice).mockResolvedValue(undefined);
  vi.mocked(writeChallenge).mockResolvedValue(undefined);
  vi.mocked(clearChallenge).mockResolvedValue(undefined);
  // Defaults that make the OTHER critical fix invisible unless a test deliberately exercises it:
  // plenty of headroom on the pending-device cap, and no recent challenge to collide with.
  vi.mocked(countPendingDevicesForMember).mockResolvedValue(0);
  vi.mocked(mostRecentChallengeForMember).mockResolvedValue(null);
});

describe("confirmDeviceAction — Rule 1: resolved from the cookie, never from an id", () => {
  it("refuses when there is no device cookie at all", async () => {
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(findDeviceByHash).not.toHaveBeenCalled();
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("refuses when the cookie matches no device", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(null);
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(consumeDeviceAttempt).not.toHaveBeenCalled();
    expect(approveDevice).not.toHaveBeenCalled();
  });

  // THE core rule: a code must never approve a device belonging to somebody else, even when the
  // caller happens to hold a cookie that resolves to it (a shared machine, a stale cookie, ...).
  it("NEVER approves a device belonging to another member — this is the whole feature", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice({ memberId: "someone-else" }));
    vi.mocked(consumeDeviceAttempt).mockResolvedValue(consumedAttempt());
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    // Must refuse before ever consulting an attempt — the ownership check gates it, not a
    // wrong-code path that happens to also fail.
    expect(consumeDeviceAttempt).not.toHaveBeenCalled();
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("approves the caller's own device on the right code", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
    vi.mocked(consumeDeviceAttempt).mockResolvedValue(consumedAttempt({ code: "123456" }));
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(true);
    expect(approveDevice).toHaveBeenCalledWith(db, "device-1");
  });
});

describe("confirmDeviceAction — Critical fix (migration 0031): the decision comes from consume_device_attempt's RETURN VALUE, never from a prior read", () => {
  beforeEach(() => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
  });

  // Regression test for the exact bug: the old code read the challenge, decided "spent" in
  // JavaScript from that read, and only THEN wrote an absolute attempts value — a race where a
  // thousand concurrent callers all read attempts = 0 and all collapsed into one write of
  // attempts = 1. Against this fix, "no row returned" is the ONLY signal the action is allowed to
  // act on, and it must refuse without ever looking at what code was submitted.
  it("refuses and never compares the submitted code when consume_device_attempt returns no row", async () => {
    vi.mocked(consumeDeviceAttempt).mockResolvedValue(null);
    // Entered value is irrelevant here on purpose — even the value that WOULD have been the right
    // code (as used by sibling tests) must not matter once no row came back.
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expired|too many|attempts/i);
    expect(consumeDeviceAttempt).toHaveBeenCalledWith(db, "device-1");
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("a wrong code still consumes the attempt — the RPC is called (and the attempt counted) before the code is ever compared", async () => {
    // consume_device_attempt has ALREADY incremented attempts by the time it returns this row —
    // that is the whole point of making it one atomic statement instead of read-then-write.
    vi.mocked(consumeDeviceAttempt).mockResolvedValue(consumedAttempt({ code: "123456", attempts: 3 }));
    const res = await confirmDeviceAction(form({ code: "000000" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/isn't right/i);
    expect(consumeDeviceAttempt).toHaveBeenCalledWith(db, "device-1");
    expect(consumeDeviceAttempt).toHaveBeenCalledTimes(1);
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("refuses when there is nothing pending to confirm (no challenge row for consume_device_attempt to touch)", async () => {
    vi.mocked(consumeDeviceAttempt).mockResolvedValue(null);
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(approveDevice).not.toHaveBeenCalled();
  });
});

describe("confirmDeviceAction — Rule 5: success deletes the challenge, so it cannot be replayed", () => {
  it("clears the challenge row after approving", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
    vi.mocked(consumeDeviceAttempt).mockResolvedValue(consumedAttempt({ code: "123456" }));
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(true);
    expect(clearChallenge).toHaveBeenCalledWith(db, "device-1");
  });
});

describe("startDeviceApprovalAction — Rule 4: the cookie is set only when a device is created", () => {
  it("creates a device and sets the cookie when there is none yet", async () => {
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(true);
    expect(insertPendingDevice).toHaveBeenCalledTimes(1);
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
    const [name, value, opts] = cookieStore.set.mock.calls[0];
    expect(name).toBe(DEVICE_COOKIE);
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(0);
    expect(opts).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/" });
  });

  it("does NOT create a device or rewrite the cookie when a valid one already exists", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(true);
    expect(insertPendingDevice).not.toHaveBeenCalled();
    expect(cookieStore.set).not.toHaveBeenCalled();
  });

  it("does not trust a cookie that resolves to somebody else's device — creates a new one instead", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice({ memberId: "someone-else" }));
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(true);
    expect(insertPendingDevice).toHaveBeenCalledTimes(1);
    expect(cookieStore.set).toHaveBeenCalledTimes(1);
  });

  it("sends the code by email once the device is resolved", async () => {
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(true);
    expect(writeChallenge).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(ME.email, expect.any(String), expect.stringMatching(/\d{6}/));
  });
});

describe("startDeviceApprovalAction — Critical fix: MAX_PENDING_DEVICES caps pending devices per member", () => {
  it("still creates a device when fewer than MAX_PENDING_DEVICES are pending", async () => {
    vi.mocked(countPendingDevicesForMember).mockResolvedValue(MAX_PENDING_DEVICES - 1);
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(true);
    expect(insertPendingDevice).toHaveBeenCalledTimes(1);
  });

  // Regression test for the exact defect: a script that never returns the Set-Cookie looked like a
  // brand-new device on every request, so nothing capped how many pending rows, emails, or
  // independent five-guess budgets one member could accumulate. This asserts the refusal happens
  // BEFORE either side effect, not merely that the end state looks capped.
  it("refuses a device beyond MAX_PENDING_DEVICES without inserting a row or sending an email", async () => {
    vi.mocked(countPendingDevicesForMember).mockResolvedValue(MAX_PENDING_DEVICES);
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(false);
    expect(insertPendingDevice).not.toHaveBeenCalled();
    expect(writeChallenge).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("counts pending devices for the calling member specifically", async () => {
    vi.mocked(countPendingDevicesForMember).mockResolvedValue(0);
    await startDeviceApprovalAction();
    expect(countPendingDevicesForMember).toHaveBeenCalledWith(db, ME.id);
  });
});

describe("startDeviceApprovalAction / resendDeviceCodeAction — Rule 4 & Critical fix: the 60-second cooldown is keyed on the MEMBER, not the device", () => {
  beforeEach(() => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
  });

  it("refuses a second send inside the cooldown window", async () => {
    vi.mocked(mostRecentChallengeForMember).mockResolvedValue(memberChallenge({ createdAt: new Date().toISOString() }));
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wait/i);
    expect(writeChallenge).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("allows another send once the cooldown has elapsed", async () => {
    vi.mocked(mostRecentChallengeForMember).mockResolvedValue(
      memberChallenge({ createdAt: new Date(Date.now() - RESEND_COOLDOWN_MS - 1).toISOString() })
    );
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(true);
    expect(writeChallenge).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("resendDeviceCodeAction obeys the same cooldown", async () => {
    vi.mocked(mostRecentChallengeForMember).mockResolvedValue(memberChallenge({ createdAt: new Date().toISOString() }));
    const res = await resendDeviceCodeAction();
    expect(res.ok).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("resendDeviceCodeAction refuses outright when there is no device to resend for", async () => {
    cookieStore.__raw.clear();
    const res = await resendDeviceCodeAction();
    expect(res.ok).toBe(false);
    expect(writeChallenge).not.toHaveBeenCalled();
  });

  it("refuses when email is not configured, without writing a challenge", async () => {
    vi.mocked(emailConfigured).mockReturnValue(false);
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(false);
    expect(writeChallenge).not.toHaveBeenCalled();
  });

  it("uses a fresh expiry roughly CODE_TTL_MS out when writing a new challenge", async () => {
    await startDeviceApprovalAction();
    const [, , , expiresAtIso] = vi.mocked(writeChallenge).mock.calls[0];
    const deltaMs = Date.parse(expiresAtIso) - Date.now();
    expect(deltaMs).toBeGreaterThan(CODE_TTL_MS - 5_000);
    expect(deltaMs).toBeLessThanOrEqual(CODE_TTL_MS + 5_000);
  });

  // Regression test for the exact defect: a brand-new device has no challenge of its OWN yet, so
  // keying the cooldown on device.id (the old shape) let it through no matter how recently the
  // member had been sent a code for a DIFFERENT device. This is the case that actually matters —
  // scripting a fresh "device" was exactly how the cooldown got bypassed.
  it("refuses a brand-new device's first send when the MEMBER has a recent challenge tied to a different device", async () => {
    cookieStore.__raw.clear(); // no cookie: startDeviceApprovalAction will create a brand-new device
    vi.mocked(mostRecentChallengeForMember).mockResolvedValue(
      memberChallenge({ deviceId: "some-other-device-entirely", createdAt: new Date().toISOString() })
    );
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wait/i);
    expect(writeChallenge).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("checks the cooldown for the calling member specifically", async () => {
    await startDeviceApprovalAction();
    expect(mostRecentChallengeForMember).toHaveBeenCalledWith(db, ME.id);
  });
});

describe("revokeMyDeviceAction", () => {
  it("revokes one of the caller's own devices", async () => {
    vi.mocked(listDevicesForMember).mockResolvedValue([myDevice({ id: "device-1" })]);
    const res = await revokeMyDeviceAction(form({ id: "device-1" }));
    expect(res.ok).toBe(true);
    expect(deleteDevice).toHaveBeenCalledWith(db, "device-1");
  });

  it("refuses to revoke a device not on the caller's own list", async () => {
    vi.mocked(listDevicesForMember).mockResolvedValue([myDevice({ id: "device-1" })]);
    const res = await revokeMyDeviceAction(form({ id: "someone-elses-device" }));
    expect(res.ok).toBe(false);
    expect(deleteDevice).not.toHaveBeenCalled();
  });

  it("clears the browser's own cookie when it names the device just revoked", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(listDevicesForMember).mockResolvedValue([myDevice({ id: "device-1", tokenHash: MY_HASH })]);
    const res = await revokeMyDeviceAction(form({ id: "device-1" }));
    expect(res.ok).toBe(true);
    expect(cookieStore.delete).toHaveBeenCalledWith(DEVICE_COOKIE);
  });

  it("leaves an unrelated cookie alone when revoking a different device", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(listDevicesForMember).mockResolvedValue([
      myDevice({ id: "device-1", tokenHash: MY_HASH }),
      myDevice({ id: "device-2", tokenHash: "some-other-hash" }),
    ]);
    const res = await revokeMyDeviceAction(form({ id: "device-2" }));
    expect(res.ok).toBe(true);
    expect(cookieStore.delete).not.toHaveBeenCalled();
  });
});

describe("adminApproveDeviceAction", () => {
  it("approves a device in the admin's own organisation", async () => {
    vi.mocked(findDeviceInOrg).mockResolvedValue(myDevice({ id: "device-9" }));
    const res = await adminApproveDeviceAction(form({ id: "device-9" }));
    expect(res.ok).toBe(true);
    expect(findDeviceInOrg).toHaveBeenCalledWith(db, "device-9", MY_ORG);
    expect(approveDevice).toHaveBeenCalledWith(db, "device-9");
  });

  // The scenario the whole slice gates on: an admin of one organisation posting a device id read
  // out of another organisation's row. findDeviceInOrg resolves null (the id exists, but not in
  // MY_ORG) and NOTHING must be approved — there is no row-level security under this path to catch
  // it, because trusted_devices is ungranted to app_tenant on purpose.
  it("refuses a device belonging to another organisation", async () => {
    vi.mocked(findDeviceInOrg).mockResolvedValue(null);
    const res = await adminApproveDeviceAction(form({ id: "other-orgs-device" }));
    expect(res.ok).toBe(false);
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("refuses without an id", async () => {
    const res = await adminApproveDeviceAction(form({}));
    expect(res.ok).toBe(false);
    expect(findDeviceInOrg).not.toHaveBeenCalled();
    expect(approveDevice).not.toHaveBeenCalled();
  });
});

describe("adminRevokeDeviceAction", () => {
  it("revokes a device in the admin's own organisation", async () => {
    vi.mocked(findDeviceInOrg).mockResolvedValue(myDevice({ id: "device-9" }));
    const res = await adminRevokeDeviceAction(form({ id: "device-9" }));
    expect(res.ok).toBe(true);
    expect(findDeviceInOrg).toHaveBeenCalledWith(db, "device-9", MY_ORG);
    expect(deleteDevice).toHaveBeenCalledWith(db, "device-9");
  });

  it("refuses a device belonging to another organisation", async () => {
    vi.mocked(findDeviceInOrg).mockResolvedValue(null);
    const res = await adminRevokeDeviceAction(form({ id: "other-orgs-device" }));
    expect(res.ok).toBe(false);
    expect(deleteDevice).not.toHaveBeenCalled();
  });

  it("refuses without an id", async () => {
    const res = await adminRevokeDeviceAction(form({}));
    expect(res.ok).toBe(false);
    expect(findDeviceInOrg).not.toHaveBeenCalled();
    expect(deleteDevice).not.toHaveBeenCalled();
  });
});
