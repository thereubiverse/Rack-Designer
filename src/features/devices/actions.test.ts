import { describe, it, expect, vi, beforeEach } from "vitest";

const ME = {
  id: "me", email: "me@example.com", name: "Me",
  authUserId: "au-me", disabledAt: null, avatarPath: null, role: "viewer" as const,
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
  insertPendingDevice: vi.fn(),
  approveDevice: vi.fn(),
  listDevicesForMember: vi.fn(),
  listPendingDevices: vi.fn(),
  deleteDevice: vi.fn(),
  readChallenge: vi.fn(),
  writeChallenge: vi.fn(),
  bumpChallengeAttempts: vi.fn(),
  clearChallenge: vi.fn(),
}));

import { emailConfigured, sendEmail } from "@/lib/email";
import {
  findDeviceByHash, insertPendingDevice, approveDevice, listDevicesForMember,
  deleteDevice, readChallenge, writeChallenge, bumpChallengeAttempts, clearChallenge,
  type TrustedDevice,
} from "./repository";
import {
  startDeviceApprovalAction, confirmDeviceAction, resendDeviceCodeAction,
  revokeMyDeviceAction, adminApproveDeviceAction, adminRevokeDeviceAction,
} from "./actions";
import { DEVICE_COOKIE, hashDeviceToken, MAX_ATTEMPTS, CODE_TTL_MS, RESEND_COOLDOWN_MS } from "./deviceRules";

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

function challenge(over: Partial<{ code: string; attempts: number; expiresAt: string; createdAt: string }> = {}) {
  return {
    deviceId: "device-1",
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
  vi.mocked(bumpChallengeAttempts).mockResolvedValue(undefined);
  vi.mocked(clearChallenge).mockResolvedValue(undefined);
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
    expect(readChallenge).not.toHaveBeenCalled();
    expect(approveDevice).not.toHaveBeenCalled();
  });

  // THE core rule: a code must never approve a device belonging to somebody else, even when the
  // caller happens to hold a cookie that resolves to it (a shared machine, a stale cookie, ...).
  it("NEVER approves a device belonging to another member — this is the whole feature", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice({ memberId: "someone-else" }));
    vi.mocked(readChallenge).mockResolvedValue(challenge());
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    // Must refuse before ever consulting the challenge — the ownership check gates it, not a
    // wrong-code path that happens to also fail.
    expect(readChallenge).not.toHaveBeenCalled();
    expect(approveDevice).not.toHaveBeenCalled();
    expect(bumpChallengeAttempts).not.toHaveBeenCalled();
  });

  it("approves the caller's own device on the right code", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
    vi.mocked(readChallenge).mockResolvedValue(challenge());
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(true);
    expect(approveDevice).toHaveBeenCalledWith(db, "device-1");
  });
});

describe("confirmDeviceAction — Rule 2: wrong codes bump attempts; the sixth is refused even if correct", () => {
  beforeEach(() => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
  });

  it("bumps attempts and does not approve on a wrong code", async () => {
    vi.mocked(readChallenge).mockResolvedValue(challenge({ attempts: 1 }));
    const res = await confirmDeviceAction(form({ code: "000000" }));
    expect(res.ok).toBe(false);
    expect(bumpChallengeAttempts).toHaveBeenCalledWith(db, "device-1", 2);
    expect(approveDevice).not.toHaveBeenCalled();
  });

  it("refuses the sixth attempt even when the code is correct, and does not bump further", async () => {
    vi.mocked(readChallenge).mockResolvedValue(challenge({ attempts: MAX_ATTEMPTS, code: "123456" }));
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/too many|attempts/i);
    expect(approveDevice).not.toHaveBeenCalled();
    expect(bumpChallengeAttempts).not.toHaveBeenCalled();
  });
});

describe("confirmDeviceAction — Rule 3: an expired challenge is refused and cleared", () => {
  beforeEach(() => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
  });

  it("refuses an expired code, even the correct one, and clears the row", async () => {
    vi.mocked(readChallenge).mockResolvedValue(
      challenge({ expiresAt: new Date(Date.now() - 1).toISOString() })
    );
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expired/i);
    expect(approveDevice).not.toHaveBeenCalled();
    expect(clearChallenge).toHaveBeenCalledWith(db, "device-1");
  });
});

describe("confirmDeviceAction — Rule 5: success deletes the challenge, so it cannot be replayed", () => {
  it("clears the challenge row after approving", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
    vi.mocked(readChallenge).mockResolvedValue(challenge());
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(true);
    expect(clearChallenge).toHaveBeenCalledWith(db, "device-1");
  });

  it("refuses when there is nothing pending to confirm", async () => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
    vi.mocked(readChallenge).mockResolvedValue(null);
    const res = await confirmDeviceAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(approveDevice).not.toHaveBeenCalled();
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
    vi.mocked(readChallenge).mockResolvedValue(null);
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

describe("startDeviceApprovalAction / resendDeviceCodeAction — Rule 4: the 60-second cooldown", () => {
  beforeEach(() => {
    cookieStore.__raw.set(DEVICE_COOKIE, MY_TOKEN);
    vi.mocked(findDeviceByHash).mockResolvedValue(myDevice());
  });

  it("refuses a second send inside the cooldown window", async () => {
    vi.mocked(readChallenge).mockResolvedValue(challenge({ createdAt: new Date().toISOString() }));
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/wait/i);
    expect(writeChallenge).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("allows another send once the cooldown has elapsed", async () => {
    vi.mocked(readChallenge).mockResolvedValue(
      challenge({ createdAt: new Date(Date.now() - RESEND_COOLDOWN_MS - 1).toISOString() })
    );
    const res = await startDeviceApprovalAction();
    expect(res.ok).toBe(true);
    expect(writeChallenge).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("resendDeviceCodeAction obeys the same cooldown", async () => {
    vi.mocked(readChallenge).mockResolvedValue(challenge({ createdAt: new Date().toISOString() }));
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
    vi.mocked(readChallenge).mockResolvedValue(null);
    await startDeviceApprovalAction();
    const [, , , expiresAtIso] = vi.mocked(writeChallenge).mock.calls[0];
    const deltaMs = Date.parse(expiresAtIso) - Date.now();
    expect(deltaMs).toBeGreaterThan(CODE_TTL_MS - 5_000);
    expect(deltaMs).toBeLessThanOrEqual(CODE_TTL_MS + 5_000);
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
  it("approves a device by id", async () => {
    const res = await adminApproveDeviceAction(form({ id: "device-9" }));
    expect(res.ok).toBe(true);
    expect(approveDevice).toHaveBeenCalledWith(db, "device-9");
  });

  it("refuses without an id", async () => {
    const res = await adminApproveDeviceAction(form({}));
    expect(res.ok).toBe(false);
    expect(approveDevice).not.toHaveBeenCalled();
  });
});

describe("adminRevokeDeviceAction", () => {
  it("revokes any device by id", async () => {
    const res = await adminRevokeDeviceAction(form({ id: "device-9" }));
    expect(res.ok).toBe(true);
    expect(deleteDevice).toHaveBeenCalledWith(db, "device-9");
  });

  it("refuses without an id", async () => {
    const res = await adminRevokeDeviceAction(form({}));
    expect(res.ok).toBe(false);
    expect(deleteDevice).not.toHaveBeenCalled();
  });
});
