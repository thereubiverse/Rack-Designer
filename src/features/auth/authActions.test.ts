import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/auth", () => ({ createSessionClient: vi.fn() }));
vi.mock("./members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./members")>();
  return { ...actual, getCurrentMember: vi.fn() };
});
// Never let a unit test reach the real logAuthEvent, which would open a real Supabase service
// client (createServiceClient) and try to insert into the actual activity_log table.
vi.mock("@/features/activity/authLog", () => ({ logAuthEvent: vi.fn(async () => {}) }));
// redirect() throws in real Next.js (that's how it interrupts rendering); mirror that here so
// tests can assert it fired via `.rejects.toThrow(...)` without a real Next request context.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

import { createSessionClient } from "@/lib/supabase/auth";
import { getCurrentMember, NOT_A_MEMBER, type Member } from "./members";
import { logAuthEvent } from "@/features/activity/authLog";
import { redirect } from "next/navigation";
import { signInWithPasswordAction, signOutAction } from "./authActions";

const member: Member = {
  id: "m1",
  email: "bob@example.com",
  name: "Bob",
  authUserId: "au1",
  disabledAt: null,
  avatarPath: null,
  role: "admin",
  orgId: "00000000-0000-0000-0000-000000000001",
};

function formFor(email: string, password: string): FormData {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", password);
  return fd;
}

/** Minimal stand-in for the bits of the Supabase auth client this action touches. */
function fakeAuthClient(opts: { signInError: boolean }) {
  const signOut = vi.fn(async () => ({ error: null }));
  const signInWithPassword = vi.fn(async () =>
    opts.signInError ? { data: {}, error: { message: "Invalid login credentials" } } : { data: {}, error: null }
  );
  // Only reached by linkAuthUser on the success path; no session user means it returns without
  // touching the database, so the test stays DB-free.
  const getUser = vi.fn(async () => ({ data: { user: null } }));
  return { auth: { signInWithPassword, signOut, getUser } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(logAuthEvent).mockResolvedValue(undefined);
});

describe("signInWithPasswordAction", () => {
  it("refuses a wrong password with NOT_A_MEMBER", async () => {
    const client = fakeAuthClient({ signInError: true });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    const res = await signInWithPasswordAction(formFor("bob@example.com", "wrongpass"));

    expect(res).toEqual({ ok: false, error: NOT_A_MEMBER });
    // Load-bearing: this is what keeps the wrong-password path's timing equalised with the
    // correct-password-but-not-a-member path. An early return on `error` would still pass the
    // assertion above but would skip this call — that's the regression this line exists to catch.
    expect(getCurrentMember).toHaveBeenCalled();
  });

  it("does NOT sign out an already-signed-in user who submits a wrong password (typo must not log them out)", async () => {
    const client = fakeAuthClient({ signInError: true });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    const res = await signInWithPasswordAction(formFor("bob@example.com", "wrongpass"));

    expect(res).toEqual({ ok: false, error: NOT_A_MEMBER });
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("refuses a correct password for a non-member with the SAME message, and signs them out", async () => {
    const client = fakeAuthClient({ signInError: false });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    const res = await signInWithPasswordAction(formFor("outsider@example.com", "correctpass"));

    expect(res).toEqual({ ok: false, error: NOT_A_MEMBER });
    // Load-bearing: without this, a valid session cookie survives a "correct password, not a
    // member" sign-in, and once middleware lands that person is inside the app.
    expect(client.auth.signOut).toHaveBeenCalled();
  });

  it("signs in an active member and does NOT sign them out", async () => {
    const client = fakeAuthClient({ signInError: false });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member);

    const res = await signInWithPasswordAction(formFor("bob@example.com", "correctpass"));

    expect(res).toEqual({ ok: true });
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("gives an outsider with the right password no way to tell themselves apart from a wrong password", async () => {
    // The property under test: both refusal strings must be identical, not merely both happen to
    // read NOT_A_MEMBER today.
    const wrongPasswordClient = fakeAuthClient({ signInError: true });
    vi.mocked(createSessionClient).mockResolvedValue(wrongPasswordClient as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);
    const wrongPasswordResult = await signInWithPasswordAction(formFor("bob@example.com", "wrongpass"));

    const rightPasswordClient = fakeAuthClient({ signInError: false });
    vi.mocked(createSessionClient).mockResolvedValue(rightPasswordClient as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);
    const rightPasswordResult = await signInWithPasswordAction(formFor("outsider@example.com", "correctpass"));

    expect(wrongPasswordResult.error).toBe(rightPasswordResult.error);
  });
});

describe("signInWithPasswordAction — activity logging", () => {
  it("logs a refused sign-in with reason 'bad-credentials' for a wrong password", async () => {
    const client = fakeAuthClient({ signInError: true });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    await signInWithPasswordAction(formFor("bob@example.com", "wrongpass"));

    expect(logAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signIn",
        outcome: "refused",
        method: "password",
        email: "bob@example.com",
        reason: "bad-credentials",
      })
    );
  });

  it("logs a refused sign-in with reason 'not-a-member' for a correct password on a non-member — the SAME user-facing message either way, but a distinct recorded reason", async () => {
    const client = fakeAuthClient({ signInError: false });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    const res = await signInWithPasswordAction(formFor("outsider@example.com", "correctpass"));

    expect(res.error).toBe(NOT_A_MEMBER);
    expect(logAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signIn",
        outcome: "refused",
        method: "password",
        email: "outsider@example.com",
        reason: "not-a-member",
      })
    );
  });

  it("logs an ok sign-in for an active member, with the member's id and name", async () => {
    const client = fakeAuthClient({ signInError: false });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member);

    await signInWithPasswordAction(formFor("bob@example.com", "correctpass"));

    expect(logAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signIn",
        outcome: "ok",
        method: "password",
        email: "bob@example.com",
        memberId: "m1",
        memberName: "Bob",
      })
    );
  });

  it("load-bearing: a throwing logAuthEvent must not prevent sign-in from succeeding", async () => {
    const client = fakeAuthClient({ signInError: false });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    vi.mocked(logAuthEvent).mockRejectedValue(new Error("audit db is down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await signInWithPasswordAction(formFor("bob@example.com", "correctpass"));

    expect(res).toEqual({ ok: true });
    errSpy.mockRestore();
  });

  it("load-bearing: a throwing logAuthEvent must not prevent a refusal from being returned", async () => {
    const client = fakeAuthClient({ signInError: true });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);
    vi.mocked(logAuthEvent).mockRejectedValue(new Error("audit db is down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await signInWithPasswordAction(formFor("bob@example.com", "wrongpass"));

    expect(res).toEqual({ ok: false, error: NOT_A_MEMBER });
    errSpy.mockRestore();
  });
});

describe("signOutAction", () => {
  function fakeSignOutClient() {
    const signOut = vi.fn(async () => ({ error: null }));
    return { auth: { signOut } };
  }

  it("resolves the member BEFORE calling signOut() — once signed out there is no session left to look it up from", async () => {
    const client = fakeSignOutClient();
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    const order: string[] = [];
    vi.mocked(getCurrentMember).mockImplementation(async () => {
      order.push("resolve-member");
      return member;
    });
    vi.mocked(client.auth.signOut).mockImplementation(async () => {
      order.push("signOut");
      return { error: null };
    });

    await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");

    expect(order).toEqual(["resolve-member", "signOut"]);
  });

  it("logs BEFORE redirect() — Next implements redirect() by throwing, so anything after it never runs", async () => {
    const client = fakeSignOutClient();
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    const order: string[] = [];
    vi.mocked(logAuthEvent).mockImplementation(async () => {
      order.push("log");
    });
    vi.mocked(redirect).mockImplementation((path: unknown) => {
      order.push("redirect");
      throw new Error(`REDIRECT:${path}`);
    });

    await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");

    expect(order).toEqual(["log", "redirect"]);
    expect(logAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signOut",
        outcome: "ok",
        email: "bob@example.com",
        memberId: "m1",
        memberName: "Bob",
      })
    );
  });

  it("load-bearing: a throwing logAuthEvent must not prevent the redirect from firing", async () => {
    const client = fakeSignOutClient();
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    vi.mocked(logAuthEvent).mockRejectedValue(new Error("audit db is down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");
    expect(client.auth.signOut).toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("does not log when there is no member to attribute the sign-out to, but still redirects", async () => {
    const client = fakeSignOutClient();
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");

    expect(logAuthEvent).not.toHaveBeenCalled();
    expect(client.auth.signOut).toHaveBeenCalled();
  });

  it("load-bearing: a throwing getCurrentMember must not prevent signOut()/redirect() from completing", async () => {
    const client = fakeSignOutClient();
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockRejectedValue(new Error("members query failed"));

    await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");

    expect(client.auth.signOut).toHaveBeenCalled();
    expect(logAuthEvent).not.toHaveBeenCalled();
  });
});
