import { describe, it, expect, vi, beforeEach } from "vitest";

const ME = { id: "m1", email: "me@example.com", name: "Me", authUserId: "au1", disabledAt: null, avatarPath: null };

vi.mock("@/features/auth/withMember", () => ({
  withMember: (fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
}));
const serviceClient = {};
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => serviceClient }));
vi.mock("@/lib/supabase/auth", () => ({ createSessionClient: async () => ({ auth: {} }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("./sms", () => ({ smsConfigured: vi.fn(), sendSms: vi.fn() }));
vi.mock("./repository", () => ({
  readProfile: vi.fn(),
  writeProfile: vi.fn(),
  writeAvatarPath: vi.fn(),
  readPendingVerification: vi.fn(),
  writePendingVerification: vi.fn(),
  bumpVerificationAttempts: vi.fn(),
  clearPendingVerification: vi.fn(),
  markPhoneVerified: vi.fn(),
  clearPhoneVerified: vi.fn(),
}));

import { smsConfigured, sendSms } from "./sms";
import {
  readProfile, readPendingVerification, writePendingVerification,
  bumpVerificationAttempts, clearPendingVerification, markPhoneVerified,
} from "./repository";
import { sendPhoneCodeAction, confirmPhoneCodeAction } from "./actions";
import { MAX_ATTEMPTS } from "./phoneRules";

const PROFILE = {
  id: ME.id, email: ME.email, name: "Me", phone: "(718) 555-0142",
  position: "", address: "", avatarPath: null, phoneVerifiedAt: null,
};

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(smsConfigured).mockReturnValue(true);
  vi.mocked(readProfile).mockResolvedValue(PROFILE);
  vi.mocked(readPendingVerification).mockResolvedValue(null);
});

describe("sendPhoneCodeAction", () => {
  it("says so, and writes nothing, when no provider is configured", async () => {
    vi.mocked(smsConfigured).mockReturnValue(false);
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/isn't set up/i);
    expect(writePendingVerification).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("refuses a number it cannot convert, instead of texting a guess", async () => {
    vi.mocked(readProfile).mockResolvedValue({ ...PROFILE, phone: "555-0142" });
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/area code/i);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("refuses when there is no number at all", async () => {
    vi.mocked(readProfile).mockResolvedValue({ ...PROFILE, phone: "" });
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it("texts the E.164 form of the number on the profile", async () => {
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(true);
    expect(sendSms).toHaveBeenCalledTimes(1);
    const [to, body] = vi.mocked(sendSms).mock.calls[0];
    expect(to).toBe("+17185550142");
    expect(body).toMatch(/\d{6}/);
  });

  it("SENDS NO SECOND MESSAGE inside the cooldown — this one guards the bill", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue({
      memberId: ME.id, phone: "+17185550142", code: "111111", attempts: 0,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(sendSms).not.toHaveBeenCalled();
    expect(writePendingVerification).not.toHaveBeenCalled();
  });

  it("removes the pending row when the provider fails, so a retry is possible immediately", async () => {
    vi.mocked(sendSms).mockRejectedValue(new Error("provider down"));
    const res = await sendPhoneCodeAction();
    expect(res.ok).toBe(false);
    expect(clearPendingVerification).toHaveBeenCalledWith(serviceClient, ME.id);
  });
});

describe("confirmPhoneCodeAction", () => {
  const pending = (over: Partial<{ code: string; attempts: number; expiresAt: string; phone: string }> = {}) => ({
    memberId: ME.id,
    phone: over.phone ?? "+17185550142",
    code: over.code ?? "123456",
    attempts: over.attempts ?? 0,
    expiresAt: over.expiresAt ?? new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
  });

  it("refuses when nothing is pending", async () => {
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });

  it("verifies on the right code", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue(pending());
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(true);
    expect(markPhoneVerified).toHaveBeenCalledWith(serviceClient, ME.id, expect.any(String));
    expect(clearPendingVerification).toHaveBeenCalledWith(serviceClient, ME.id);
  });

  it("counts a wrong code against the attempts and does not verify", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue(pending({ attempts: 1 }));
    const res = await confirmPhoneCodeAction(form({ code: "000000" }));
    expect(res.ok).toBe(false);
    expect(bumpVerificationAttempts).toHaveBeenCalledWith(serviceClient, ME.id, 2);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });

  it("refuses a spent code even when it is correct", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue(pending({ attempts: MAX_ATTEMPTS }));
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });

  it("refuses an expired code even when it is correct", async () => {
    vi.mocked(readPendingVerification).mockResolvedValue(
      pending({ expiresAt: new Date(Date.now() - 1).toISOString() })
    );
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/expired/i);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });

  it("refuses when the profile's number changed after the code was sent", async () => {
    // Otherwise a code texted to one number could mark a DIFFERENT number verified.
    vi.mocked(readPendingVerification).mockResolvedValue(pending({ phone: "+17185550199" }));
    const res = await confirmPhoneCodeAction(form({ code: "123456" }));
    expect(res.ok).toBe(false);
    expect(markPhoneVerified).not.toHaveBeenCalled();
  });
});
