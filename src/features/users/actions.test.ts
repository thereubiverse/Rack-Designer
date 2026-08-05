import { describe, it, expect, vi, beforeEach } from "vitest";

const ME = {
  id: "me", email: "me@example.com", name: "Me",
  authUserId: "au-me", disabledAt: null, avatarPath: null, role: "admin" as const,
};

// withAdmin is replaced by a transparent wrapper injecting OUR member. The guard itself is tested in
// withRole.test.ts; here we test what the actions DO with the member they are handed.
vi.mock("@/features/auth/withMember", () => ({
  withMember: (_key: string, fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
  withAdmin: (_key: string, fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
  withEditor: (_key: string, fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
}));
const db = {};
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const inviteUserByEmail = vi.fn();
vi.mock("@/features/users/invite", () => ({ inviteUserByEmail: (...a: unknown[]) => inviteUserByEmail(...a) }));

vi.mock("./repository", () => ({
  listMembers: vi.fn(),
  listRolesForInvariant: vi.fn(),
  insertMember: vi.fn(),
  updateMemberRole: vi.fn(),
  setMemberDisabled: vi.fn(),
  findMemberById: vi.fn(),
}));

import {
  listRolesForInvariant, insertMember, updateMemberRole, setMemberDisabled, findMemberById,
} from "./repository";
import { inviteMemberAction, setMemberRoleAction, setMemberActiveAction } from "./actions";
import { LAST_ADMIN } from "@/features/auth/roles";

function form(e: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(e)) fd.set(k, v);
  return fd;
}

const other = {
  id: "other", email: "other@example.com", name: "Other", role: "editor" as const,
  disabledAt: null, authUserId: "au-o", invitedAt: "2026-01-01", lastSignInAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(findMemberById).mockResolvedValue(other);
  vi.mocked(listRolesForInvariant).mockResolvedValue([
    { role: "admin", disabledAt: null }, { role: "editor", disabledAt: null },
  ]);
  inviteUserByEmail.mockResolvedValue({ sent: true });
});

describe("inviteMemberAction", () => {
  it("stores the email normalised, so a capitalised invite still matches at sign-in", async () => {
    const res = await inviteMemberAction(form({ email: "  New.Person@Example.COM ", name: "New", role: "editor" }));
    expect(res.ok).toBe(true);
    expect(insertMember).toHaveBeenCalledWith(db, "new.person@example.com", "New", "editor");
  });

  it("refuses a role that is not one of the three", async () => {
    const res = await inviteMemberAction(form({ email: "a@b.co", name: "A", role: "superuser" }));
    expect(res.ok).toBe(false);
    expect(insertMember).not.toHaveBeenCalled();
  });

  it("refuses a blank email", async () => {
    const res = await inviteMemberAction(form({ email: "  ", name: "A", role: "viewer" }));
    expect(res.ok).toBe(false);
    expect(insertMember).not.toHaveBeenCalled();
  });

  it("still counts as invited when the email cannot be sent, and says so", async () => {
    // The row is what grants access; the email is only a convenience. Failing the whole invite
    // because SMTP is unconfigured would make the screen useless until it is.
    inviteUserByEmail.mockResolvedValue({ sent: false, reason: "SMTP not configured" });
    const res = await inviteMemberAction(form({ email: "a@b.co", name: "A", role: "viewer" }));
    expect(res.ok).toBe(true);
    expect(insertMember).toHaveBeenCalled();
    expect(res.warning).toMatch(/email/i);
  });
});

describe("setMemberRoleAction", () => {
  it("changes someone else's role", async () => {
    const res = await setMemberRoleAction(form({ id: "other", role: "admin" }));
    expect(res.ok).toBe(true);
    expect(updateMemberRole).toHaveBeenCalledWith(db, "other", "admin");
  });

  it("refuses to change YOUR OWN role", async () => {
    const res = await setMemberRoleAction(form({ id: ME.id, role: "viewer" }));
    expect(res.ok).toBe(false);
    expect(updateMemberRole).not.toHaveBeenCalled();
  });

  it("refuses to demote the last active admin", async () => {
    vi.mocked(findMemberById).mockResolvedValue({ ...other, role: "admin" });
    vi.mocked(listRolesForInvariant).mockResolvedValue([
      { role: "admin", disabledAt: null }, { role: "editor", disabledAt: null },
    ]);
    const res = await setMemberRoleAction(form({ id: "other", role: "editor" }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(LAST_ADMIN);
    expect(updateMemberRole).not.toHaveBeenCalled();
  });

  it("checks the invariant against the DATABASE, not against what the screen showed", async () => {
    await setMemberRoleAction(form({ id: "other", role: "viewer" }));
    expect(listRolesForInvariant).toHaveBeenCalled();
  });
});

describe("setMemberActiveAction", () => {
  it("revokes someone else", async () => {
    const res = await setMemberActiveAction(form({ id: "other", active: "false" }));
    expect(res.ok).toBe(true);
    expect(setMemberDisabled).toHaveBeenCalledWith(db, "other", true);
  });

  it("refuses to revoke YOURSELF — the next request would sign you out of an app you cannot re-enter", async () => {
    const res = await setMemberActiveAction(form({ id: ME.id, active: "false" }));
    expect(res.ok).toBe(false);
    expect(setMemberDisabled).not.toHaveBeenCalled();
  });

  it("refuses to revoke the last active admin", async () => {
    vi.mocked(findMemberById).mockResolvedValue({ ...other, role: "admin" });
    const res = await setMemberActiveAction(form({ id: "other", active: "false" }));
    expect(res.ok).toBe(false);
    expect(res.error).toBe(LAST_ADMIN);
    expect(setMemberDisabled).not.toHaveBeenCalled();
  });

  it("does NOT revoke when the active field is missing — the destructive branch must not be the default", () => {
    return setMemberActiveAction(form({ id: "other" })).then((res) => {
      expect(res.ok).toBe(true);
      expect(setMemberDisabled).toHaveBeenCalledWith(db, "other", false);
    });
  });

  it("restoring is never blocked by the invariant — it can only ADD an admin", async () => {
    vi.mocked(findMemberById).mockResolvedValue({ ...other, role: "admin", disabledAt: "2026-01-01" });
    const res = await setMemberActiveAction(form({ id: "other", active: "true" }));
    expect(res.ok).toBe(true);
    expect(setMemberDisabled).toHaveBeenCalledWith(db, "other", false);
  });
});
