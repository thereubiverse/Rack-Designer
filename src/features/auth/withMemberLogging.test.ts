import { describe, it, expect, vi, beforeEach } from "vitest";

// Same partial-mock style as withMember.test.ts: keep NOT_A_MEMBER and the real Member shape,
// replace only the lookup.
vi.mock("./members", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./members")>();
  return { ...actual, getCurrentMember: vi.fn() };
});
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn(() => ({})) }));
vi.mock("@/features/activity/repository", () => ({ writeEntry: vi.fn() }));

import { getCurrentMember, NOT_A_MEMBER, type Member } from "./members";
import { writeEntry } from "@/features/activity/repository";
import { withMember } from "./withMember";
import { NEEDS_EDITOR, NEEDS_ADMIN, LAST_ADMIN } from "./roles";

const member: Member = {
  id: "m1",
  email: "bob@example.com",
  name: "Bob",
  authUserId: "au1",
  disabledAt: null,
  avatarPath: null,
  role: "admin",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCurrentMember).mockResolvedValue(member);
  vi.mocked(writeEntry).mockResolvedValue(undefined);
});

describe("withMember — activity logging", () => {
  it("rule 1 — logs AFTER the action resolves, not before", async () => {
    const order: string[] = [];
    vi.mocked(writeEntry).mockImplementation(async () => {
      order.push("write");
    });
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => {
      order.push("action");
      return { ok: true as const };
    });

    await guarded(new FormData());

    expect(order).toEqual(["action", "write"]);
  });

  it("rule 2 (load-bearing) — a throwing writer must not fail the action; the caller still gets its real result", async () => {
    vi.mocked(writeEntry).mockRejectedValue(new Error("audit db is down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: true as const, saved: "yes" }));
    const res = await guarded(new FormData());

    expect(res).toEqual({ ok: true, saved: "yes" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("rule 3 — no member: the refusal still returns, but NO entry is written (actor_email is NOT NULL)", async () => {
    vi.mocked(getCurrentMember).mockResolvedValue(null);

    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: true as const }));
    const res = await guarded(new FormData());

    expect(res).toEqual({ ok: false, error: NOT_A_MEMBER });
    expect(writeEntry).not.toHaveBeenCalled();
  });

  it("rule 4 — the action throwing → outcome 'failed' with the thrown message", async () => {
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => {
      throw new Error("boom");
    });

    await guarded(new FormData());

    expect(writeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "failed", error: "boom" })
    );
  });

  it("rule 4 — {ok:false, error: NEEDS_EDITOR} → outcome 'refused'", async () => {
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: false as const, error: NEEDS_EDITOR }));

    await guarded(new FormData());

    expect(writeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "refused", error: NEEDS_EDITOR })
    );
  });

  it("rule 4 — {ok:false, error: NEEDS_ADMIN} → outcome 'refused'", async () => {
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: false as const, error: NEEDS_ADMIN }));

    await guarded(new FormData());

    expect(writeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "refused", error: NEEDS_ADMIN })
    );
  });

  it("rule 4 — {ok:false, error: LAST_ADMIN} → outcome 'refused', not 'failed' — a rule saying no is not a system fault", async () => {
    const guarded = withMember("member.setRole", async (_m, ..._args: unknown[]) => ({ ok: false as const, error: LAST_ADMIN }));

    await guarded(new FormData());

    expect(writeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "refused", error: LAST_ADMIN })
    );
  });

  it("rule 4 — any other {ok:false} → outcome 'failed' with its own error", async () => {
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: false as const, error: "duplicate code" }));

    await guarded(new FormData());

    expect(writeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "failed", error: "duplicate code" })
    );
  });

  it("rule 4 — anything else → outcome 'ok' with no error", async () => {
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: true as const, id: "c1" }));

    await guarded(new FormData());

    expect(writeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: "ok", error: null })
    );
  });

  it("rule 5 — opts.log === false skips the write entirely", async () => {
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: true as const }), { log: false });

    await guarded(new FormData());

    expect(writeEntry).not.toHaveBeenCalled();
  });

  it("rule 6 — FormData is converted with Object.fromEntries before redacting, dropping a File value", async () => {
    const fd = new FormData();
    fd.set("id", "c1");
    // `code` is on client.rename's allowlist — carrying a File here proves the File is dropped
    // during conversion rather than stringified into the log.
    fd.set("code", new File(["x"], "sneaky.png"));
    fd.set("name", "Acme");

    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: true as const }));
    await guarded(fd);

    const entry = vi.mocked(writeEntry).mock.calls[0][1];
    expect(entry.details).toEqual({ name: "Acme" });
  });

  it("rule 6 — a non-FormData first argument is passed straight through to redact", async () => {
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: true as const }));
    await guarded({ code: "ACME", name: "Acme Co", secretSauce: "x" });

    const entry = vi.mocked(writeEntry).mock.calls[0][1];
    expect(entry.details).toEqual({ code: "ACME", name: "Acme Co" });
  });

  it("writes the actor's identity and the action key alongside the details", async () => {
    const guarded = withMember("client.rename", async (_m, ..._args: unknown[]) => ({ ok: true as const }));
    await guarded(new FormData());

    const entry = vi.mocked(writeEntry).mock.calls[0][1];
    expect(entry.actorEmail).toBe("bob@example.com");
    expect(entry.actorName).toBe("Bob");
    expect(entry.memberId).toBe("m1");
    expect(entry.action).toBe("client.rename");
  });

  it("the plain single-argument form (no key) still works and never attempts to log", async () => {
    const guarded = withMember(async (m) => ({ ok: true as const, who: m.email }));
    const res = await guarded();

    expect(res).toEqual({ ok: true, who: "bob@example.com" });
    expect(writeEntry).not.toHaveBeenCalled();
  });
});
