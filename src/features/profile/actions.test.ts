import { describe, it, expect, vi, beforeEach } from "vitest";

const ME = {
  id: "member-me", email: "me@example.com", name: "Me", authUserId: "au-1", disabledAt: null,
  orgId: "00000000-0000-0000-0000-000000000001",
};

// withMember is replaced by a transparent wrapper that injects OUR member — the guard itself is
// tested in withMember.test.ts; here we are testing what the actions do with the member they get.
vi.mock("@/features/auth/withMember", () => ({
  withMember: (_key: string, fn: (m: typeof ME, ...a: never[]) => unknown) => (...a: never[]) => fn(ME, ...a),
}));

// members-table operations go through the tenant client; storage and phone_verifications (neither
// granted to app_tenant — see serviceRoleAllowlist.test.ts) keep the narrow service client. Both
// point at the SAME fake db — these tests only assert what repository functions were called with,
// not which client minted the connection.
const serviceClient = { auth: {} };
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => serviceClient }));
vi.mock("@/lib/supabase/tenant", () => ({ createTenantClient: () => serviceClient }));

const signInWithPassword = vi.fn();
const updateUser = vi.fn();
vi.mock("@/lib/supabase/auth", () => ({
  createSessionClient: async () => ({ auth: { signInWithPassword, updateUser } }),
}));

vi.mock("./repository", () => ({
  readProfile: vi.fn(),
  writeProfile: vi.fn(),
  writeAvatarPath: vi.fn(),
}));
vi.mock("./avatarStorage", () => ({
  avatarPathFor: (id: string) => `${id}/avatar`,
  uploadAvatarObject: vi.fn(),
  removeAvatarObject: vi.fn(),
  createAvatarSignedUrl: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { writeProfile, writeAvatarPath, readProfile } from "./repository";
import { uploadAvatarObject, removeAvatarObject } from "./avatarStorage";
import {
  updateProfileAction, uploadAvatarAction, removeAvatarAction, changePasswordAction,
} from "./actions";

beforeEach(() => { vi.clearAllMocks(); });

function form(entries: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("updateProfileAction", () => {
  it("saves the trimmed fields against the signed-in member", async () => {
    const res = await updateProfileAction(form({ name: "  Reuben  ", position: "Foreman" }));
    expect(res.ok).toBe(true);
    expect(writeProfile).toHaveBeenCalledWith(
      serviceClient, ME.id,
      { name: "Reuben", phone: "", position: "Foreman", address: "" }
    );
  });

  it("IGNORES an id supplied in the form — otherwise this is an account-takeover endpoint", async () => {
    await updateProfileAction(form({ id: "member-someone-else", name: "Mallory" }));
    expect(writeProfile).toHaveBeenCalledWith(serviceClient, ME.id, expect.anything());
  });
});

describe("uploadAvatarAction", () => {
  it("rejects a file over the cap without touching storage", async () => {
    const big = new File([new Uint8Array(3 * 1024 * 1024)], "a.png", { type: "image/png" });
    const res = await uploadAvatarAction(form({ file: big }));
    expect(res.ok).toBe(false);
    expect(uploadAvatarObject).not.toHaveBeenCalled();
    expect(writeAvatarPath).not.toHaveBeenCalled();
  });

  it("rejects a non-image without touching storage", async () => {
    const txt = new File(["hello"], "a.txt", { type: "text/plain" });
    const res = await uploadAvatarAction(form({ file: txt }));
    expect(res.ok).toBe(false);
    expect(uploadAvatarObject).not.toHaveBeenCalled();
  });

  it("uploads the object BEFORE recording the path, so a failed upload leaves no dangling row", async () => {
    const order: string[] = [];
    vi.mocked(uploadAvatarObject).mockImplementation(async () => { order.push("object"); });
    vi.mocked(writeAvatarPath).mockImplementation(async () => { order.push("row"); });
    const png = new File([new Uint8Array(16)], "a.png", { type: "image/png" });
    const res = await uploadAvatarAction(form({ file: png }));
    expect(res.ok).toBe(true);
    expect(order).toEqual(["object", "row"]);
  });
});

describe("removeAvatarAction", () => {
  it("deletes the object BEFORE clearing the column, so a failure is retryable", async () => {
    vi.mocked(readProfile).mockResolvedValue({
      id: ME.id, email: ME.email, name: "Me", phone: "", position: "", address: "",
      avatarPath: `${ME.id}/avatar`,
      phoneVerifiedAt: null,
    });
    const order: string[] = [];
    vi.mocked(removeAvatarObject).mockImplementation(async () => { order.push("object"); });
    vi.mocked(writeAvatarPath).mockImplementation(async () => { order.push("row"); });
    const res = await removeAvatarAction(form({}));
    expect(res.ok).toBe(true);
    expect(order).toEqual(["object", "row"]);
    expect(writeAvatarPath).toHaveBeenCalledWith(serviceClient, ME.id, null);
  });

  it("succeeds when there is no picture, rather than erroring", async () => {
    vi.mocked(readProfile).mockResolvedValue({
      id: ME.id, email: ME.email, name: "Me", phone: "", position: "", address: "", avatarPath: null,
      phoneVerifiedAt: null,
    });
    const res = await removeAvatarAction(form({}));
    expect(res.ok).toBe(true);
    expect(removeAvatarObject).not.toHaveBeenCalled();
  });
});

describe("changePasswordAction", () => {
  const good = { current: "oldpass", next: "newpass", confirm: "newpass" };

  it("does NOT call updateUser when the current password is wrong", async () => {
    signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });
    const res = await changePasswordAction(form(good));
    expect(res.ok).toBe(false);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("changes the password once the current one is proven", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    updateUser.mockResolvedValue({ error: null });
    const res = await changePasswordAction(form(good));
    expect(res.ok).toBe(true);
    expect(signInWithPassword).toHaveBeenCalledWith({ email: ME.email, password: "oldpass" });
    expect(updateUser).toHaveBeenCalledWith({ password: "newpass" });
  });

  it("rejects a mismatched confirmation before any network call", async () => {
    const res = await changePasswordAction(form({ ...good, confirm: "different" }));
    expect(res.ok).toBe(false);
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("surfaces a failure from updateUser rather than reporting success", async () => {
    signInWithPassword.mockResolvedValue({ error: null });
    updateUser.mockResolvedValue({ error: { message: "nope" } });
    const res = await changePasswordAction(form(good));
    expect(res.ok).toBe(false);
  });
});
