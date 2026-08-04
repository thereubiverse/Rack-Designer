import { describe, it, expect, vi, beforeEach } from "vitest";

// DB-free: the repository is mocked outright, so these tests assert which repository function the
// action reaches for — the property that matters here is that archiving never reaches a delete.
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: vi.fn(() => ({})) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./repository", () => ({
  archiveClient: vi.fn(),
  restoreClient: vi.fn(),
  archiveSite: vi.fn(),
  restoreSite: vi.fn(),
  deleteClient: vi.fn(),
  deleteSite: vi.fn(),
}));
vi.mock("@/features/locations/repository", () => ({
  archiveFloor: vi.fn(),
  restoreFloor: vi.fn(),
  deleteFloor: vi.fn(),
}));
vi.mock("@/features/auth/withMember", () => ({
  // The guard is tested on its own in withMember.test.ts. Here it must be transparent, or every
  // action test would be re-testing the guard instead of the action.
  withMember: (fn: (...a: unknown[]) => unknown) => (...args: unknown[]) =>
    fn({ id: "m1", email: "test@example.com", name: "Test", authUserId: "au1", disabledAt: null }, ...args),
}));

import { revalidatePath } from "next/cache";
import { archiveClient, restoreClient, archiveSite, restoreSite, deleteClient, deleteSite } from "./repository";
import { archiveFloor, restoreFloor, deleteFloor } from "@/features/locations/repository";
import {
  archiveClientAction,
  restoreClientAction,
  archiveSiteAction,
  restoreSiteAction,
  archiveFloorAction,
  restoreFloorAction,
} from "./actions";

const fd = (id: string) => {
  const f = new FormData();
  f.set("id", id);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("archive actions", () => {
  it("archives a client and NEVER deletes it", async () => {
    await expect(archiveClientAction(fd("c1"))).resolves.toEqual({ ok: true });
    expect(archiveClient).toHaveBeenCalledWith(expect.anything(), "c1");
    // The assertion this slice exists for.
    expect(deleteClient).not.toHaveBeenCalled();
  });

  it("archives a site and a floor without deleting either", async () => {
    await archiveSiteAction(fd("s1"));
    await archiveFloorAction(fd("f1"));
    expect(archiveSite).toHaveBeenCalledWith(expect.anything(), "s1");
    expect(archiveFloor).toHaveBeenCalledWith(expect.anything(), "f1");
    expect(deleteSite).not.toHaveBeenCalled();
    expect(deleteFloor).not.toHaveBeenCalled();
  });

  it("restores each level", async () => {
    await restoreClientAction(fd("c1"));
    await restoreSiteAction(fd("s1"));
    await restoreFloorAction(fd("f1"));
    expect(restoreClient).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(restoreSite).toHaveBeenCalledWith(expect.anything(), "s1");
    expect(restoreFloor).toHaveBeenCalledWith(expect.anything(), "f1");
  });

  it("revalidates BOTH the directory and the archive page", async () => {
    // Archiving changes what each page shows; refreshing only one leaves the other stale.
    await archiveClientAction(fd("c1"));
    expect(revalidatePath).toHaveBeenCalledWith("/clients");
    expect(revalidatePath).toHaveBeenCalledWith("/settings/archive");
  });

  it("resolves {ok:false} when the repository throws — never rejects", async () => {
    vi.mocked(archiveClient).mockRejectedValueOnce(new Error("db down"));
    const res = await archiveClientAction(fd("c1"));
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
