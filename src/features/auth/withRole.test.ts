import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Role } from "./roles";

vi.mock("./members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./members")>();
  return { ...actual, getCurrentMember: vi.fn() };
});

import { getCurrentMember, type Member } from "./members";
import { withEditor, withAdmin } from "./withMember";
import { NEEDS_EDITOR, NEEDS_ADMIN } from "./roles";

const member = (role: Role): Member => ({
  id: "m1", email: "bob@example.com", name: "Bob",
  authUserId: "au1", disabledAt: null, avatarPath: null, role,
  orgId: "00000000-0000-0000-0000-000000000001",
});

beforeEach(() => { vi.clearAllMocks(); });

describe("withEditor", () => {
  it("NEVER calls the action for a viewer — refusing after the write would be no guard at all", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("viewer"));
    const inner = vi.fn(async () => ({ ok: true as const }));
    const res = await withEditor("test.action", inner, { log: false })();
    expect(inner).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: NEEDS_EDITOR });
  });

  it("runs for an editor, and hands them to the action", async () => {
    const m = member("editor");
    vi.mocked(getCurrentMember).mockResolvedValue(m);
    const inner = vi.fn(async (who: Member) => ({ ok: true as const, who }));
    const res = await withEditor("test.action", inner, { log: false })();
    expect(inner).toHaveBeenCalledWith(m);
    expect(res).toEqual({ ok: true, who: m });
  });

  it("runs for an admin, because a requirement is a minimum", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("admin"));
    const inner = vi.fn(async () => ({ ok: true as const }));
    await withEditor("test.action", inner, { log: false })();
    expect(inner).toHaveBeenCalled();
  });
});

describe("withAdmin", () => {
  it("NEVER calls the action for an editor", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("editor"));
    const inner = vi.fn(async () => ({ ok: true as const }));
    const res = await withAdmin("test.action", inner, { log: false })();
    expect(inner).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: NEEDS_ADMIN });
  });

  it("runs for an admin", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("admin"));
    const inner = vi.fn(async () => ({ ok: true as const }));
    await withAdmin("test.action", inner, { log: false })();
    expect(inner).toHaveBeenCalled();
  });
});

describe("both guards", () => {
  it("still refuse when there is no member at all, before any role is considered", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(null);
    const inner = vi.fn(async () => ({ ok: true as const }));
    expect((await withEditor("test.action", inner, { log: false })()).ok).toBe(false);
    expect((await withAdmin("test.action", inner, { log: false })()).ok).toBe(false);
    expect(inner).not.toHaveBeenCalled();
  });

  it("passes the original arguments through untouched", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member("admin"));
    const inner = vi.fn(async (_m: Member, a: string, b: number) => ({ ok: true as const, a, b }));
    const res = await withAdmin("test.action", inner, { log: false })("x", 2);
    expect(res).toEqual({ ok: true, a: "x", b: 2 });
  });
});
