import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/auth", () => ({ createSessionClient: vi.fn() }));
vi.mock("./members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./members")>();
  return { ...actual, getCurrentMember: vi.fn() };
});

import { createSessionClient } from "@/lib/supabase/auth";
import { getCurrentMember, NOT_A_MEMBER, type Member } from "./members";
import { signInWithPasswordAction } from "./authActions";

const member: Member = {
  id: "m1",
  email: "bob@example.com",
  name: "Bob",
  authUserId: "au1",
  disabledAt: null,
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

beforeEach(() => vi.clearAllMocks());

describe("signInWithPasswordAction", () => {
  it("refuses a wrong password with NOT_A_MEMBER", async () => {
    const client = fakeAuthClient({ signInError: true });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    const res = await signInWithPasswordAction(formFor("bob@example.com", "wrongpass"));

    expect(res).toEqual({ ok: false, error: NOT_A_MEMBER });
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
