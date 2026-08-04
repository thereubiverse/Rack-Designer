// @vitest-environment node
//
// next/server's NextRequest/NextResponse expect the platform Headers implementation; jsdom (this
// project's default test environment) ships its own Headers that fails an `instanceof` check deep
// inside Next's middleware helpers. Running this file under the plain node environment sidesteps
// that mismatch without touching the global vitest config.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { isPublicPath, middleware } from "./middleware";

describe("isPublicPath", () => {
  it("lets an unauthenticated visitor reach the login page and the OAuth callback", () => {
    expect(isPublicPath("/login")).toBe(true);
    expect(isPublicPath("/auth/callback")).toBe(true);
  });

  it("protects everything else", () => {
    for (const p of ["/", "/clients", "/clients/URI/HQ", "/settings", "/settings/archive", "/device-library"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });

  it("does not let a lookalike path through", () => {
    // "/loginish" and "/auth-ish" must NOT be treated as the login routes.
    expect(isPublicPath("/loginish")).toBe(false);
    expect(isPublicPath("/authx/callback")).toBe(false);
  });
});

// `middleware` reaches out to Supabase via @supabase/ssr's createServerClient, so that module is
// mocked here rather than hitting a real project. `getUser` and `maybeSingle` are shared mocks that
// each test configures; `.from().select().eq()` is a fixed chain because the middleware only ever
// queries `members` that one way.
const getUser = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle }),
      }),
    }),
  })),
}));

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, "http://localhost:3100"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("middleware", () => {
  it("redirects to /login and preserves the original path in ?next= when there is no session", async () => {
    getUser.mockResolvedValue({ data: { user: null } });
    const res = await middleware(makeRequest("/clients"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("next")).toBe("/clients");
    // A logged-out visitor never reaches the membership query at all.
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("redirects a revoked member (disabled_at set) to /login — this is the Critical fix", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "bob@example.com" } } });
    maybeSingle.mockResolvedValue({ data: { disabled_at: "2026-08-01T00:00:00Z" }, error: null });
    const res = await middleware(makeRequest("/clients"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
  });

  it("passes through an authenticated, active member with no redirect", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "bob@example.com" } } });
    maybeSingle.mockResolvedValue({ data: { disabled_at: null }, error: null });
    const res = await middleware(makeRequest("/clients"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("passes through rather than locking everyone out when the membership query errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    getUser.mockResolvedValue({ data: { user: { email: "bob@example.com" } } });
    maybeSingle.mockResolvedValue({ data: null, error: { message: "connection refused" } });
    const res = await middleware(makeRequest("/clients"));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
