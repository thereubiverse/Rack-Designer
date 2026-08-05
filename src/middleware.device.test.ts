// @vitest-environment node
//
// Same reason as middleware.test.ts: next/server's NextRequest/NextResponse need the platform
// Headers implementation, which jsdom (this project's default test environment) does not provide.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "./middleware";
import { DEVICE_COOKIE } from "./features/devices/deviceRules";

/** `middleware` reaches Supabase via @supabase/ssr's createServerClient, mocked here rather than
 *  hitting a real project — same shape as middleware.test.ts, with `rpc` added for the device check.
 *  Every test in this file gives the member an ACTIVE, session-holding identity (getUser + maybeSingle
 *  both configured to "pass"), because the device check runs only after membership already passed:
 *  these tests exist to prove the device gate on top of that, not to re-prove membership. */
const getUser = vi.fn();
const maybeSingle = vi.fn();
const rpc = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle }),
      }),
    }),
    rpc,
  })),
}));

function makeRequest(pathname: string, cookie?: string): NextRequest {
  const url = new URL(pathname, "http://localhost:3100");
  const init = cookie ? { headers: { cookie } } : undefined;
  return new NextRequest(url, init);
}

const ACTIVE_MEMBER = { email: "bob@example.com" };

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: ACTIVE_MEMBER } });
  maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
});

describe("middleware: device gate", () => {
  it("THE LOAD-BEARING TEST: a valid session with an UNAPPROVED device reaches no protected page", async () => {
    // The device cookie is present and resolves to a real, known device — just not an approved one.
    // is_device_trusted returns false for exactly this case (pending, revoked, or unknown all read
    // the same from the middleware's point of view). If this test would pass against a middleware
    // with the device check deleted, it is testing nothing: assert it lands on /verify-device, NOT
    // merely that it isn't a 200.
    rpc.mockResolvedValue({ data: false, error: null });
    const res = await middleware(makeRequest("/clients", `${DEVICE_COOKIE}=some-unapproved-token`));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/verify-device");
    expect(location.searchParams.get("next")).toBe("/clients");
  });

  it("redirects to /verify-device when there is no device cookie at all", async () => {
    const res = await middleware(makeRequest("/clients"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/verify-device");
    expect(location.searchParams.get("next")).toBe("/clients");
    // No cookie means nothing to check — the RPC must never even be called.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("passes through when the device is approved", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    const res = await middleware(makeRequest("/clients", `${DEVICE_COOKIE}=an-approved-token`));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(rpc).toHaveBeenCalledWith("is_device_trusted", {
      p_email: "bob@example.com",
      p_token_hash: expect.any(String),
    });
  });

  it("/verify-device is reachable with a session but no device (no redirect loop)", async () => {
    const res = await middleware(makeRequest("/verify-device"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    // Exempt from the DEVICE check specifically — the RPC must never run for this path.
    expect(rpc).not.toHaveBeenCalled();
  });

  it("/verify-device is NOT reachable without a session — it is exempt from the device check, not from the member check", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await middleware(makeRequest("/verify-device"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/verify-device");
  });

  it("fails CLOSED when the RPC errors, and logs it distinctly — the opposite of the membership check's trade", async () => {
    // Failing open on MEMBERSHIP prevents an outage from locking out the whole company. Failing open
    // on the DEVICE gate would reopen the exact door this feature exists to shut — and an attacker
    // who already holds valid credentials can generate the load that trips it (a statement timeout,
    // connection saturation, a 429) and walk through on the resulting error. So this gate fails
    // CLOSED: an RPC error redirects to /verify-device, exactly like a genuine "not trusted".
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    const res = await middleware(makeRequest("/clients", `${DEVICE_COOKIE}=some-token`));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/verify-device");
    expect(location.searchParams.get("next")).toBe("/clients");
    // Logged distinctly from a genuine refusal, so an operator can tell an outage apart from a
    // real "device not trusted" in the logs.
    expect(spy).toHaveBeenCalledWith("middleware: device check failed", expect.anything());
    spy.mockRestore();
  });
});
