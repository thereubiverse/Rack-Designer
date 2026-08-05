// @vitest-environment node
//
// next/server's NextResponse expects the platform Headers implementation; jsdom (this project's
// default test environment) ships its own Headers that fails an `instanceof` check deep inside
// Next's helpers. Running this file under the plain node environment sidesteps that mismatch —
// same reasoning as middleware.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/supabase/auth", () => ({ createSessionClient: vi.fn() }));
vi.mock("@/features/auth/members", () => ({ getCurrentMember: vi.fn() }));
// Never let a unit test reach the real logAuthEvent, which would open a real Supabase service
// client (createServiceClient) and try to insert into the actual activity_log table.
vi.mock("@/features/activity/authLog", () => ({ logAuthEvent: vi.fn(async () => {}) }));

import { createSessionClient } from "@/lib/supabase/auth";
import { getCurrentMember } from "@/features/auth/members";
import { logAuthEvent } from "@/features/activity/authLog";
import { GET } from "./route";

const member = {
  id: "m1",
  email: "bob@example.com",
  name: "Bob",
  authUserId: "au1",
  disabledAt: null,
  avatarPath: null,
  role: "admin" as const,
};

function requestFor(query: string): Request {
  return new Request(`http://localhost:3100/auth/callback${query}`);
}

function fakeAuthClient(opts: { exchangeError?: boolean; provider?: string; email?: string }) {
  const signOut = vi.fn(async () => ({ error: null }));
  const exchangeCodeForSession = vi.fn(async () =>
    opts.exchangeError
      ? { data: { user: null, session: null }, error: { message: "invalid code" } }
      : {
          data: {
            user: {
              email: opts.email ?? "bob@example.com",
              app_metadata: opts.provider ? { provider: opts.provider } : {},
            },
            session: {},
          },
          error: null,
        }
  );
  return { auth: { exchangeCodeForSession, signOut } };
}

function locationOf(res: Response): string {
  return res.headers.get("location") ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(logAuthEvent).mockResolvedValue(undefined);
});

describe("GET /auth/callback", () => {
  it("redirects to /login?error=1 with no code, and never touches the auth client or the log", async () => {
    const res = await GET(requestFor(""));

    expect(locationOf(res)).toBe("http://localhost:3100/login?error=1");
    expect(createSessionClient).not.toHaveBeenCalled();
    expect(logAuthEvent).not.toHaveBeenCalled();
  });

  it("redirects to /login?error=1 when exchangeCodeForSession fails, and does not log — no identity was ever proven", async () => {
    const client = fakeAuthClient({ exchangeError: true });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);

    const res = await GET(requestFor("?code=bad"));

    expect(locationOf(res)).toBe("http://localhost:3100/login?error=1");
    expect(logAuthEvent).not.toHaveBeenCalled();
  });

  it("on success for an active member, logs auth.signIn ok with method read from app_metadata.provider (google)", async () => {
    const client = fakeAuthClient({ provider: "google", email: "bob@example.com" });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member as never);

    const res = await GET(requestFor("?code=good"));

    expect(locationOf(res)).toBe("http://localhost:3100/");
    expect(logAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signIn",
        outcome: "ok",
        method: "google",
        email: "bob@example.com",
        memberId: "m1",
        memberName: "Bob",
      })
    );
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("maps Supabase's 'azure' provider name to method 'azure' — the log copy layer is responsible for calling it Microsoft, not this route", async () => {
    const client = fakeAuthClient({ provider: "azure" });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member as never);

    await GET(requestFor("?code=good"));

    expect(logAuthEvent).toHaveBeenCalledWith(expect.objectContaining({ method: "azure" }));
  });

  it("omits method rather than guessing when app_metadata.provider is missing or unrecognised", async () => {
    const client = fakeAuthClient({ provider: "some-future-provider" });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member as never);

    await GET(requestFor("?code=good"));

    const call = vi.mocked(logAuthEvent).mock.calls[0][0];
    expect(call.method).toBeUndefined();
  });

  it("on success for a non-member, signs out, logs auth.signIn refused with reason 'not-a-member', and redirects to /login?error=1", async () => {
    const client = fakeAuthClient({ provider: "google", email: "outsider@example.com" });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    const res = await GET(requestFor("?code=good"));

    expect(locationOf(res)).toBe("http://localhost:3100/login?error=1");
    expect(client.auth.signOut).toHaveBeenCalled();
    expect(logAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "auth.signIn",
        outcome: "refused",
        method: "google",
        email: "outsider@example.com",
        reason: "not-a-member",
      })
    );
  });

  it("load-bearing: a throwing logAuthEvent must not prevent the ok redirect from firing", async () => {
    const client = fakeAuthClient({ provider: "google" });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(member as never);
    vi.mocked(logAuthEvent).mockRejectedValue(new Error("audit db is down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(requestFor("?code=good"));

    expect(locationOf(res)).toBe("http://localhost:3100/");
    errSpy.mockRestore();
  });

  it("load-bearing: a throwing logAuthEvent must not prevent the refused redirect from firing", async () => {
    const client = fakeAuthClient({ provider: "google" });
    vi.mocked(createSessionClient).mockResolvedValue(client as never);
    vi.mocked(getCurrentMember).mockResolvedValue(null);
    vi.mocked(logAuthEvent).mockRejectedValue(new Error("audit db is down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(requestFor("?code=good"));

    expect(locationOf(res)).toBe("http://localhost:3100/login?error=1");
    expect(client.auth.signOut).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
