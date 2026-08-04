import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./members")>();
  return { ...actual, getCurrentMember: vi.fn() };
});

import { getCurrentMember } from "./members";
import { withMember } from "./withMember";
import { NOT_A_MEMBER, type Member } from "./members";

const member: Member = {
  id: "m1",
  email: "bob@example.com",
  name: "Bob",
  authUserId: "au1",
  disabledAt: null,
  avatarPath: null,
  role: "admin",
};

beforeEach(() => vi.clearAllMocks());

describe("withMember", () => {
  it("NEVER calls the action when there is no member", async () => {
    // The load-bearing assertion of the whole slice: a guarded action must not run at all, not
    // merely have its result discarded.
    vi.mocked(getCurrentMember).mockResolvedValue(null);
    const inner = vi.fn(async () => ({ ok: true as const }));
    const guarded = withMember(inner);

    const res = await guarded();

    expect(inner).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: NOT_A_MEMBER });
  });

  it("runs the action and hands it the member", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    const inner = vi.fn(async (m: Member) => ({ ok: true as const, who: m.email }));
    const guarded = withMember(inner);

    expect(await guarded()).toEqual({ ok: true, who: "bob@example.com" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner.mock.calls[0][0]).toEqual(member);
  });

  it("passes the original arguments through untouched", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    const fd = new FormData();
    fd.set("id", "abc");
    const inner = vi.fn(async (_m: Member, form: FormData) => ({ ok: true as const, id: form.get("id") }));
    const guarded = withMember(inner);

    expect(await guarded(fd)).toEqual({ ok: true, id: "abc" });
  });

  it("resolves rather than rejecting when the action throws", async () => {
    // Server actions in this codebase always RESOLVE {ok:false}; a rejection surfaces as an
    // unhandled error in the client component instead of an error message.
    vi.mocked(getCurrentMember).mockResolvedValue(member);
    const guarded = withMember(async () => {
      throw new Error("boom");
    });

    const res = await guarded();
    expect(res).toEqual(expect.objectContaining({ ok: false }));
  });

  it("resolves {ok:false} when the membership lookup itself throws", async () => {
    // A database hiccup during the check must refuse, never fall open.
    vi.mocked(getCurrentMember).mockRejectedValue(new Error("db down"));
    const inner = vi.fn(async () => ({ ok: true as const }));

    const res = await withMember(inner)();

    expect(inner).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ ok: false }));
  });
});
